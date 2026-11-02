import { onScopeDispose, ref, type Ref } from 'vue'
import { ApiError, apiFetch } from '@/lib/api'

export interface HlCallLog {
  id: number
  op: string
  ok: boolean
  ms: number
  code?: string
  at: number
}

/** Parent side of window.hl: iframe postMessage -> POST /api/hl/call (cookie) -> result posted back. */
export function useHlBridge(iframe: Ref<HTMLIFrameElement | null>) {
  const calls = ref<HlCallLog[]>([])
  const runtimeErrors = ref<string[]>([])
  let seq = 0

  async function onMessage(ev: MessageEvent) {
    const source = iframe.value?.contentWindow
    if (!source || ev.source !== source) return
    const msg = ev.data
    if (msg?.__genesis === 'preview:error') {
      runtimeErrors.value = [...runtimeErrors.value.slice(-4), String(msg.message)]
      return
    }
    if (msg?.__genesis !== 'hl:request' || typeof msg.op !== 'string') return

    const started = performance.now()
    const log: HlCallLog = { id: ++seq, op: msg.op, ok: false, ms: 0, at: Date.now() }
    let reply: Record<string, unknown>
    try {
      const { data } = await apiFetch<{ data: unknown }>('/hl/call', {
        method: 'POST',
        body: { op: msg.op, params: msg.params ?? {} },
        session: true,
      })
      log.ok = true
      reply = { ok: true, data }
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, 'HL_ERROR', 'HighLevel request failed')
      log.code = e.code
      reply = { ok: false, error: { code: e.code, message: e.message, status: e.status, retryable: e.retryable } }
    }
    log.ms = Math.round(performance.now() - started)
    calls.value = [log, ...calls.value].slice(0, 30)
    // The sandboxed iframe has an opaque ("null") origin, so '*' is the only valid target;
    // we post to the specific window that asked, and the payload carries no secrets.
    source.postMessage({ __genesis: 'hl:response', id: msg.id, ...reply }, '*')
  }

  window.addEventListener('message', onMessage)
  onScopeDispose(() => window.removeEventListener('message', onMessage))

  function clear() {
    calls.value = []
    runtimeErrors.value = []
  }
  return { calls, runtimeErrors, clear }
}
