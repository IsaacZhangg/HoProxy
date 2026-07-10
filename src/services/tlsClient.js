import { destroyTLS, initTLS, Session } from 'node-tls-client';
import { loggers } from '../utils/logger.js';

const log = loggers.tls;

let isInitialized = false;
let initPromise = null;

const BROWSER_PROFILES = {
  firefox: 'firefox_120',
  chrome: 'chrome_120',
};

export async function ensureTLSInitialized() {
  if (isInitialized) {
    return;
  }

  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = initTLS();
  try {
    await initPromise;
    isInitialized = true;
    log.info('TLS client initialized');
  } catch (error) {
    initPromise = null;
    isInitialized = false;
    throw error;
  }
}

export async function shutdownTLS() {
  if (isInitialized) {
    await destroyTLS();
    isInitialized = false;
    initPromise = null;
    log.info('TLS client shutdown complete');
  }
}

export function createTLSSession(browserType = 'firefox') {
  const profile = BROWSER_PROFILES[browserType] || BROWSER_PROFILES.firefox;

  const session = new Session({
    clientIdentifier: profile,
    timeout: 60000,
    followRedirects: true,
    forceHttp1: false,
    randomTlsExtensionOrder: true,
  });

  return session;
}

export async function tlsFetch(options) {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    browserType = 'firefox',
    signal,
    timeoutMs = 60_000,
  } = options;

  await ensureTLSInitialized();

  const session = createTLSSession(browserType);

  try {
    const requestOptions = {
      headers,
      body: typeof body === 'object' ? JSON.stringify(body) : body,
    };

    const request = () => {
      switch (method.toUpperCase()) {
        case 'POST':
          return session.post(url, requestOptions);
        case 'GET':
          return session.get(url, requestOptions);
        case 'PUT':
          return session.put(url, requestOptions);
        case 'DELETE':
          return session.delete(url, requestOptions);
        default:
          return session.get(url, requestOptions);
      }
    };
    const response = await raceRequest(request(), {
      signal,
      timeoutMs,
      cancel: () => session.close(),
    });

    const responseBody =
      typeof response.body === 'string' ? response.body : (await response.text?.()) || '';

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: getStatusText(response.status),
      headers: response.headers || {},
      body: responseBody,
      text: async () => responseBody,
      json: async () => JSON.parse(responseBody || '{}'),
    };
  } finally {
    try {
      await session.close();
    } catch (closeError) {
      log.debug('Session close warning', { error: closeError.message });
    }
  }
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function createTimeoutError(message) {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

function raceRequest(requestPromise, { signal, timeoutMs, cancel }) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || createAbortError('Request aborted'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const cancelRequest = () => {
      Promise.resolve(cancel()).catch(() => {});
    };
    const onAbort = () => {
      cancelRequest();
      finish(reject, signal.reason || createAbortError('Request aborted'));
    };
    const timeout = setTimeout(() => {
      cancelRequest();
      finish(reject, createTimeoutError(`TLS request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(requestPromise).then(
      (response) => finish(resolve, response),
      (error) => finish(reject, error),
    );
  });
}

function getStatusText(status) {
  const statusTexts = {
    200: 'OK',
    201: 'Created',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return statusTexts[status] || 'Unknown';
}

export default { tlsFetch, createTLSSession, ensureTLSInitialized, shutdownTLS };
