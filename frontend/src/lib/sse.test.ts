import { describe, expect, it, vi } from 'vitest'

// sse.ts imports the Firebase app; the parser under test doesn't need it.
vi.mock('./firebase', () => ({ API_BASE_URL: '', auth: {} }))
const { parseEvent } = await import('./sse')

describe('parseEvent', () => {
  it('parses event name and JSON data', () => {
    expect(parseEvent('event: token\ndata: {"path":"a.js","delta":"x"}')).toEqual({
      event: 'token',
      data: { path: 'a.js', delta: 'x' },
    })
  })
  it('ignores heartbeat comments', () => {
    expect(parseEvent(': ping')).toBeNull()
  })
  it('joins multi-line data', () => {
    expect(parseEvent('event: text\ndata: {"delta":\ndata: "hi"}')?.data).toEqual({ delta: 'hi' })
  })
  it('drops malformed JSON instead of throwing mid-stream', () => {
    expect(parseEvent('event: x\ndata: {nope')).toBeNull()
  })
  it('handles CRLF line endings', () => {
    expect(parseEvent('event: done\r\ndata: {"status":"complete"}')?.data.status).toBe('complete')
  })
})
