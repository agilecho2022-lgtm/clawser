import {
  buildRelayWsUrl,
  isLastRemainingTab,
  isMissingTabError,
  isRetryableReconnectError,
  reconnectDelayMs,
} from './background-utils.js'
import { recordWorkerStart } from './diagnostic-worker.js'

const workerStartedAt = Date.now()
let workerDiagnostic = { startedAt: workerStartedAt, startSequence: null }
void recordWorkerStart(chrome, workerStartedAt).then(worker => {
  workerDiagnostic = worker
  try { sendToRelay({ method: 'workerDiagnostic', params: { worker } }) } catch {}
})

const DEFAULT_PORT = 18792

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
/** @type {string|null} */
let relayConnectRequestId = null

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

// Diagnostic history only; never used to select targets or decide outcomes.
const tabDiagnosticEvents = []
let businessTabProtectionUrls = []
let businessTabProtectionRecords = {}
let protectionQueue = Promise.resolve()
const tabGenerations = new Map()
const attachFlights = new Map()
const ownedCreates = new Map()

function tabGeneration(tabId) { return tabGenerations.get(tabId) || 0 }
function assertTabGeneration(tabId, generation) {
  if (tabGeneration(tabId) !== generation) throw new Error('BROWSER_TAB_MISSING: target attachment changed')
}
function protectionOperation(operation) {
  const result = protectionQueue.then(operation)
  protectionQueue = result.catch(() => {})
  return result
}
async function saveProtectionRecords() {
  await chrome.storage.local.set({ businessTabProtectionRecords })
}
async function protectionIdentityMatches(record, tab) {
  if (!record.targetId || record.windowId !== tab.windowId) return false
  const matches = (await chrome.debugger.getTargets()).filter(target => target.tabId === tab.id && target.id === record.targetId)
  return matches.length === 1
}
async function releaseProtection(tabId, restore = true) {
  return protectionOperation(async () => {
    const record = businessTabProtectionRecords[tabId]
    if (!record) return
    delete businessTabProtectionRecords[tabId]
    await saveProtectionRecords()
    if (!restore) return
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (tab && !tab.discarded && tab.autoDiscardable === false && await protectionIdentityMatches(record, tab)) {
      await chrome.tabs.update(tabId, { autoDiscardable: record.originalAutoDiscardable })
    }
  })
}
async function protectBusinessTab(tabId, targetId, generation) {
  return protectionOperation(async () => {
    assertTabGeneration(tabId, generation)
    const tab = await chrome.tabs.get(tabId)
    assertTabGeneration(tabId, generation)
    if (tab.discarded) throw new Error('BROWSER_TAB_MISSING: discarded tab')
    if (!isBusinessTabUrl(tab.url) || tab.autoDiscardable !== true) return
    // Persist ownership before changing the flag so a worker restart can restore it.
    businessTabProtectionRecords[tabId] = { tabId, targetId, windowId: tab.windowId,
      url: tab.url, originalAutoDiscardable: tab.autoDiscardable }
    await saveProtectionRecords()
    assertTabGeneration(tabId, generation)
    await chrome.tabs.update(tabId, { autoDiscardable: false })
    assertTabGeneration(tabId, generation)
  })
}
function retireTabIdentity(tabId, reason) {
  tabGenerations.set(tabId, tabGeneration(tabId) + 1)
  reattachPending.delete(tabId)
  const tab = tabs.get(tabId)
  tabs.delete(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  for (const [sessionId, parent] of childSessionToTab) {
    if (parent === tabId) childSessionToTab.delete(sessionId)
  }
  if (tab?.sessionId) {
    try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget',
      params: { sessionId: tab.sessionId, targetId: tab.targetId, reason } } }) } catch {}
  }
  return tab
}

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

// Per-tab operation locks prevent double-attach races.
/** @type {Set<number>} */
const tabOperationLocks = new Set()

// Tabs currently in a detach/re-attach cycle after navigation.
/** @type {Set<number>} */
const reattachPending = new Set()

// Reconnect state for exponential backoff.
let reconnectAttempt = 0
let reconnectTimer = null

const TAB_VALIDATION_ATTEMPTS = 2
const TAB_VALIDATION_RETRY_DELAY_MS = 1000

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isBusinessTabUrl(url) {
  try {
    const current = new URL(url)
    return businessTabProtectionUrls.some(value => {
      try {
        const configured = new URL(value)
        const prefix = configured.pathname.replace(/\/$/, '')
        return current.origin === configured.origin && (!prefix || current.pathname === prefix || current.pathname.startsWith(prefix + '/'))
      } catch { return false }
    })
  } catch { return false }
}

