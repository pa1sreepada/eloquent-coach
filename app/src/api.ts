// Every backend call carries the per-launch token from the Electron preload (backend/api_auth.py).
export const API_BASE = 'http://127.0.0.1:8000'
export const WS_BASE = 'ws://127.0.0.1:8000'

const token = () => window.eloquent?.apiToken ?? ''

/** Adds the Authorization header to fetches to the backend, so call sites can keep using fetch(). */
export function installApiAuth() {
  const original = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!token() || !(url === API_BASE || url.startsWith(`${API_BASE}/`))) return original(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('Authorization', `Bearer ${token()}`)
    return original(input, { ...init, headers })
  }
}

/** WebSocket to the backend; browsers can't set headers, so the token travels as a subprotocol. */
export function apiSocket(url: string): WebSocket {
  return new WebSocket(url, ['eloquent', `token.${token()}`])
}
