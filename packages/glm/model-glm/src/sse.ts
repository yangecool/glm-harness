/**
 * GH's own Server-Sent-Events framing parser. The GLM protocol family carries
 * its streaming response as SSE `data:` frames terminated by `data: [DONE]`;
 * this parser is written here instead of reusing any upstream adapter's
 * transport. It yields each frame as soon as its terminating blank line
 * arrives, is safe across chunk boundaries, and never emits an unterminated
 * trailing frame.
 */

/** One parsed SSE frame: the accumulated `data:` payload and any `event:` name. */
export interface SseFrame {
  event?: string
  data: string
}

/**
 * Parse a byte stream into SSE frames.
 *
 * @param body - the response body stream, in any chunking.
 * @param activity - watchdog pulse, called once per comment line and per
 * dispatched frame so heartbeats and events both reset idle timers.
 * @yields complete frames in arrival order; a torn final line is dropped.
 * @returns the asynchronous frame iterator.
 */
export async function* parseSseFrames(
  body: ReadableStream<Uint8Array>,
  activity: () => void,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let pending = ''
  let dataLines: string[] = []
  let eventName: string | undefined

  /** Fold one complete line into the frame under construction; a blank line dispatches it. */
  const consumeLine = (rawLine: string): SseFrame | undefined => {
    // SSE strips one trailing CR of a CRLF pair.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      if (dataLines.length === 0 && eventName === undefined) return undefined
      activity()
      const frame: SseFrame = {
        data: dataLines.join('\n'),
        ...eventName === undefined ? {} : { event: eventName },
      }
      dataLines = []
      eventName = undefined
      return frame
    }
    if (line.startsWith(':')) {
      activity()
      return undefined
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') eventName = value
    // Other SSE fields (id, retry) carry nothing this consumer needs.
    return undefined
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      while (true) {
        const newline = pending.indexOf('\n')
        if (newline === -1) break
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const frame = consumeLine(line)
        if (frame !== undefined) yield frame
      }
    }
    // End of stream without the final line terminator: the tail is torn and,
    // per SSE framing, not an event. A final decoder flush would only ever
    // complete bytes of that torn line, so nothing further is dispatched.
  } finally {
    reader.releaseLock()
  }
}
