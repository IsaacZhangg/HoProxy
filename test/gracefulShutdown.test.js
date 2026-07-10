import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { gracefulShutdown } from '../src/index.js';
import { registerActiveStream } from '../src/services/activeStreams.js';

describe('graceful shutdown', () => {
  it('aborts active streams and closes the listener', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const controller = new AbortController();
    registerActiveStream(controller);

    await gracefulShutdown(server, 'test');

    expect(controller.signal.aborted).toBe(true);
    expect(server.listening).toBe(false);
  });
});