function recordTabDiagnostic(event, nativeTab, identity = {}, options = {}) {
  const eventAt = new Date().toISOString()
  const tabId = nativeTab.id
  const attachment = tabs.get(tabId)
  const fields = (tab) => ({ tabId: tab.id, url: options.originOnly
    ? (() => { try { return new URL(tab.url).origin } catch { return null } })() : tab.url ?? null,
    discarded: tab.discarded ?? null, frozen: tab.frozen ?? null,
    ...(!options.originOnly ? { status: tab.status ?? null } : {}), autoDiscardable: tab.autoDiscardable ?? null,
    active: tab.active ?? null, windowId: tab.windowId ?? null })
  const base = { event, eventAt, identitySource: 'attachment_projection', targetId: attachment?.targetId ?? null,
    sessionId: attachment?.sessionId ?? null, worker: { ...workerDiagnostic }, ...identity }
  const emit = (entry) => {
    tabDiagnosticEvents.push(entry)
    if (tabDiagnosticEvents.length > 100) tabDiagnosticEvents.shift()
    try { sendToRelay({ method: 'tabDiagnostic', params: entry }) } catch {}
  }
  // Copy the Chrome event payload before any await: replacement/renderer exit
  // can make a later query unavailable or give a different state.
  emit({ ...base, ...fields(nativeTab), stage: 'event', observedAt: eventAt,
    state: null, focused: null })
  let timer
  const collect = async () => {
    const tab = nativeTab.windowId == null ? await chrome.tabs.get(tabId) : nativeTab
    const window = await chrome.windows.get(tab.windowId)
    return { ...fields(tab), state: window.state ?? null, focused: window.focused ?? null }
  }
  return Promise.race([collect(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('event snapshot timeout')), 2000)
  })]).then(observation => {
    emit({ ...base, ...observation, stage: 'observation', observedAt: new Date().toISOString() })
  }).catch(error => {
    emit({ ...base, tabId, stage: 'observation', observedAt: new Date().toISOString(),
      observationError: String(error?.message || error) })
  }).finally(() => clearTimeout(timer))
}

async function validateAttachedTab(tabId, expectedTargetId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.discarded) return false
    if (expectedTargetId) {
      const matches = (await chrome.debugger.getTargets()).filter(target => target.tabId === tabId && target.id === expectedTargetId)
      if (matches.length !== 1 || matches[0].attached !== true) return false
    }
  } catch {
    return false
  }

  for (let attempt = 0; attempt < TAB_VALIDATION_ATTEMPTS; attempt++) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
      })
      return true
    } catch (err) {
      if (isMissingTabError(err)) {
        return false
      }
      if (attempt < TAB_VALIDATION_ATTEMPTS - 1) {
        await sleep(TAB_VALIDATION_RETRY_DELAY_MS)
      }
    }
  }

  return false
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const raw = stored.relayPort
  const n = Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

// Persist attached tab state to survive MV3 service worker restarts.
async function persistState() {
  try {
    const tabEntries = []
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
        tabEntries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId, attachOrder: tab.attachOrder })
      }
    }
    await chrome.storage.session.set({
      persistedTabs: tabEntries,
      nextSession,
    })
  } catch {
    // chrome.storage.session may not be available in all contexts.
  }
}

// Rehydrate tab state on service worker startup. Fast path — just restores
// maps and badges. Relay reconnect happens separately in background.
async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(['persistedTabs', 'nextSession'])
    if (stored.nextSession) {
      nextSession = Math.max(nextSession, stored.nextSession)
    }
    const entries = stored.persistedTabs || []
    // Phase 1: optimistically restore state and badges.
    for (const entry of entries) {
      tabs.set(entry.tabId, {
        state: 'connected',
        sessionId: entry.sessionId,
        targetId: entry.targetId,
        attachOrder: entry.attachOrder,
      })
      tabBySession.set(entry.sessionId, entry.tabId)
      setBadge(entry.tabId, 'on')
    }
    // Retry once so transient busy/navigation states do not permanently drop
    // a still-attached tab after a service worker restart.
    for (const entry of entries) {
      const valid = await validateAttachedTab(entry.tabId, entry.targetId)
      if (!valid) {
        tabs.delete(entry.tabId)
        tabBySession.delete(entry.sessionId)
        setBadge(entry.tabId, 'off')
      }
    }
  } catch {
    // Ignore rehydration errors.
  }
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = buildRelayWsUrl(port)

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws
    // Bind message handler before open so an immediate first frame (for example
    // gateway connect.challenge) cannot be missed.
    ws.onmessage = (event) => {
      if (ws !== relayWs) return
      void whenReady(() => onRelayMessage(String(event.data || ''), ws))
    }

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    // Bind permanent handlers. Guard against stale socket: if this WS was
    // replaced before its close fires, the handler is a no-op.
    ws.onclose = () => {
      if (ws !== relayWs) return
      onRelayClosed('closed')
    }
    ws.onerror = () => {
      if (ws !== relayWs) return
      onRelayClosed('error')
    }
  })()

  try {
    await relayConnectPromise
    reconnectAttempt = 0
  } finally {
    relayConnectPromise = null
  }
}

