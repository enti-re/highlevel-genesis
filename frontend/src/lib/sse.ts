import { ApiError, authHeader, toApiError } from './api'
import { API_BASE_URL } from './firebase'

const EVENT_PREFIX = 'event:'
const DATA_PREFIX = 'data:'

export interface SseEvent {
  event: string
  data: any
}

/** fetch-based SSE: EventSource can't POST or send an Authorization header. Rejects with STREAM_INTERRUPTED on a drop. */
export async function postSse(path: string, body: unknown, onEvent: (event: SseEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err instanceof ApiError || (err as Error).name === 'AbortError') throw err
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection.', true)
  }
  if (!res.ok || !res.body) throw await toApiError(res)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: RegExpExecArray | null
      const separator = /\r?\n\r?\n/
      while ((boundary = separator.exec(buffer))) {
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const parsed = parseEvent(raw)
        if (parsed) onEvent(parsed)
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ApiError(0, 'STREAM_INTERRUPTED', 'Connection lost during generation.', true)
  }
}

export function parseEvent(raw: string): SseEvent | null {
  let event = 'message'
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue // comment / heartbeat
    if (line.startsWith(EVENT_PREFIX)) event = line.slice(EVENT_PREFIX.length).trim()
    else if (line.startsWith(DATA_PREFIX)) data.push(line.slice(DATA_PREFIX.length).trimStart())
  }
  if (!data.length) return null
  try {
    return { event, data: JSON.parse(data.join('\n')) }
  } catch {
    return null
  }
}
