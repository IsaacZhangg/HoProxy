import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig, validateRuntimeSecurity } from '../src/config.js';

function config(overrides = {}) {
  return { ...loadConfig({}), ...overrides };
}

describe('runtime boundary', () => {
  it('refuses a non-loopback bind without an API key', () => {
    expect(() => validateRuntimeSecurity(config({ host: '0.0.0.0' }))).toThrow(
      /without HOPROXY_API_KEY/,
    );
    expect(() =>
      validateRuntimeSecurity(config({ host: '0.0.0.0', apiKey: 'secret' })),
    ).not.toThrow();
  });

  it('requires the configured API key with either supported header', async () => {
    const app = createApp({ config: config({ apiKey: 'secret' }) });
    expect((await request(app).get('/v1/models')).status).toBe(401);
    expect(
      (await request(app).get('/v1/models').set('Authorization', 'Bearer secret')).status,
    ).toBe(200);
    expect((await request(app).get('/v1/models').set('X-API-Key', 'secret')).status).toBe(200);
  });

  it('enforces the configured browser-origin allowlist', async () => {
    const app = createApp({
      config: config({ corsOrigins: ['https://allowed.example'] }),
    });
    const allowed = await request(app)
      .options('/v1/messages')
      .set('Origin', 'https://allowed.example');
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://allowed.example');

    const denied = await request(app).get('/v1/models').set('Origin', 'https://denied.example');
    expect(denied.status).toBe(403);
  });

  it('hides token diagnostics unless debug mode is enabled', async () => {
    const app = createApp({ config: config({ debug: false }) });
    const response = await request(app).get('/token-debug');
    expect(response.status).toBe(404);
    expect((await request(app).get('/token-debug/')).status).toBe(404);
  });

  it('maps malformed JSON to a stable Anthropic error', async () => {
    const app = createApp({ config: config() });
    const response = await request(app)
      .post('/v1/messages')
      .set('Content-Type', 'application/json')
      .send('{"model":');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Malformed JSON request body',
      },
    });
  });

  it('returns a conservative count_tokens estimate', async () => {
    const app = createApp({ config: config() });
    const response = await request(app)
      .post('/v1/messages/count_tokens')
      .send({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'Count these input tokens.' }],
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ input_tokens: expect.any(Number) });
    expect(response.body.input_tokens).toBeGreaterThan(0);
  });

  it('separates readiness from liveness and supports an upstream check', async () => {
    const client = {
      bearerToken: 'opaque-token',
      validateAuth: () => ({ valid: true }),
      checkUpstreamReadiness: async () => ({ reachable: false, status: 503 }),
    };
    const app = createApp({
      config: config(),
      clientProvider: () => client,
    });

    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/ready')).status).toBe(200);
    const checked = await request(app).get('/ready?upstream=true');
    expect(checked.status).toBe(503);
    expect(checked.body.checks.upstream).toEqual({ reachable: false, status: 503 });
  });
});
