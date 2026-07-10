#!/usr/bin/env bun
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig, validateRuntimeSecurity } from './config.js';
import { abortActiveStreams } from './services/activeStreams.js';
import { getDefaultClient, getTokenExpiryInfo } from './services/hopgptClient.js';
import { shutdownTLS } from './services/tlsClient.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('Server');

function maskToken(token) {
  if (!token) return '<not set>';
  if (token.length <= 24) return '<too short to mask>';
  return `${token.substring(0, 10)}...${token.substring(token.length - 10)}`;
}

function logStartupTokenDiagnostics() {
  const client = getDefaultClient();
  const envPath = path.join(process.cwd(), '.env');

  log.info('=== Token Diagnostics on Startup ===');

  const bearerToken = client.bearerToken;
  const bearerInfo = getTokenExpiryInfo(bearerToken);
  if (bearerToken) {
    log.info('Bearer token', {
      present: true,
      masked: maskToken(bearerToken),
      isValidJWT: !!bearerInfo,
      expiresIn: bearerInfo ? `${Math.round(bearerInfo.expiresInSeconds / 60)}min` : 'N/A',
      isExpired: bearerInfo?.isExpired ?? 'unknown',
    });
  } else {
    log.warn('Bearer token: NOT SET (will attempt refresh on first request)');
  }

  const refreshToken = client.cookies?.refreshToken;
  const openidId = client.cookies?.openid_user_id;
  const sid = client.cookies?.connect_sid;
  const hasSessionRefresh = Boolean(sid && openidId);
  const hasRefreshCredential =
    typeof client.hasRefreshCredential === 'function'
      ? client.hasRefreshCredential()
      : Boolean(refreshToken || hasSessionRefresh);

  if (hasRefreshCredential) {
    log.info('Refresh credential', {
      kind:
        typeof client.getRefreshCredentialKind === 'function'
          ? client.getRefreshCredentialKind()
          : refreshToken
            ? 'refreshToken'
            : 'session',
    });
  } else {
    log.error('Refresh credential: NOT SET — automatic refresh will fail (run: bun run extract)');
  }

  if (refreshToken) {
    log.info('Refresh token cookie', {
      present: true,
      masked: maskToken(refreshToken),
      length: refreshToken.length,
    });
  } else {
    log.info('Refresh token cookie: NOT SET (normal for current HopGPT sessions)');
  }

  const openidInfo = getTokenExpiryInfo(openidId);
  if (openidId) {
    log.info('OpenID user cookie (openid_user_id)', {
      present: true,
      masked: maskToken(openidId),
      isValidJWT: !!openidInfo,
      expiresIn: openidInfo ? `${Math.round(openidInfo.expiresInSeconds / 3600)}h` : 'N/A',
      isExpired: openidInfo?.isExpired ?? 'unknown',
    });
    if (openidInfo?.isExpired) {
      log.warn(
        'OpenID user cookie is expired — re-authentication may be required (run: bun run extract)',
      );
    }
  } else {
    log.warn(
      'OpenID user cookie (openid_user_id): NOT SET — cookie context may be incomplete (run: bun run extract)',
    );
  }

  if (sid) {
    log.info('Session cookie (connect.sid)', {
      present: true,
      masked: maskToken(sid),
      length: sid.length,
    });
  } else {
    log.warn('Session cookie (connect.sid): NOT SET — auth may be rejected (run: bun run extract)');
  }

  try {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const envRefreshMatch = envContent.match(/^HOPGPT_COOKIE_REFRESH_TOKEN=(.+)$/m);
      const envRefreshToken = envRefreshMatch ? envRefreshMatch[1].trim() : null;
      const envOpenidMatch = envContent.match(/^HOPGPT_COOKIE_OPENID_USER_ID=(.+)$/m);
      const envOpenidId = envOpenidMatch ? envOpenidMatch[1].trim() : null;
      const envSidMatch = envContent.match(/^HOPGPT_COOKIE_CONNECT_SID=(.+)$/m);
      const envSid = envSidMatch ? envSidMatch[1].trim() : null;

      if (envRefreshToken && refreshToken && envRefreshToken !== refreshToken) {
        log.debug('.env refresh token differs from memory — will be reconciled on next refresh');
      }
      if (envOpenidId && openidId && envOpenidId !== openidId) {
        log.debug(
          '.env OpenID user cookie differs from memory — will be reconciled on next refresh',
        );
      }
      if (envSid && sid && envSid !== sid) {
        log.debug('.env session cookie differs from memory — will be reconciled on next refresh');
      }
    }
  } catch (err) {
    log.debug('Could not verify .env file', { error: err.message });
  }

  const cfClearance = client.cookies?.cf_clearance;
  const cfBm = client.cookies?.__cf_bm;
  if (!cfClearance || !cfBm) {
    log.warn('Cloudflare cookies missing', {
      cf_clearance: cfClearance ? 'set' : 'NOT SET',
      __cf_bm: cfBm ? 'set' : 'NOT SET',
      note: 'This may cause Cloudflare blocks, but TLS fingerprinting should help bypass',
    });
  }

  log.info('=== End Token Diagnostics ===');
}

export async function gracefulShutdown(server, signal = 'shutdown') {
  log.info('Graceful shutdown started', { signal });
  abortActiveStreams(new Error(`HoProxy received ${signal}`));
  server.closeIdleConnections?.();

  const closeServer = new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(resolve);
  });
  const forceTimeout = new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 10_000);
    timer.unref?.();
  });

  await Promise.race([closeServer, forceTimeout]);
  await shutdownTLS();
  log.info('Graceful shutdown complete');
}

export function startServer({
  config = loadConfig(),
  diagnostics = true,
  installSignalHandlers = true,
} = {}) {
  validateRuntimeSecurity(config);
  const app = createApp({ config });
  const server = app.listen(config.port, config.host, () => {
    log.info('Server started', { host: config.host, port: config.port });

    if (diagnostics) {
      logStartupTokenDiagnostics();
    }

    console.log(`
╔════════════════════════════════════════════════════════════╗
║          HopGPT Anthropic API Proxy                        ║
╠════════════════════════════════════════════════════════════╣
║  Server running on http://${config.host}:${config.port}
║                                                            ║
║  Endpoints:                                                ║
║    POST /v1/messages  - Anthropic Messages API             ║
║    GET  /v1/models    - List available models              ║
║    POST /refresh-token - Refresh HopGPT session token      ║
║    GET  /token-status  - Check token expiry status         ║
║    GET  /token-debug   - Detailed token diagnostics        ║
║    GET  /health       - Health check                       ║
║                                                            ║
║  Usage with Anthropic SDK:                                 ║
║    export ANTHROPIC_BASE_URL=http://${config.host}:${config.port}
╚════════════════════════════════════════════════════════════╝
  `);
  });

  if (installSignalHandlers) {
    let shuttingDown = false;
    const handleSignal = (signal) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      void gracefulShutdown(server, signal).catch((error) => {
        log.error('Graceful shutdown failed', { error: error.message });
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
  }

  return { app, server, config };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    startServer();
  } catch (error) {
    log.error('HoProxy failed to start', { error: error.message });
    process.exitCode = 1;
  }
}
