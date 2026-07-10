import express from 'express';
import { loadConfig } from './config.js';
import messagesRouter from './routes/messages.js';
import modelsRouter from './routes/models.js';
import refreshTokenRouter from './routes/refreshToken.js';
import { getActiveStreamCount } from './services/activeStreams.js';
import { getDefaultClient, getTokenExpiryInfo } from './services/hopgptClient.js';
import {
  createApiKeyMiddleware,
  createConcurrencyLimit,
  createCorsMiddleware,
  createRateLimit,
} from './utils/httpSecurity.js';
import { createLogger, requestLoggerMiddleware } from './utils/logger.js';

const log = createLogger('App');

function anthropicError(res, status, type, message) {
  return res.status(status).json({
    type: 'error',
    error: { type, message },
  });
}

export function createApp({ config = loadConfig(), clientProvider = getDefaultClient } = {}) {
  const app = express();
  app.locals.config = config;
  app.disable('x-powered-by');

  app.use(createCorsMiddleware(config.corsOrigins));
  app.use(express.json({ limit: config.bodyLimit, strict: true }));
  app.use(requestLoggerMiddleware());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'hoproxy' });
  });

  app.use(createApiKeyMiddleware(config.apiKey));

  app.get('/ready', async (req, res) => {
    const client = clientProvider();
    const auth = client.validateAuth();
    const bearerInfo = getTokenExpiryInfo(client.bearerToken);
    const credentialsReady =
      Boolean(client.bearerToken && !bearerInfo?.isExpired) ||
      client.hasRefreshCredential?.() === true;
    const shouldCheckUpstream = config.readyUpstreamCheck || req.query.upstream === 'true';
    const upstream = shouldCheckUpstream
      ? await client.checkUpstreamReadiness()
      : { checked: false };
    const ready = auth.valid && credentialsReady && upstream.reachable !== false;

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        configuration: auth.valid,
        credentials: credentialsReady,
        upstream,
      },
      active_streams: getActiveStreamCount(),
    });
  });

  const messageGuards = [
    createRateLimit({
      maxRequests: config.rateLimitRequests,
      windowMs: config.rateLimitWindowMs,
    }),
    createConcurrencyLimit(config.maxConcurrentMessages),
  ];

  app.use('/v1/messages', messageGuards);
  app.use('/v1', modelsRouter);
  app.use('/v1', messagesRouter);

  app.use((req, res, next) => {
    const normalizedPath = req.path.replace(/\/+$/, '') || '/';
    if (normalizedPath === '/token-debug' && !config.debug) {
      return anthropicError(res, 404, 'not_found_error', 'Not found');
    }
    return next();
  });
  app.use('/', refreshTokenRouter);

  app.use((_req, res) => {
    anthropicError(res, 404, 'not_found_error', 'Not found');
  });

  app.use((error, req, res, _next) => {
    const requestId = req.id || req.headers['x-request-id'];

    if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
      return anthropicError(res, 400, 'invalid_request_error', 'Malformed JSON request body');
    }
    if (error?.type === 'entity.too.large') {
      return anthropicError(res, 413, 'invalid_request_error', 'Request body is too large');
    }

    const status =
      Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
        ? error.status
        : 500;
    log.error('Unhandled request error', {
      requestId,
      status,
      error: error?.message || String(error),
    });
    return anthropicError(
      res,
      status,
      status >= 500 ? 'api_error' : 'invalid_request_error',
      status >= 500 ? 'Internal proxy error' : 'Request failed',
    );
  });

  return app;
}
