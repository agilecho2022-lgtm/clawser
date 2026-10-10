// One record per worker lifetime; reconnects reuse it. Never carries credentials.
export async function recordWorkerStart(chrome, startedAt = Date.now()) {
  try {
    const stored = await chrome.storage.local.get(['workerStartSequence'])
    const startSequence = (Number(stored.workerStartSequence) || 0) + 1
    await chrome.storage.local.set({ workerStartSequence: startSequence })
    return { startedAt, startSequence }
  } catch {
    return { startedAt, startSequence: null, error: 'worker sequence unavailable' }
  }
}
