// First-batch extension lifecycle contract. Business fallback and heartbeat are deliberately
// outside this suite. Native Chrome APIs are the external boundary.
import fs from 'node:fs';
import vm from 'node:vm';
import { afterEach, expect, it } from 'vitest';
// Native extension helpers are JavaScript, without TypeScript declarations.
const utils = await import(new URL('../../chrome-extension/background-utils.js', import.meta.url).href);
const { recordWorkerStart } = await import(new URL('../../chrome-extension/diagnostic-worker.js', import.meta.url).href);

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

async function worker(options: { saved?: any; existingProtection?: boolean; originalFalse?: boolean; discarded?: boolean; frozen?: boolean; attachFails?: boolean; attachError?: Error; targetInfoFails?: boolean; commandGate?: Promise<any>; attachGate?: Promise<void>; attachGates?: Map<number, Promise<void>>; relaySendFails?: boolean; persistGate?: Promise<void>; commandMethod?: string; targetInfoGate?: Promise<void>; nativeTargetId?: string; extraNativeTarget?: boolean; nativeTargetMissing?: boolean; targetQueryFails?: boolean; removeError?: Error } = {}) {
  const inventory = new Map<number, any>([
    [7, { id: 7, url: 'https://qdd.test/home', discarded: options.discarded || false,
      frozen: options.frozen || false, autoDiscardable: options.originalFalse ? false : !options.existingProtection,
      windowId: 42, active: true, status: options.discarded ? 'unloaded' : 'complete' }],
    [8, { id: 8, url: 'https://ordinary.test/', discarded: false, autoDiscardable: true,
      windowId: 42, active: false, status: 'complete' }],
  ]);
  const saved = options.saved || { local: { businessTabProtectionUrls: ['https://qdd.test/', 'https://ywb.test/'],
    ...(options.existingProtection ? { businessTabProtectionRecords: {
      7: { tabId: 7, targetId: 'target-7', windowId: 42, url: 'https://qdd.test/home', originalAutoDiscardable: true },
    } } : {}) }, session: options.existingProtection ? { persistedTabs: [
      { tabId: 7, sessionId: 'session-7', targetId: 'target-7', attachOrder: 1 },
    ], nextSession: 2 } : {} };
  const hooks = new Map<string, Array<(...args: any[]) => void>>();
  const timers = new Set<any>();
  const writes: Array<{ tabId: number; values: any }> = [];
  const attached = new Set<number>(options.existingProtection && saved.session.persistedTabs?.length ? [7] : []);
  const sent: any[] = [];
  const nativeAttachCalls: number[] = [];
  const removeCalls: number[] = [];
  const warnings: unknown[][] = [];
  let nextCreatedId = 9;
  const event = (name: string) => ({ addListener(fn: any) { hooks.set(name, [...(hooks.get(name) || []), fn]); } });
  const notify = async (name: string, ...args: any[]) => {
    for (const fn of hooks.get(name) || []) fn(...args);
    await flush();
    await new Promise(resolve=>setImmediate(resolve));
  };
  const store = (name: 'local' | 'session') => ({
    get: async () => structuredClone(saved[name]),
    set: async (values: any) => { if(name==='session') await options.persistGate; Object.assign(saved[name], structuredClone(values)); },
    remove: async (keys: string[]) => { for (const key of keys) delete saved[name][key]; },
  });
  const chrome = {
    storage: { local: store('local'), session: store('session') },
    tabs: {
      get: async (id: number) => { if (!inventory.has(id)) throw new Error('No tab'); return structuredClone(inventory.get(id)); },
      query: async (query: any) => [...inventory.values()].filter(t => !query.active || t.active).map(t => structuredClone(t)),
      create: async ({ url }: any) => { const id = nextCreatedId++; const tab = { id, url, windowId: 42, autoDiscardable: true, discarded: false }; inventory.set(id, tab); return structuredClone(tab); },
      update: async (id: number, values: any) => { const tab = inventory.get(id); if (!tab) throw new Error('No tab'); writes.push({ tabId: id, values: structuredClone(values) }); Object.assign(tab, values); return structuredClone(tab); },
      remove: async (id: number) => { removeCalls.push(id); if (options.removeError) throw options.removeError; inventory.delete(id); attached.delete(id); await notify('removed', id); },
      onCreated: event('created'), onRemoved: event('removed'), onReplaced: event('replaced'),
      onActivated: event('activated'), onUpdated: event('updated'),
    },
    windows: { get: async () => ({ id: 42, state: 'normal', focused: true }), update: async () => {} },
    debugger: {
      attach: async ({ tabId }: any) => { nativeAttachCalls.push(tabId); if (options.attachError) throw options.attachError; if (options.attachFails) throw new Error('native attach failed'); await (options.attachGates?.get(tabId) || options.attachGate); attached.add(tabId); },
      detach: async ({ tabId }: any) => { attached.delete(tabId); },
      sendCommand: async ({ tabId }: any, method: string) => {
        if(method==='Target.getTargetInfo') {
          await options.targetInfoGate;
          if(options.targetInfoFails) throw new Error('target info unavailable');
          return {targetInfo:{targetId:`target-${tabId}`,type:'page',url:inventory.get(tabId)?.url}};
        }
        if(method===(options.commandMethod || 'Runtime.evaluate') && options.commandGate) return options.commandGate;
        return {result:{value:1}};
      },
      getTargets: async () => { if (options.targetQueryFails) throw new Error('native target query failed'); return [...inventory.values()].filter(tab=>!tab.discarded && !(tab.id===7 && options.nativeTargetMissing)).flatMap(tab=>[{tabId:tab.id,id:options.nativeTargetId || `target-${tab.id}`,attached:attached.has(tab.id)},...(options.extraNativeTarget ? [{tabId:tab.id,id:`worker-${tab.id}`,attached:false}] : [])]); },
      onEvent: event('debuggerEvent'), onDetach: event('detach'),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {}, setTitle: async () => {}, onClicked: event('clicked') },
    runtime: { onInstalled: event('installed'), onMessage: event('message'), openOptionsPage: async () => {}, getManifest: () => ({ version: '0.1.1' }) },
    webNavigation: { onCompleted: event('completed') },
    alarms: { create() {}, onAlarm: event('alarm') },
  };
  const source = fs.readFileSync(new URL('../../chrome-extension/background.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?/gm, '');
  const api = vm.runInNewContext(source + '\n;({ attachTabForRelay, detachTab, handleForwardCdpCommand, onRelayMessage, reannounceAttachedTabs, tabs, ownedCreates, ready: initPromise, setRelay: () => { relayWs = { readyState: 1, send(value) { if (relaySendFails) throw new Error("relay send failed"); sent.push(JSON.parse(value)); } } } })', {
    ...utils, recordWorkerStart, chrome, sent, relaySendFails: options.relaySendFails, URL, structuredClone, console: { log() {}, warn(...args: unknown[]) { warnings.push(args); } },
    WebSocket: { OPEN: 1 }, fetch: async () => { throw new Error('isolated relay offline'); },
    setTimeout: (fn: any, ms: number) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout: (timer: any) => { clearTimeout(timer); timers.delete(timer); },
  });
  cleanup.push(() => { for (const timer of timers) clearTimeout(timer); });
  await api.ready;
  await flush();
  api.setRelay();
  return { api, inventory, saved, writes, notify, attached, sent, nativeAttachCalls, removeCalls, warnings, controls: options };
}

it('rejects a discarded business tab before attaching it', async () => {
  const f = await worker({ discarded: true });
  await expect(f.api.attachTabForRelay(f.inventory.get(7))).rejects.toThrow(/discarded/i);
  expect(f.attached.has(7)).toBe(false);
});

it('allows a frozen ordinary document without treating it as discarded', async () => {
  const f = await worker({ frozen: true });
  f.inventory.get(8).frozen = true;
  await expect(f.api.attachTabForRelay(f.inventory.get(8))).resolves.toMatchObject({ targetId: 'target-8' });
});

it('protects only configured business pages and restores the original value on detach', async () => {
  const f = await worker();
  await f.api.attachTabForRelay(f.inventory.get(7));
  await f.api.attachTabForRelay(f.inventory.get(8));
  expect(f.inventory.get(7).autoDiscardable).toBe(false);
  expect(f.inventory.get(8).autoDiscardable).toBe(true);
  await f.api.detachTab(7, 'canceled_by_user');
  expect(f.inventory.get(7).autoDiscardable).toBe(true);
});

it('does not modify or restore a user-owned false value', async () => {
  const f = await worker({ originalFalse: true });
  await f.api.attachTabForRelay(f.inventory.get(7));
  await f.api.detachTab(7, 'canceled_by_user');
  expect(f.inventory.get(7).autoDiscardable).toBe(false);
  expect(f.writes.filter(w => 'autoDiscardable' in w.values)).toEqual([]);
});

it.each(['worker restart', 'extension upgrade'])('retains restoration ownership across %s', async event => {
  const f = await worker();
  await f.api.attachTabForRelay(f.inventory.get(7));
  expect(f.saved.local.businessTabProtectionRecords?.['7']?.originalAutoDiscardable).toBe(true);
  const saved = structuredClone(f.saved);
  // Chrome clears storage.session on extension reload/update; local ownership
  // must survive independently of the volatile attachment projection.
  if (event === 'extension upgrade') saved.session = {};
  const replacement = await worker({ saved, existingProtection: true });
  await replacement.api.detachTab(7, 'canceled_by_user');
  expect(replacement.inventory.get(7).autoDiscardable).toBe(true);
});

it('restores an owned true value on normal detach and removes its ownership record', async () => {
  const f = await worker({ existingProtection: true });
  await f.api.detachTab(7, 'canceled_by_user');
  expect(f.inventory.get(7).autoDiscardable).toBe(true);
  expect(f.saved.local.businessTabProtectionRecords?.['7']).toBeUndefined();
});

it('does not retain the disappeared tab ownership record after replacement', async () => {
  const f = await worker({ existingProtection: true });
  f.inventory.set(17, { ...f.inventory.get(7), id: 17, discarded: true });
  f.inventory.delete(7);
  await f.notify('replaced', 17, 7);
  expect(f.saved.local.businessTabProtectionRecords?.['7']).toBeUndefined();
});

it('retires the old target identity on tab replacement instead of copying it', async () => {
  const f = await worker();
  await f.api.attachTabForRelay(f.inventory.get(7));
  f.inventory.set(17, { ...f.inventory.get(7), id: 17, discarded: true });
  f.inventory.delete(7);
  await f.notify('replaced', 17, 7);
  expect(f.api.tabs.get(17)?.targetId).not.toBe('target-7');
});

it('restores an owned flag when navigation leaves the configured business URL', async () => {
  const f = await worker({ existingProtection: true });
  f.inventory.get(7).url = 'https://ordinary.test/';
  await f.notify('updated', 7, { url: 'https://ordinary.test/' }, f.inventory.get(7));
  expect(f.inventory.get(7).autoDiscardable).toBe(true);
});

it('restores an owned flag after debugger detachment by another debugger', async () => {
  const f = await worker({ existingProtection: true });
  await f.notify('detach', { tabId: 7 }, 'replaced_with_devtools');
  expect(f.inventory.get(7).autoDiscardable).toBe(true);
});

it('rolls back only the newly created tab when native attachment fails', async () => {
  const f = await worker({ attachFails: true });
  await expect(f.api.handleForwardCdpCommand({ params: { method: 'Target.createTarget', params: { url: 'https://qdd.test/home' } } }))
    .rejects.toThrow('native attach failed');
  expect([...f.inventory.keys()]).toEqual([7, 8]);
});

it('native updated listener emits event-time evidence before lifecycle mutation',async()=>{
 const f=await worker();await f.api.attachTabForRelay(f.inventory.get(7));
 f.inventory.get(7).discarded=true;f.inventory.get(7).status='unloaded';
 await f.notify('updated',7,{discarded:true,status:'unloaded'},f.inventory.get(7));
 expect(f.sent.some(m=>m.method==='tabDiagnostic' && m.params.stage==='event' && m.params.discarded===true && m.params.targetId==='target-7')).toBe(true);
});


it('protects and registers a new matching business tab after replacement and reattachment',async()=>{
 const f=await worker();await f.api.attachTabForRelay(f.inventory.get(7));
 f.inventory.delete(7);f.inventory.set(17,{id:17,url:'https://qdd.test/home',discarded:false,autoDiscardable:true,windowId:42});
 await f.notify('replaced',17,7);
 await f.api.attachTabForRelay(f.inventory.get(17));
 expect(f.inventory.get(17).autoDiscardable).toBe(false);
 expect(f.saved.local.businessTabProtectionRecords?.['17']?.originalAutoDiscardable).toBe(true);
});
it('protects the newly opened business tab when a user reopens a discarded page',async()=>{
 const f=await worker();await f.api.attachTabForRelay(f.inventory.get(7));
 f.inventory.get(7).discarded=true;
 await f.notify('updated',7,{discarded:true},f.inventory.get(7));
 await f.notify('removed',7);f.inventory.delete(7);
 f.inventory.set(27,{id:27,url:'https://ywb.test/entry',discarded:false,autoDiscardable:true,windowId:42});
 await f.api.attachTabForRelay(f.inventory.get(27));
 expect(f.inventory.get(27).autoDiscardable).toBe(false);
 expect(f.saved.local.businessTabProtectionRecords?.['27']?.originalAutoDiscardable).toBe(true);
});
it('unrelated tab navigation does not evict the previous business discard evidence',async()=>{
 const f=await worker();await f.api.attachTabForRelay(f.inventory.get(7));
 f.inventory.get(7).discarded=true;
 await f.notify('updated',7,{discarded:true},f.inventory.get(7));
 for(let i=0;i<200;i++) {
  f.inventory.get(8).url='https://ordinary.test/private/'+i;
  await f.notify('updated',8,{status:'loading',url:f.inventory.get(8).url},f.inventory.get(8));
 }
 const snapshot=await f.api.handleForwardCdpCommand({params:{method:'Clawser.diagnosticSnapshot',params:{}}});
 expect(snapshot.recentEvents.some((e:any)=>e.tabId===7 && e.discarded===true && e.stage==='event')).toBe(true);
 expect(f.sent.filter(m=>m.method==='tabDiagnostic'&&m.params.tabId===8)).toEqual([]);
});
it('unrelated tab health events expose origin only and omit url/status changes',async()=>{
 const f=await worker();f.inventory.get(8).url='https://ordinary.test/private/person?name=Alice';
 await f.notify('updated',8,{discarded:true,status:'unloaded',url:f.inventory.get(8).url},f.inventory.get(8));
 const events=f.sent.filter(m=>m.method==='tabDiagnostic' && m.params.tabId===8);
 expect(events.length).toBeGreaterThan(0);
 for(const e of events){expect(e.params.url).toBe('https://ordinary.test');expect(e.params.change).toEqual({discarded:true});expect(e.params.status).toBeUndefined();}
});

it('refuses stale ownership for a reused tabId with another native target',async()=>{
 const saved={local:{businessTabProtectionUrls:['https://qdd.test/'],businessTabProtectionRecords:{
  7:{tabId:7,targetId:'previous-browser-target',windowId:42,url:'https://qdd.test/home',originalAutoDiscardable:true}
 }},session:{}};
 const f=await worker({saved,originalFalse:true});
 await f.api.detachTab(7,'canceled_by_user');
 expect(f.inventory.get(7).autoDiscardable).toBe(false);
 expect(f.saved.local.businessTabProtectionRecords?.['7']).toBeUndefined();
});
it('G5 never writes the flag back during the users true then false changes',async()=>{
 const f=await worker();await f.api.attachTabForRelay(f.inventory.get(7));
 expect(f.writes).toEqual([{tabId:7,values:{autoDiscardable:false}}]);
 f.inventory.get(7).autoDiscardable=true;
 await f.notify('updated',7,{autoDiscardable:true},f.inventory.get(7));
 expect(f.writes).toEqual([{tabId:7,values:{autoDiscardable:false}}]);
 expect(f.inventory.get(7).autoDiscardable).toBe(true);
 expect(f.saved.local.businessTabProtectionRecords?.['7']).toBeUndefined();
 f.inventory.get(7).autoDiscardable=false;
 await f.notify('updated',7,{autoDiscardable:false},f.inventory.get(7));
 expect(f.writes).toEqual([{tabId:7,values:{autoDiscardable:false}}]);
 await f.api.detachTab(7,'canceled_by_user');
 expect(f.inventory.get(7).autoDiscardable).toBe(false);
 expect(f.writes).toEqual([{tabId:7,values:{autoDiscardable:false}}]);
});
it('rolls back the debugger acquired from a user tab on target-info failure without closing it',async()=>{
 const f=await worker({targetInfoFails:true});
 await expect(f.api.attachTabForRelay(f.inventory.get(7))).rejects.toThrow('target info unavailable');
 expect(f.attached.has(7)).toBe(false);
 expect(f.inventory.has(7)).toBe(true);
});
it('does not route a missing explicit target to a different attached page',async()=>{
 const f=await worker();await f.api.attachTabForRelay(f.inventory.get(8));
 await expect(f.api.handleForwardCdpCommand({params:{method:'Runtime.evaluate',params:{targetId:'missing-target'}}}))
  .rejects.toThrow(/BROWSER_TAB_MISSING/);
});
it('does not publish an attach that finishes after replacement',async()=>{
 let resolve!:()=>void;const gate=new Promise<void>(r=>{resolve=r});
 const f=await worker({attachGate:gate});
 const operation=f.api.attachTabForRelay(f.inventory.get(7));
 const rejected=expect(operation).rejects.toThrow(/BROWSER_TAB_MISSING/);
 await flush();f.inventory.delete(7);
 f.inventory.set(17,{id:17,url:'https://qdd.test/home',windowId:42,discarded:false,autoDiscardable:true});
 await f.notify('replaced',17,7);resolve();await rejected;
 expect(f.api.tabs.has(7)).toBe(false);
 expect(f.api.tabs.get(17)?.targetId).not.toBe('target-7');
});
it('rejects a command response that finishes after the target was discarded',async()=>{
 let resolve!:(v:any)=>void;const gate=new Promise<any>(r=>{resolve=r});
 const f=await worker({commandGate:gate});await f.api.attachTabForRelay(f.inventory.get(7));
 const operation=f.api.handleForwardCdpCommand({params:{method:'Runtime.evaluate',params:{targetId:'target-7'}}});
 const rejected=expect(operation).rejects.toThrow(/BROWSER_TAB_MISSING/);
 await flush();f.inventory.get(7).discarded=true;
 await f.notify('updated',7,{discarded:true},f.inventory.get(7));resolve({result:{value:'stale'}});await rejected;
});

it('G3 issues exactly one native debugger attach for concurrent requests on the same tab',async()=>{
 let resolve!:()=>void;const gate=new Promise<void>(r=>{resolve=r});
 const f=await worker({attachGate:gate});
 const first=f.api.attachTabForRelay(f.inventory.get(7));const second=f.api.attachTabForRelay(f.inventory.get(7));
 await flush();resolve();
 const results=await Promise.all([first,second]);
 expect(results[0].targetId).toBe('target-7');expect(results[1].targetId).toBe('target-7');
 expect(f.sent.filter(m=>m.params?.method==='Target.attachedToTarget')).toHaveLength(1);
 expect(f.nativeAttachCalls).toEqual([7]);
});
it('G2 rejects an old response and accepts a fresh command after explicit reattachment',async()=>{
 let resolve!:(v:any)=>void;const gate=new Promise<any>(r=>{resolve=r});
 const f=await worker({commandGate:gate});await f.api.attachTabForRelay(f.inventory.get(7));
 const operation=f.api.handleForwardCdpCommand({params:{method:'Runtime.evaluate',params:{targetId:'target-7'}}});
 const rejected=expect(operation).rejects.toThrow(/BROWSER_TAB_MISSING/);
 await flush();await f.notify('detach',{tabId:7},'target_closed');
 const oldSession=f.sent.find(m=>m.params?.method==='Target.attachedToTarget').params.params.sessionId;
 resolve({result:{value:'old'}});await rejected;
 await f.api.attachTabForRelay(f.inventory.get(7));
 expect(f.api.tabs.get(7).sessionId).not.toBe(oldSession);
 expect(f.nativeAttachCalls).toEqual([7,7]);
 f.controls.commandGate=Promise.resolve({result:{value:'fresh'}});
 await expect(f.api.handleForwardCdpCommand({params:{method:'Runtime.evaluate',params:{targetId:'target-7'}}})).resolves.toEqual({result:{value:'fresh'}});
});

it('uses the product supplied business configuration and persists it for worker restart',async()=>{
 const f=await worker({saved:{local:{},session:{}}});
 await f.api.handleForwardCdpCommand({params:{method:'Clawser.attachTabs',params:{urlContains:'qdd.test',businessUrls:['https://qdd.test/','https://ywb.test/']}}});
 expect(f.inventory.get(7).autoDiscardable).toBe(false);
 expect(f.saved.local.businessTabProtectionUrls).toEqual(['https://qdd.test/','https://ywb.test/']);
});
it('rejects invalid product protection URLs instead of overwriting the saved configuration',async()=>{
 const f=await worker();
 await expect(f.api.handleForwardCdpCommand({params:{method:'Clawser.attachTabs',params:{all:true,businessUrls:['file:///private']}}})).rejects.toThrow(/businessUrls/);
 expect(f.saved.local.businessTabProtectionUrls).toEqual(['https://qdd.test/','https://ywb.test/']);
});

it('closes its newly created tab even if publishing the attach to relay fails',async()=>{
 const f=await worker({relaySendFails:true});
 await expect(f.api.handleForwardCdpCommand({params:{method:'Target.createTarget',params:{url:'https://qdd.test/home'}}})).rejects.toThrow('relay send failed');
 expect([...f.inventory.keys()]).toEqual([7,8]);
});

it('reports a filtered discarded business page as missing when no matching live page remains',async()=>{
 const f=await worker({discarded:true});
 await expect(f.api.handleForwardCdpCommand({params:{method:'Clawser.attachTabs',params:{urlContains:'qdd.test'}}})).rejects.toThrow(/BROWSER_TAB_MISSING.*discarded/);
 expect(f.attached.has(7)).toBe(false);
});

it('never sends an old connection command response into a new relay socket',async()=>{
 let resolve!:(v:any)=>void;const gate=new Promise<any>(r=>{resolve=r});
 const f=await worker({commandGate:gate});await f.api.attachTabForRelay(f.inventory.get(7));
 const operation=f.api.onRelayMessage(JSON.stringify({id:11,method:'forwardCDPCommand',params:{method:'Runtime.evaluate',params:{targetId:'target-7'}}}));
 await flush();f.api.setRelay();resolve({result:{value:'old socket'}});await operation;
 expect(f.sent.filter(message=>message.id===11)).toEqual([]);
});
it('rolls back an old connection create that finishes after relay replacement',async()=>{
 let resolve!:()=>void;const gate=new Promise<void>(r=>{resolve=r});
 const f=await worker({attachGate:gate});
 const operation=f.api.onRelayMessage(JSON.stringify({id:12,method:'forwardCDPCommand',params:{method:'Target.createTarget',params:{url:'https://qdd.test/home'}}}));
 await new Promise(r=>setTimeout(r,120));f.api.setRelay();resolve();await operation;
 expect([...f.inventory.keys()]).toEqual([7,8]);expect(f.sent.filter(message=>message.id===12)).toEqual([]);
});
it('does not evaluate window visibility for a discarded page even if its event was missed',async()=>{
 const f=await worker();await f.api.attachTabForRelay(f.inventory.get(7));f.inventory.get(7).discarded=true;
 await expect(f.api.handleForwardCdpCommand({params:{method:'Clawser.getWindowState',params:{targetId:'target-7'}}})).rejects.toThrow(/BROWSER_TAB_MISSING/);
});

it('rolls back a created tab when relay changes during attachment persistence',async()=>{
 let resolve!:()=>void;const gate=new Promise<void>(r=>{resolve=r});
 const f=await worker({persistGate:gate});
 const operation=f.api.onRelayMessage(JSON.stringify({id:13,method:'forwardCDPCommand',params:{method:'Target.createTarget',params:{url:'https://qdd.test/home'}}}));
 await new Promise(r=>setTimeout(r,120));f.api.setRelay();resolve();await operation;
 expect([...f.inventory.keys()]).toEqual([7,8]);expect(f.sent.filter(message=>message.id===13)).toEqual([]);
});
it('rejects a Runtime.enable result after discard instead of completing old initialization',async()=>{
 let resolve!:(v:any)=>void;const gate=new Promise<any>(r=>{resolve=r});
 const f=await worker({commandGate:gate,commandMethod:'Runtime.enable'});await f.api.attachTabForRelay(f.inventory.get(7));
 const operation=f.api.handleForwardCdpCommand({params:{method:'Runtime.enable',params:{targetId:'target-7'}}});
 const rejected=expect(operation).rejects.toThrow(/BROWSER_TAB_MISSING/);
 await new Promise(r=>setTimeout(r,60));f.inventory.get(7).discarded=true;
 await f.notify('updated',7,{discarded:true},f.inventory.get(7));resolve({});await rejected;
});

it('does not reannounce a retired target after a reconnect validation finishes late',async()=>{
 let resolve!:()=>void;const gate=new Promise<void>(r=>{resolve=r});
 const f=await worker();await f.api.attachTabForRelay(f.inventory.get(7));
 f.controls.targetInfoGate=gate;
 const operation=f.api.reannounceAttachedTabs();await flush();
 f.inventory.get(7).discarded=true;
 await f.notify('updated',7,{discarded:true},f.inventory.get(7));
 f.controls.targetInfoFails=true;resolve();await operation;
 const detachedAt=f.sent.findIndex(message=>message.params?.method==='Target.detachedFromTarget');
 expect(detachedAt).toBeGreaterThan(-1);
 expect(f.sent.slice(detachedAt+1).filter(message=>message.params?.method==='Target.attachedToTarget')).toEqual([]);
});

it('does not restore a persisted projection whose native target identity changed',async()=>{
 const f=await worker({existingProtection:true,nativeTargetId:'new-native-target'});
 expect(f.api.tabs.has(7)).toBe(false);
});

it('restores the explicitly known native target despite another target sharing its tabId',async()=>{
 const f=await worker({existingProtection:true,extraNativeTarget:true});
 expect(f.api.tabs.get(7)?.targetId).toBe('target-7');
 const snapshot=await f.api.handleForwardCdpCommand({params:{method:'Clawser.diagnosticSnapshot',params:{}}});
 expect(snapshot.tabs.find((tab:any)=>tab.tabId===7)).toMatchObject({targetId:null,targetMatch:'ambiguous'});
});

it('restores owned protection using its exact native target when the tab has another target',async()=>{
 const f=await worker({existingProtection:true,extraNativeTarget:true});
 await f.api.detachTab(7,'canceled_by_user');
 expect(f.inventory.get(7).autoDiscardable).toBe(true);
});

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture did not reach native boundary');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

it('G1 leaves the original flag untouched while native attach is pending', async () => {
  let resolve!: () => void;
  const gate = new Promise<void>(r => { resolve = r; });
  const f = await worker({ attachGate: gate });
  const operation = f.api.attachTabForRelay(f.inventory.get(7));
  await until(() => f.nativeAttachCalls.length === 1);
  expect(f.inventory.get(7).autoDiscardable).toBe(true);
  expect(f.writes).toEqual([]);
  resolve();
  await operation;
  expect(f.writes).toEqual([{ tabId: 7, values: { autoDiscardable: false } }]);
});

it('G1 leaves the original flag untouched when native attach fails', async () => {
  const error = new TypeError('native attach rejected');
  const f = await worker({ attachError: error });
  await expect(f.api.attachTabForRelay(f.inventory.get(7))).rejects.toBe(error);
  expect(f.inventory.get(7).autoDiscardable).toBe(true);
  expect(f.writes).toEqual([]);
});

it('G1 does not protect before native target identity validation completes', async () => {
  let resolve!: () => void;
  const gate = new Promise<void>(r => { resolve = r; });
  const f = await worker({ targetInfoGate: gate });
  const operation = f.api.attachTabForRelay(f.inventory.get(7));
  await until(() => f.attached.has(7));
  expect(f.inventory.get(7).autoDiscardable).toBe(true);
  expect(f.writes).toEqual([]);
  resolve();
  await operation;
  expect(f.inventory.get(7).autoDiscardable).toBe(false);
});

it('G1 does not write protection after native target identity validation fails', async () => {
  const f = await worker({ targetInfoFails: true });
  await expect(f.api.attachTabForRelay(f.inventory.get(7))).rejects.toThrow('target info unavailable');
  expect(f.inventory.get(7).autoDiscardable).toBe(true);
  expect(f.writes).toEqual([]);
  expect(f.attached.has(7)).toBe(false);
});

it.each([
  { name: 'window mismatch', recordWindow: 43, nativeTargetMissing: false, targetQueryFails: false, reason: 'window_mismatch' },
  { name: 'missing native target', recordWindow: 42, nativeTargetMissing: true, targetQueryFails: false, reason: 'target_missing' },
  { name: 'native target query failure', recordWindow: 42, nativeTargetMissing: false, targetQueryFails: true, reason: 'target_query_failed' },
])('G4 skips stale restoration with diagnostic evidence for $name', async test => {
  const saved = { local: { businessTabProtectionUrls: ['https://qdd.test/'], businessTabProtectionRecords: {
    7: { tabId: 7, targetId: 'target-7', windowId: test.recordWindow, url: 'https://qdd.test/home', originalAutoDiscardable: true },
  } }, session: {} };
  const f = await worker({ saved, originalFalse: true, nativeTargetMissing: test.nativeTargetMissing, targetQueryFails: test.targetQueryFails });
  await f.api.detachTab(7, 'canceled_by_user');
  expect(f.inventory.get(7).autoDiscardable).toBe(false);
  expect(f.inventory.get(8).autoDiscardable).toBe(true);
  expect(f.writes).toEqual([]);
  expect(f.saved.local.businessTabProtectionRecords?.['7']).toBeUndefined();
  expect(f.sent.some(message => message.method === 'tabDiagnostic' && message.params.event === 'protection_restore_skipped' && message.params.reason === test.reason && message.params.tabId === 7)).toBe(true);
});

it('G6 skips page removal and logs when creation ownership proof is lost', async () => {
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((_, r) => { reject = r; });
  const f = await worker({ attachGate: gate });
  const error = new TypeError('late native attach rejection');
  const operation = f.api.handleForwardCdpCommand({ params: { method: 'Target.createTarget', params: { url: 'https://qdd.test/home' } } });
  const rejected = expect(operation).rejects.toBe(error);
  await until(() => f.nativeAttachCalls.includes(9));
  // Fault injection into the ownership registry only, without changing the page.
  f.api.ownedCreates.delete(9);
  reject(error);
  await rejected;
  expect(f.inventory.has(9)).toBe(true);
  expect(f.removeCalls).toEqual([]);
  expect(f.warnings).toContainEqual(['create rollback skipped: tab identity changed', 9]);
});

it('G6 preserves the original create error and logs a rejected page removal', async () => {
  const original = new TypeError('native attachment rejected');
  const removeError = new Error('permission denied by browser');
  const f = await worker({ attachError: original, removeError });
  await expect(f.api.handleForwardCdpCommand({ params: { method: 'Target.createTarget', params: { url: 'https://qdd.test/home' } } })).rejects.toBe(original);
  expect(f.removeCalls).toEqual([9]);
  expect(f.inventory.has(9)).toBe(true);
  expect(f.warnings).toContainEqual(['create rollback failed', 9, String(removeError)]);
});

it('G6 late rollback removes only its old page while a distinct retry page stays usable', async () => {
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((_, r) => { reject = r; });
  const f = await worker({ attachGates: new Map([[9, gate]]) });
  const error = new Error('first create failed late');
  const first = f.api.handleForwardCdpCommand({ params: { method: 'Target.createTarget', params: { url: 'https://qdd.test/home?attempt=1' } } });
  const rejected = expect(first).rejects.toBe(error);
  await until(() => f.nativeAttachCalls.includes(9));
  await expect(f.api.handleForwardCdpCommand({ params: { method: 'Target.createTarget', params: { url: 'https://qdd.test/home?attempt=2' } } })).resolves.toMatchObject({ targetId: 'target-10' });
  expect([...f.inventory.keys()]).toEqual([7, 8, 9, 10]);
  reject(error);
  await rejected;
  expect(f.removeCalls).toEqual([9]);
  expect([...f.inventory.keys()]).toEqual([7, 8, 10]);
  expect(f.api.tabs.get(10)?.targetId).toBe('target-10');
  expect(f.inventory.get(10).autoDiscardable).toBe(false);
  await expect(f.api.handleForwardCdpCommand({ params: { method: 'Runtime.evaluate', params: { targetId: 'target-10' } } })).resolves.toEqual({ result: { value: 1 } });
});