// Relay closed — update badges, reject pending requests, auto-reconnect.
// Debugger sessions are kept alive so they survive transient WS drops.
function onRelayClosed(reason) {
  relayWs = null
  relayConnectRequestId = null

  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  reattachPending.clear()

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'Clawser Browser Relay: relay reconnecting…',
      })
    }
  }

  scheduleReconnect()
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const delay = reconnectDelayMs(reconnectAttempt)
  reconnectAttempt++

  console.log(`Scheduling reconnect attempt ${reconnectAttempt} in ${Math.round(delay)}ms`)

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    try {
      await ensureRelayConnection()
      reconnectAttempt = 0
      console.log('Reconnected successfully')
      await reannounceAttachedTabs()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`Reconnect attempt ${reconnectAttempt} failed: ${message}`)
      if (!isRetryableReconnectError(err)) {
        return
      }
      scheduleReconnect()
    }
  }, delay)
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0
}

// Re-announce all attached tabs to the relay after reconnect.
async function reannounceAttachedTabs() {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected' || !tab.sessionId || !tab.targetId) continue

    // Retry once here as well; reconnect races can briefly make an otherwise
    // healthy tab look unavailable.
    const generation = tabGeneration(tabId)
    const valid = await validateAttachedTab(tabId, tab.targetId)
    if (tabGeneration(tabId) !== generation || tabs.get(tabId) !== tab) continue
    if (!valid) {
      await detachTab(tabId, 'target_unavailable')
      setBadge(tabId, 'off')
      void chrome.action.setTitle({
        tabId,
        title: 'Clawser Browser Relay (click to attach/detach)',
      })
      continue
    }

    // Send fresh attach event to relay.
    // Split into two try-catch blocks so debugger failures and relay send
    // failures are handled independently. Previously, a relay send failure
    // would fall into the outer catch and set the badge to 'on' even though
    // the relay had no record of the tab — causing every subsequent browser
    // tool call to fail with "no tab connected" until the next reconnect cycle.
    let targetInfo
    try {
      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      )
      targetInfo = info?.targetInfo
    } catch {
      // Target.getTargetInfo failed. Preserve at least targetId from
      // cached tab state so relay receives a stable identifier.
      targetInfo = tab.targetId ? { targetId: tab.targetId } : undefined
    }

    if (tabGeneration(tabId) !== generation || tabs.get(tabId) !== tab) continue
    const [current, targets] = await Promise.all([
      chrome.tabs.get(tabId).catch(() => null), chrome.debugger.getTargets().catch(() => []),
    ])
    if (tabGeneration(tabId) !== generation || tabs.get(tabId) !== tab) continue
    const matches = targets.filter(target => target.tabId === tabId && target.id === tab.targetId)
    if (!current || current.discarded || matches.length !== 1 || matches[0].attached !== true) {
      await detachTab(tabId, 'target_unavailable')
      continue
    }

    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: tab.sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })

      setBadge(tabId, 'on')
      void chrome.action.setTitle({
        tabId,
        title: 'Clawser Browser Relay: attached (click to detach)',
      })
    } catch {
      // Relay send failed (e.g. WS closed in the gap between ensureRelayConnection
      // resolving and this loop executing). The tab is still valid — leave badge
      // as 'connecting' so the reconnect/keepalive cycle will retry rather than
      // showing a false-positive 'on' that hides the broken state from the user.
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'Clawser Browser Relay: relay reconnecting…',
      })
    }
  }

  await persistState()
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

