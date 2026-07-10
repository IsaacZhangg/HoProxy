const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 3001,
  bodyLimit: '10mb',
  maxConcurrentMessages: 8,
  rateLimitRequests: 120,
  rateLimitWindowMs: 60_000,
  maxMessages: 1_000,
  maxTools: 128,
  maxSessionIdLength: 256,
  maxSessions: 1_000,
  maxSignatureEntries: 2_000,
  maxSignatureLength: 32_768,
  upstreamConnectTimeoutMs: 30_000,
  upstreamIdleTimeoutMs: 120_000,
  upstreamTotalTimeoutMs: 15 * 60_000,
  toolBatchIdleCloseMs: 500,
});

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function parseOrigins(value) {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isLoopbackHost(host) {
  if (typeof host !== 'string') {
    return false;
  }
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === 'localhost'
  );
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    host: env.HOST?.trim() || DEFAULTS.host,
    port: parseInteger(env.PORT, DEFAULTS.port, { min: 1, max: 65_535 }),
    apiKey: env.HOPROXY_API_KEY || null,
    corsOrigins: parseOrigins(env.HOPROXY_CORS_ORIGINS),
    debug: env.HOPGPT_DEBUG === 'true',
    readyUpstreamCheck: env.HOPROXY_READY_UPSTREAM_CHECK === 'true',
    bodyLimit: env.HOPROXY_BODY_LIMIT?.trim() || DEFAULTS.bodyLimit,
    maxConcurrentMessages: parseInteger(
      env.HOPROXY_MAX_CONCURRENT_MESSAGES,
      DEFAULTS.maxConcurrentMessages,
      { min: 1, max: 1_000 },
    ),
    rateLimitRequests: parseInteger(env.HOPROXY_RATE_LIMIT_REQUESTS, DEFAULTS.rateLimitRequests, {
      min: 1,
      max: 1_000_000,
    }),
    rateLimitWindowMs: parseInteger(env.HOPROXY_RATE_LIMIT_WINDOW_MS, DEFAULTS.rateLimitWindowMs, {
      min: 1_000,
    }),
    maxMessages: parseInteger(env.HOPROXY_MAX_MESSAGES, DEFAULTS.maxMessages, {
      min: 1,
      max: 100_000,
    }),
    maxTools: parseInteger(env.HOPROXY_MAX_TOOLS, DEFAULTS.maxTools, {
      min: 0,
      max: 10_000,
    }),
    maxSessionIdLength: parseInteger(
      env.HOPROXY_MAX_SESSION_ID_LENGTH,
      DEFAULTS.maxSessionIdLength,
      { min: 16, max: 4_096 },
    ),
    maxSessions: parseInteger(env.HOPROXY_MAX_SESSIONS, DEFAULTS.maxSessions, {
      min: 1,
      max: 1_000_000,
    }),
    maxSignatureEntries: parseInteger(
      env.HOPROXY_MAX_SIGNATURE_ENTRIES,
      DEFAULTS.maxSignatureEntries,
      { min: 1, max: 1_000_000 },
    ),
    maxSignatureLength: parseInteger(
      env.HOPROXY_MAX_SIGNATURE_LENGTH,
      DEFAULTS.maxSignatureLength,
      { min: 50, max: 10_000_000 },
    ),
    upstreamConnectTimeoutMs: parseInteger(
      env.HOPROXY_UPSTREAM_CONNECT_TIMEOUT_MS,
      DEFAULTS.upstreamConnectTimeoutMs,
      { min: 1_000 },
    ),
    upstreamIdleTimeoutMs: parseInteger(
      env.HOPROXY_UPSTREAM_IDLE_TIMEOUT_MS,
      DEFAULTS.upstreamIdleTimeoutMs,
      { min: 1_000 },
    ),
    upstreamTotalTimeoutMs: parseInteger(
      env.HOPROXY_UPSTREAM_TOTAL_TIMEOUT_MS,
      DEFAULTS.upstreamTotalTimeoutMs,
      { min: 1_000 },
    ),
    toolBatchIdleCloseMs: parseInteger(
      env.HOPGPT_TOOL_BATCH_IDLE_CLOSE_MS,
      DEFAULTS.toolBatchIdleCloseMs,
      { min: 0 },
    ),
  });
}

export function validateRuntimeSecurity(config) {
  if (!isLoopbackHost(config.host) && !config.apiKey) {
    throw new Error(
      `Refusing to bind HoProxy to non-loopback host "${config.host}" without HOPROXY_API_KEY`,
    );
  }
}

export { DEFAULTS };
