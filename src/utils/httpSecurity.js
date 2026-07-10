import { timingSafeEqual } from 'node:crypto';

function sendError(res, status, type, message) {
  return res.status(status).json({
    type: 'error',
    error: { type, message },
  });
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  const length = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}

function getPresentedApiKey(req) {
  const authorization = req.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }
  return req.get('x-api-key') || '';
}

export function createApiKeyMiddleware(apiKey) {
  return (req, res, next) => {
    if (!apiKey) {
      return next();
    }

    const presented = getPresentedApiKey(req);
    if (!constantTimeEqual(presented, apiKey)) {
      res.set('WWW-Authenticate', 'Bearer');
      return sendError(res, 401, 'authentication_error', 'Invalid or missing API key');
    }
    return next();
  };
}

export function createCorsMiddleware(allowedOrigins = []) {
  const allowlist = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin) {
      return next();
    }

    if (!allowlist.has(origin)) {
      return sendError(res, 403, 'permission_error', 'Origin is not allowed');
    }

    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers':
        'Authorization,Content-Type,X-API-Key,X-Session-Id,X-HoProxy-Client-Id',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    return next();
  };
}

export function createConcurrencyLimit(maxConcurrent) {
  let active = 0;

  return (_req, res, next) => {
    if (active >= maxConcurrent) {
      res.set('Retry-After', '1');
      return sendError(res, 503, 'overloaded_error', 'Too many concurrent message requests');
    }

    active += 1;
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      active -= 1;
    };
    res.once('finish', release);
    res.once('close', release);
    return next();
  };
}

export function createRateLimit({ maxRequests, windowMs }) {
  const clients = new Map();
  const cleanup = setInterval(
    () => {
      const now = Date.now();
      for (const [client, entry] of clients) {
        if (entry.resetAt <= now) {
          clients.delete(client);
        }
      }
    },
    Math.max(windowMs, 30_000),
  );
  cleanup.unref?.();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let entry = clients.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      clients.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1_000));
      res.set('Retry-After', String(retryAfter));
      return sendError(res, 429, 'rate_limit_error', 'Rate limit exceeded');
    }
    return next();
  };
}
