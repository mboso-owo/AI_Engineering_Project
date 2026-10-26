import { ErrorRequestHandler } from 'express';
import { logger } from '../lib/logger';

function scrubSensitiveData(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/password["']?\s*[:=]\s*["']?[^"'\s,}]+/gi, 'password=[REDACTED]');
}

export const errorHandler: ErrorRequestHandler = (
  error,
  req,
  res,
  next,
) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const candidateStatus = Number.isInteger(error?.statusCode)
    ? error.statusCode
    : Number.isInteger(error?.status)
      ? error.status
      : 500;
  const status = candidateStatus >= 400 && candidateStatus <= 599
    ? candidateStatus
    : 500;
  const message = error instanceof Error
    ? scrubSensitiveData(error.message)
    : 'Internal server error';
  const stack = error instanceof Error && error.stack
    ? scrubSensitiveData(error.stack)
    : undefined;

  logger.error('Unhandled request error', {
    error: { message, stack },
    method: req.method,
    path: req.path,
    status,
  });

  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : message,
  });
};
