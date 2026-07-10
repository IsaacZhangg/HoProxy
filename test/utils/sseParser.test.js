import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { parseSSEStream, pipeSSEStream } from '../../src/utils/sseParser.js';
import { createSseResponse } from '../helpers/sse.js';

describe('sseParser utilities', () => {
  it('parses SSE streams into events', async () => {
    const response = createSseResponse(
      'event: message\ndata: {"foo":"bar"}\n\n' + 'event: update\ndata: {"count":1}\n\n',
    );

    const events = [];
    await parseSSEStream(response, (event) => events.push(event));

    expect(events).toEqual([
      { event: 'message', data: '{"foo":"bar"}' },
      { event: 'update', data: '{"count":1}' },
    ]);
  });

  it('pipes and transforms SSE events', async () => {
    const response = createSseResponse('event: message\ndata: {"foo":"bar"}\n\n');

    const writes = [];
    const res = {
      write: (chunk) => writes.push(chunk),
    };

    await pipeSSEStream(response, res, (event) => ({
      event: 'proxy',
      data: { original: event.data },
    }));

    const output = writes.join('');
    expect(output).toContain('event: proxy');
    expect(output).toContain('data: {"original":"{\\"foo\\":\\"bar\\"}"}');
  });

  it('enforces an idle deadline on stalled upstream streams', async () => {
    const response = {
      body: new ReadableStream({
        start() {},
      }),
    };
    await expect(parseSSEStream(response, () => {}, { idleTimeoutMs: 10 })).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Upstream stream was idle for too long',
    });
  });

  it('waits for response backpressure before writing more events', async () => {
    const response = createSseResponse(
      'event: message\ndata: {"first":true}\n\n' + 'event: message\ndata: {"second":true}\n\n',
    );
    const res = new EventEmitter();
    const writes = [];
    res.writableEnded = false;
    res.destroyed = false;
    res.write = (chunk) => {
      writes.push(chunk);
      if (writes.length === 1) {
        queueMicrotask(() => res.emit('drain'));
        return false;
      }
      return true;
    };

    await pipeSSEStream(response, res, (event) => ({
      event: 'proxy',
      data: JSON.parse(event.data),
    }));
    expect(writes).toHaveLength(2);
  });
});
