import type { Response } from "express";

/** Server-Sent Events writer. The event protocol is documented in the README. */
export function openSse(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  // Keeps proxies from closing the stream while the model thinks before the first token.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 10_000);

  return {
    send(event: string, data: unknown) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      clearInterval(heartbeat);
      if (!closed) res.end();
    },
    isClosed: () => closed,
  };
}

export type SseStream = ReturnType<typeof openSse>;
