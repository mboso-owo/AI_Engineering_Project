import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { cacheRedis } from '../lib/cache';
import { Request } from 'express';

// Helper to create limiters with Redis backing
function createLimiter(options: {
  windowMs: number;
  max: number | ((req: Request) => number);
  message: string;
  keyGenerator?: (req: Request) => string;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,   // Send X-RateLimit-* headers
    legacyHeaders: false,    // Don't send X-RateLimit-* (old format)
    store: new RedisStore({
      sendCommand: (...args: string[]) =>
        (cacheRedis as any).call(...args),
    }),
    message: {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: options.message,
      },
    },
    keyGenerator: options.keyGenerator ||
      ((req: Request) => (req as any).user?.id || req.ip || 'anonymous'),
  });
}

