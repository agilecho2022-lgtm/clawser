const PORT_GUIDANCE = 'Use gateway port + 3 (for gateway 18789, relay is 18792).'

function hasRelayStatusShape(data) {
  return !!data && typeof data === 'object' && typeof data.connected === 'boolean'
}

export function classifyRelayCheckResponse(res, port) {
  if (!res) {
    return { action: 'throw', error: 'No response from service worker' }
  }

  if (res.status === 401) {
    return { action: 'status', kind: 'error', message: 'Relay rejected the check request.' }
  }

  if (res.error) {
    return { action: 'throw', error: res.error }
  }

  if (!res.ok) {
    return { action: 'throw', error: `HTTP ${res.status}` }
  }

  const contentType = String(res.contentType || '')
  if (!contentType.includes('application/json')) {
    return {
      action: 'status',
      kind: 'error',
      message: `Wrong port: this is likely the gateway, not the relay. ${PORT_GUIDANCE}`,
    }
  }

  if (!hasRelayStatusShape(res.json)) {
    return {
      action: 'status',
      kind: 'error',
      message: `Wrong port: expected relay /extension/status response. ${PORT_GUIDANCE}`,
    }
  }

  return { action: 'status', kind: 'ok', message: `Relay reachable at http://127.0.0.1:${port}/` }
}

export function classifyRelayCheckException(err, port) {
  const message = String(err || '').toLowerCase()
  if (message.includes('json') || message.includes('syntax')) {
    return {
      kind: 'error',
      message: `Wrong port: this is not a relay endpoint. ${PORT_GUIDANCE}`,
    }
  }

  return {
    kind: 'error',
    message: `Relay not reachable at http://127.0.0.1:${port}/. Start Clawser browser relay and verify the port.`,
  }
}
