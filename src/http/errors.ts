import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Decision } from '../authz/engine';

/** An error we expect and can describe to the caller with a proper HTTP status. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Not found - also used when the caller is not allowed to SEE a job, so we never reveal it exists. */
export const notFound = (what = 'Job') => new AppError(404, 'NOT_FOUND', `${what} not found.`);

/** Forbidden, carrying the engine's explained decision. */
export const forbidden = (decision: Decision) => new AppError(403, decision.code, decision.reason, { decision });

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request.', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
    return;
  }
  // Unknown failure: log it, but never leak internals to the caller.
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
};
