import type { NextFunction, Request, Response } from "express";
import { logger } from "firebase-functions";

/** An error that is safe to show to the user, with a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, retryable: err.retryable } });
    return;
  }
  logger.error("Unhandled error", err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong on our side.", retryable: true } });
}