function ensureGatewayHandshakeStarted(payload, worker) {
  if (relayConnectRequestId) return
  const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : ''
  relayConnectRequestId = `ext-connect-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  sendToRelay({
    type: 'req',
    id: relayConnectRequestId,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'chrome-relay-extension',
        version: '1.0.0',
        platform: 'chrome-extension',
        mode: 'webchat',
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [],
      commands: [],
      worker,
      nonce: nonce || undefined,
    },
  })
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Relay request timeout (30s)'))
    }, 30000)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    try {
      sendToRelay(command)
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function onRelayMessage(text, socket = relayWs) {
  if (socket !== relayWs) return
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.type === 'event' && msg.event === 'connect.challenge') {
    try {
      ensureGatewayHandshakeStarted(msg.payload, workerDiagnostic)
    } catch (err) {
      console.warn('gateway connect handshake start failed', err instanceof Error ? err.message : String(err))
      relayConnectRequestId = null
      const ws = relayWs
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, 'gateway connect failed')
      }
    }
    return
  }

  if (msg && msg.type === 'res' && relayConnectRequestId && msg.id === relayConnectRequestId) {
    relayConnectRequestId = null
    if (!msg.ok) {
      const detail = msg?.error?.message || msg?.error || 'gateway connect failed'
      console.warn('gateway connect handshake rejected', String(detail))
      const ws = relayWs
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, 'gateway connect failed')
      }
    }
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg, socket)
      if (socket === relayWs) sendToRelay({ id: msg.id, result })
    } catch (err) {
      if (socket === relayWs) sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

function isAttachableTabUrl(url) {
  return typeof url === 'string' && (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('file://')
  )
}

function tabMatchesUrlContains(tab, urlContains) {
  const needle = String(urlContains || '').trim().toLowerCase()
  if (!needle) return false
  return String(tab?.url || '').toLowerCase().includes(needle)
}

async function attachTabForRelay(tab) {
  if (!tab?.id) return null
  tab = await chrome.tabs.get(tab.id)
  if (tab.discarded) throw new Error('BROWSER_TAB_MISSING: discarded tab')
  const existing = tabs.get(tab.id)
  if (existing?.state === 'connected' && existing.targetId) {
    await protectBusinessTab(tab.id, existing.targetId, tabGeneration(tab.id))
    setBadge(tab.id, 'on')
    return {
      targetId: existing.targetId,
      title: tab.title || '',
      url: tab.url || '',
      type: 'page',
    }
  }

  const attached = await attachTab(tab.id)
  return {
    targetId: attached.targetId,
    title: tab.title || '',
    url: tab.url || '',
    type: 'page',
  }
}

async function attachTab(tabId, opts = {}) {
  if (attachFlights.has(tabId)) return attachFlights.get(tabId)
  const generation = tabGeneration(tabId)
  const operation = (async () => {
    let acquired = false
    try {
      const tab = await chrome.tabs.get(tabId)
      assertTabGeneration(tabId, generation)
      if (tab.discarded) throw new Error('BROWSER_TAB_MISSING: discarded tab')
      const existing = tabs.get(tabId)
      if (existing?.state === 'connected') return existing
      const debuggee = { tabId }
      await chrome.debugger.attach(debuggee, '1.3')
      acquired = true
      assertTabGeneration(tabId, generation)
      await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})
      const info = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo')
      assertTabGeneration(tabId, generation)
      const current = await chrome.tabs.get(tabId)
      if (current.discarded) throw new Error('BROWSER_TAB_MISSING: discarded tab')
      const targetInfo = info?.targetInfo
      const targetId = String(targetInfo?.targetId || '').trim()
      if (!targetId) throw new Error('Target.getTargetInfo returned no targetId')
      if (opts.expectedRelay && opts.expectedRelay !== relayWs) throw new Error('Relay disconnected while attaching created tab')
      await protectBusinessTab(tabId, targetId, generation)
      assertTabGeneration(tabId, generation)
      if (opts.expectedRelay && opts.expectedRelay !== relayWs) throw new Error('Relay disconnected while attaching created tab')
      const sid = nextSession++
      const sessionId = `cb-tab-${sid}`
      tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder: sid })
      tabBySession.set(sessionId, tabId)
      if (!opts.skipAttachedEvent) sendToRelay({ method: 'forwardCDPEvent', params: {
        method: 'Target.attachedToTarget', params: { sessionId,
          targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false } } })
      setBadge(tabId, 'on')
      void chrome.action.setTitle({ tabId, title: 'Clawser Browser Relay: attached (click to detach)' })
      await persistState()
      return { sessionId, targetId }
    } catch (error) {
      // This flight owns only the debugger it successfully acquired, never the user tab.
      if (acquired) {
        const own = tabs.get(tabId)
        if (own) retireTabIdentity(tabId, 'attach_failed')
        await releaseProtection(tabId).catch(err => console.warn('protection rollback failed', tabId, String(err)))
        await chrome.debugger.detach({ tabId }).catch(() => {})
      }
      throw error
    }
  })()
  attachFlights.set(tabId, operation)
  try { return await operation } finally {
    if (attachFlights.get(tabId) === operation) attachFlights.delete(tabId)
  }
}

async function detachTab(tabId, reason) {
  tabGenerations.set(tabId, tabGeneration(tabId) + 1)
  reattachPending.delete(tabId)
  await releaseProtection(tabId).catch(error => console.warn('protection restore failed', tabId, String(error)))
  const tab = tabs.get(tabId)

  // Send detach events for child sessions first.
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) {
      try {
        sendToRelay({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.detachedFromTarget',
            params: { sessionId: childSessionId, reason: 'parent_detached' },
          },
        })
      } catch {
        // Relay may be down.
      }
      childSessionToTab.delete(childSessionId)
    }
  }

  // Send detach event for main session.
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // Relay may be down.
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // May already be detached.
  }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'Clawser Browser Relay (click to attach/detach)',
  })

  await persistState()
}

async function autoAttachOpenedTab(tab) {
  const tabId = tab?.id
  const openerTabId = tab?.openerTabId
  if (!tabId || !openerTabId) return
  if (tabs.get(openerTabId)?.state !== 'connected') return
  if (tabs.has(tabId) || tabOperationLocks.has(tabId)) return

  tabOperationLocks.add(tabId)
  try {
    await ensureRelayConnection()
    const delays = [100, 250, 500, 1000, 2000]
    for (const delay of delays) {
      await sleep(delay)
      const current = await chrome.tabs.get(tabId).catch(() => null)
      if (!current?.id) return
      if (!isAttachableTabUrl(current.url)) continue
      await attachTabForRelay(current)
      await reannounceAttachedTabs()
      return
    }
  } catch (err) {
    console.warn('auto attach opened tab failed', tabId, err instanceof Error ? err.message : String(err))
  } finally {
    tabOperationLocks.delete(tabId)
  }
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  // Prevent concurrent operations on the same tab.
  if (tabOperationLocks.has(tabId)) return
  tabOperationLocks.add(tabId)

  try {
    if (reattachPending.has(tabId)) {
      reattachPending.delete(tabId)
      setBadge(tabId, 'off')
      void chrome.action.setTitle({
        tabId,
        title: 'Clawser Browser Relay (click to attach/detach)',
      })
      return
    }

    const existing = tabs.get(tabId)
    if (existing?.state === 'connected') {
      await detachTab(tabId, 'toggle')
      return
    }

    // User is manually connecting — cancel any pending reconnect.
    cancelReconnect()

    tabs.set(tabId, { state: 'connecting' })
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'Clawser Browser Relay: connecting to local relay…',
    })

    try {
      await ensureRelayConnection()
      await attachTab(tabId)
    } catch (err) {
      tabs.delete(tabId)
      setBadge(tabId, 'error')
      void chrome.action.setTitle({
        tabId,
        title: 'Clawser Browser Relay: relay not running (open options for setup)',
      })
      void maybeOpenHelpOnce()
      const message = err instanceof Error ? err.message : String(err)
      console.warn('attach failed', message, nowStack())
    }
  } finally {
    tabOperationLocks.delete(tabId)
  }
}

async function handleForwardCdpCommand(msg, expectedRelay) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    const ownership = {}
    ownedCreates.set(tab.id, ownership)
    await new Promise((r) => setTimeout(r, 100))
    try {
      const attached = await attachTab(tab.id, { expectedRelay })
      if (expectedRelay && expectedRelay !== relayWs) throw new Error('Relay disconnected while creating tab')
      return { targetId: attached.targetId }
    } catch (error) {
      // A native replacement/removal retires ownership; never close its successor.
      if (ownedCreates.get(tab.id) === ownership) {
        await chrome.tabs.remove(tab.id).catch(err => console.warn('create rollback failed', tab.id, String(err)))
      } else {
        console.warn('create rollback skipped: tab identity changed', tab.id)
      }
      throw error
    } finally {
      if (ownedCreates.get(tab.id) === ownership) ownedCreates.delete(tab.id)
    }
  }

  if (method === 'Clawser.attachActiveTab') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) throw new Error('No active tab')
    await ensureRelayConnection()
    const attached = await attachTabForRelay(tab)
    if (!attached?.targetId) throw new Error('Failed to attach active tab')
    await reannounceAttachedTabs()
    return { targetId: attached.targetId }
  }

  if (method === 'Clawser.attachTabs') {
    if (params?.businessUrls !== undefined) {
      const values = params.businessUrls
      if (!Array.isArray(values) || values.some(value => {
        if (typeof value !== 'string') return true
        try { return !['http:', 'https:'].includes(new URL(value).protocol) } catch { return true }
      })) throw new Error('businessUrls must be an array of HTTP(S) URLs')
      await chrome.storage.local.set({ businessTabProtectionUrls: values })
      businessTabProtectionUrls = values.slice()
      for (const tabId of Object.keys(businessTabProtectionRecords).map(Number)) {
        const native = await chrome.tabs.get(tabId).catch(() => null)
        if (!native || !isBusinessTabUrl(native.url)) await releaseProtection(tabId)
      }
    }
    const urlContains = typeof params?.urlContains === 'string' ? params.urlContains.trim() : ''
    const all = params?.all === true
    const candidates = (await chrome.tabs.query({}))
      .filter((tab) => tab?.id && isAttachableTabUrl(tab.url))
      .filter((tab) => all || tabMatchesUrlContains(tab, urlContains))

    if (!all && urlContains && candidates.length === 0) {
      throw new Error(`No tabs matching ${urlContains}`)
    }

    if (candidates.length && candidates.every(tab => tab.discarded)) {
      throw new Error('BROWSER_TAB_MISSING: discarded tab')
    }
    await ensureRelayConnection()
    const attachedTabs = []
    for (const tab of candidates) {
      try {
        const attached = await attachTabForRelay(tab)
        if (attached) attachedTabs.push(attached)
      } catch (err) {
        console.warn('attach tab failed', tab.id, err instanceof Error ? err.message : String(err))
      }
    }
    await reannounceAttachedTabs()
    return { tabs: attachedTabs }
  }

  if (method === 'Clawser.getWindowState') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const ownTabId = target ? getTabByTargetId(target) : null
    if (!ownTabId) throw new Error('Window observation target is not attached')
    const tab = await chrome.tabs.get(ownTabId)
    if (tab.discarded) throw new Error('BROWSER_TAB_MISSING: discarded tab')
    const attachment = tabs.get(ownTabId)
    const window = await chrome.windows.get(tab.windowId)
    const evaluated = await chrome.debugger.sendCommand({ tabId: ownTabId }, 'Runtime.evaluate', {
      expression: 'document.visibilityState', returnByValue: true, timeout: 1000,
    })
    if (tabs.get(ownTabId) !== attachment) throw new Error('BROWSER_TAB_MISSING: target attachment changed')
    if (evaluated.exceptionDetails || typeof evaluated.result?.value !== 'string') {
      throw new Error('Window observation visibilityState unavailable')
    }
    return { targetId: target, windowId: window.id, state: window.state,
      focused: window.focused, visibilityState: evaluated.result.value }
  }

  if (method === 'Clawser.diagnosticSnapshot') {
    const [allTabs, targets] = await Promise.all([chrome.tabs.query({}), chrome.debugger.getTargets()])
    const windows = new Map()
    for (const tab of allTabs) {
      if (!windows.has(tab.windowId)) windows.set(tab.windowId, chrome.windows.get(tab.windowId))
    }
    return { recentEvents: tabDiagnosticEvents.slice(), tabs: await Promise.all(allTabs.map(async tab => {
      let window
      try { window = await windows.get(tab.windowId) } catch { window = {} }
      const matches = targets.filter(target => target.tabId === tab.id)
      const target = matches.length === 1 ? matches[0] : null
      return { tabId: tab.id, targetId: target?.id || null,
        ...(matches.length > 1 ? { targetMatch: 'ambiguous' } : {}), url: tab.url || '', discarded: tab.discarded ?? null,
        autoDiscardable: tab.autoDiscardable ?? null,
        frozen: tab.frozen ?? null, status: tab.status, active: tab.active, windowId: tab.windowId,
        state: window.state ?? null, focused: window.focused ?? null,
        attached: targets.some(target => target.tabId === tab.id && target.attached === true) }
    })) }
  }

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (!sessionId && !targetId ? (() => {
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })() : null)

  if (!tabId) throw new Error(`BROWSER_TAB_MISSING: No attached tab for method ${method}`)
  const generation = tabGeneration(tabId)
  const nativeTab = await chrome.tabs.get(tabId).catch(() => null)
  assertTabGeneration(tabId, generation)
  if (!nativeTab || nativeTab.discarded) {
    await detachTab(tabId, 'discarded_or_missing')
    throw new Error('BROWSER_TAB_MISSING: discarded or missing tab')
  }

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    assertTabGeneration(tabId, generation)
    const result = await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
    assertTabGeneration(tabId, generation)
    return result
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      const allTabs = await chrome.tabs.query({})
      if (isLastRemainingTab(allTabs, toClose)) {
        console.warn('Refusing to close the last tab: this would kill the browser process')
        return { success: false, error: 'Cannot close the last tab' }
      }
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  const result = await chrome.debugger.sendCommand(debuggerSession, method, params)
  assertTabGeneration(tabId, generation)
  return result
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // Relay may be down.
  }
}

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return

  // User explicitly cancelled or DevTools replaced the connection — respect their intent
  if (reason === 'canceled_by_user' || reason === 'replaced_with_devtools') {
    void detachTab(tabId, reason)
    return
  }

  // Check if tab still exists — distinguishes navigation from tab close
  let tabInfo
  try {
    tabInfo = await chrome.tabs.get(tabId)
  } catch {
    // Tab is gone (closed) — normal cleanup
    void detachTab(tabId, reason)
    return
  }

  if (tabInfo.discarded) {
    await detachTab(tabId, 'discarded')
    return
  }

  if (tabInfo.url?.startsWith('chrome://') || tabInfo.url?.startsWith('chrome-extension://')) {
    void detachTab(tabId, reason)
    return
  }

  if (reattachPending.has(tabId)) return

  const oldTab = tabs.get(tabId)
  const oldSessionId = oldTab?.sessionId
  const oldTargetId = oldTab?.targetId

  if (oldSessionId) tabBySession.delete(oldSessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  if (oldSessionId && oldTargetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: oldSessionId, targetId: oldTargetId, reason: 'navigation-reattach' },
        },
      })
    } catch {
      // Relay may be down.
    }
  }

  reattachPending.add(tabId)
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'Clawser Browser Relay: re-attaching after navigation…',
  })

  // Extend re-attach window from 2.5 s to ~7.7 s (5 attempts).
  // SPAs and pages with heavy JS can take >2.5 s before the Chrome debugger
  // is attachable, causing all three original attempts to fail and leaving
  // the badge permanently off after every navigation.
  const delays = [200, 500, 1000, 2000, 4000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    await new Promise((r) => setTimeout(r, delays[attempt]))

    if (!reattachPending.has(tabId)) return

    try {
      await chrome.tabs.get(tabId)
    } catch {
      reattachPending.delete(tabId)
      setBadge(tabId, 'off')
      return
    }

    const relayUp = relayWs && relayWs.readyState === WebSocket.OPEN

    try {
      // When relay is down, still attach the debugger but skip sending the
      // relay event. reannounceAttachedTabs() will notify the relay once it
      // reconnects, so the tab stays tracked across transient relay drops.
      await attachTab(tabId, { skipAttachedEvent: !relayUp })
      reattachPending.delete(tabId)
      if (!relayUp) {
        setBadge(tabId, 'connecting')
        void chrome.action.setTitle({
          tabId,
          title: 'Clawser Browser Relay: attached, waiting for relay reconnect…',
        })
      }
      return
    } catch {
      // continue retries
    }
  }

  reattachPending.delete(tabId)
  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'Clawser Browser Relay: re-attach failed (click to retry)',
  })
}

// Record native payloads immediately, independently of initialization and
// lifecycle mutations below. Observations are read-only and best effort.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const related = tabs.has(tabId) || isBusinessTabUrl(tab.url)
  const health = ['discarded', 'frozen', 'autoDiscardable']
  if (related || health.some(key => key in change)) {
    void recordTabDiagnostic('updated', tab, { change: related ? { ...change } : Object.fromEntries(
      Object.entries(change).filter(([key]) => health.includes(key))) }, { originOnly: !related })
  }
})
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const previous = tabs.get(removedTabId)
  void recordTabDiagnostic('replaced', { id: addedTabId }, { removedTabId,
    targetId: previous?.targetId ?? null, sessionId: previous?.sessionId ?? null })
})
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null) void recordTabDiagnostic('debugger_detach', { id: source.tabId }, { reason })
})

// Tab lifecycle listeners — clean up stale entries.
chrome.tabs.onCreated.addListener((tab) => void whenReady(() => autoAttachOpenedTab(tab)))

chrome.tabs.onRemoved.addListener((tabId) => {
  ownedCreates.delete(tabId)
  retireTabIdentity(tabId, 'tab_closed')
  void whenReady(async () => { await releaseProtection(tabId, false); await persistState() })
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  // New tabId needs a fresh successful attach; never copy the old target/session.
  ownedCreates.delete(removedTabId)
  retireTabIdentity(removedTabId, 'tab_replaced')
  void whenReady(async () => { await releaseProtection(removedTabId, false); await persistState() })
})

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.discarded === true) {
    retireTabIdentity(tabId, 'discarded')
    void whenReady(async () => {
      await releaseProtection(tabId, false)
      await chrome.debugger.detach({ tabId }).catch(() => {})
      await persistState()
    })
  } else if ('autoDiscardable' in change && change.autoDiscardable !== false) {
    void whenReady(() => releaseProtection(tabId, false))
  } else if ('url' in change && !isBusinessTabUrl(tab.url)) {
    void whenReady(() => releaseProtection(tabId))
  }
})

// Register debugger listeners at module scope so detach/event handling works
// even when the relay WebSocket is down.
chrome.debugger.onEvent.addListener((...args) => void whenReady(() => onDebuggerEvent(...args)))
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null) tabGenerations.set(source.tabId, tabGeneration(source.tabId) + 1)
  void whenReady(() => onDebuggerDetach(source, reason))
})

chrome.action.onClicked.addListener(() => void whenReady(() => connectOrToggleForActiveTab()))

// Refresh badge after navigation completes — service worker may have restarted
// during navigation, losing ephemeral badge state.
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => void whenReady(() => {
  if (frameId !== 0) return
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}))

// Refresh badge when user switches to an attached tab.
chrome.tabs.onActivated.addListener(({ tabId }) => void whenReady(() => {
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}))

chrome.runtime.onInstalled.addListener(() => {
  void chrome.runtime.openOptionsPage()
})

// MV3 keepalive via chrome.alarms — more reliable than setInterval across
// service worker restarts. Checks relay health and refreshes badges.
chrome.alarms.create('relay-keepalive', { periodInMinutes: 0.5 })

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'relay-keepalive') return
  await initPromise

  // Refresh badges (ephemeral in MV3).
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
    }
  }

  // If relay is down and no reconnect is in progress, trigger one.
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    if (!relayConnectPromise && !reconnectTimer) {
      console.log('Keepalive: WebSocket unhealthy, triggering reconnect')
      await ensureRelayConnection().catch(() => {
        // ensureRelayConnection may throw without triggering onRelayClosed
        // (e.g. preflight fetch fails before WS is created), so ensure
        // reconnect is always scheduled on failure.
        if (!reconnectTimer) {
          scheduleReconnect()
        }
      })
    }
  }
})

// Rehydrate state on service worker startup. Split: rehydration is the gate
// (fast), relay reconnect runs in background (slow, non-blocking).
const initPromise = chrome.storage.local.get(['businessTabProtectionUrls', 'businessTabProtectionRecords']).then(stored => {
  businessTabProtectionUrls = Array.isArray(stored.businessTabProtectionUrls) ? stored.businessTabProtectionUrls : []
  businessTabProtectionRecords = stored.businessTabProtectionRecords || {}
}).catch(() => {}).then(() => rehydrateState())

initPromise.then(() => {
  ensureRelayConnection().then(() => {
    reconnectAttempt = 0
    if (tabs.size > 0) {
      return reannounceAttachedTabs()
    }
  }).catch(() => {
    if (tabs.size > 0) {
      scheduleReconnect()
    }
  })
})

// Shared gate: all state-dependent handlers await this before accessing maps.
async function whenReady(fn) {
  await initPromise
  return fn()
}

// Relay check handler for the options page. The service worker has
// host_permissions and bypasses CORS preflight, so the options page
// delegates relay reachability checks here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'relayCheck') return false
  const { url } = msg
  fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) })
    .then(async (res) => {
      const contentType = String(res.headers.get('content-type') || '')
      let json = null
      if (contentType.includes('application/json')) {
        try {
          json = await res.json()
        } catch {
          json = null
        }
      }
      sendResponse({ status: res.status, ok: res.ok, contentType, json })
    })
    .catch((err) => sendResponse({ status: 0, ok: false, error: String(err) }))
  return true
})
