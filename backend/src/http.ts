import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const badRequest = (msg: string) => new HttpError(400, msg);

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wrap an async route so rejections reach the error middleware. */
export const ah =
  (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

/** SQLSTATE -> HTTP. Trigger RAISE EXCEPTION lands on P0001. */
const PG_STATUS: Record<string, number> = {
  '23502': 400, // not_null_violation
  '23503': 400, // foreign_key_violation
  '23514': 400, // check_violation
  '22P02': 400, // invalid_text_representation
  '22003': 400, // numeric_value_out_of_range
  P0001: 400, // raise_exception (our map-consistency triggers)
  '23505': 409, // unique_violation
  '40001': 409, // serialization_failure
  '40P01': 409, // deadlock_detected
  '57014': 503, // query_canceled
  '53300': 503, // too_many_connections
  '08003': 503,
  '08006': 503
};

/** Messages we wrote ourselves are safe to echo; the rest stay generic. */
const PG_SAFE_MESSAGE = new Set(['P0001', '23514']);

export function pgErrorResponse(
  err: unknown
): { status: number; body: { error: string; code?: string } } | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;
  const status = PG_STATUS[code];
  if (!status) return null;
  const message =
    PG_SAFE_MESSAGE.has(code) && err instanceof Error
      ? err.message
      : status >= 500
        ? 'the database is unavailable'
        : 'the request conflicts with the stored data';
  return { status, body: { error: message, code } };
}
