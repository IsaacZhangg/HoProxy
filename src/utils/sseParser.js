import { createParser } from 'eventsource-parser';
import { loggers } from './logger.js';

const log = loggers.transform;

export async function parseSSEStream(response, onEvent, options = {}) {
  const pendingEvents = [];
  let sawFirstByte = false;
  const parser = createParser({
    onEvent(event) {
      pendingEvents.push({
        event: event.event || 'message',
        data: event.data,
      });
    },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = resolveDeadline(options.totalTimeoutMs);

  try {
    while (true) {
      const { done, value } = await readWithDeadline(reader, {
        signal: options.signal,
        idleTimeoutMs: options.idleTimeoutMs,
        deadline,
      });
      if (done) break;

      if (!sawFirstByte) {
        sawFirstByte = true;
        options.onFirstByte?.();
      }
      const chunk = decoder.decode(value, { stream: true });
      parser.feed(chunk);
      while (pendingEvents.length > 0) {
        await onEvent(pendingEvents.shift());
      }
    }
  } finally {
    if (options.signal?.aborted) {
      await reader.cancel(options.signal.reason).catch(() => {});
    }
    reader.releaseLock();
  }
}

export async function pipeSSEStream(fetchResponse, res, transformEvent, signal, options = {}) {
  const {
    autoEndOnMessageStop = false,
    onToolUseIdle = null,
    toolUseIdleCloseMs = null,
    idleTimeoutMs = null,
    totalTimeoutMs = null,
    onFirstByte = null,
    onToolClose = null,
  } = options;
  let stoppedOnMessageStop = false;
  let toolUseIdleTimer = null;
  const pendingEvents = [];
  const toolIndexes = new Set();
  let sawToolActivity = false;
  let sawFirstByte = false;

  const parser = createParser({
    onEvent(event) {
      if (stoppedOnMessageStop) {
        return;
      }
      const parsedEvent = {
        event: event.event || 'message',
        data: event.data,
      };

      const events = normalizeEvents(transformEvent(parsedEvent));
      for (const evt of events) {
        pendingEvents.push(evt);
      }
    },
  });

  const reader = fetchResponse.body.getReader();
  const decoder = new TextDecoder();
  const deadline = resolveDeadline(totalTimeoutMs);

  function clearToolUseIdleTimer() {
    if (toolUseIdleTimer) {
      clearTimeout(toolUseIdleTimer);
      toolUseIdleTimer = null;
    }
  }

  function scheduleToolUseIdleClose() {
    if (
      typeof onToolUseIdle !== 'function' ||
      !Number.isFinite(toolUseIdleCloseMs) ||
      toolUseIdleCloseMs < 0
    ) {
      return;
    }

    clearToolUseIdleTimer();
    toolUseIdleTimer = setTimeout(() => {
      toolUseIdleTimer = null;
      if (stoppedOnMessageStop || signal?.aborted || !isResponseWritable(res)) {
        return;
      }

      const events = normalizeEvents(onToolUseIdle());
      onToolClose?.();
      void flushEvents(events).then(() => {
        if (stoppedOnMessageStop) {
          reader.cancel().catch((error) => {
            log.debug('Failed to cancel upstream reader after tool-use idle close', {
              error: error.message,
            });
          });
        }
      });
    }, toolUseIdleCloseMs);
    toolUseIdleTimer.unref?.();
  }

  async function flushEvents(events) {
    for (const evt of events) {
      if (!isResponseWritable(res)) {
        return;
      }
      if (evt.event === 'message_start') {
        log.debug('Streaming message_start', {
          model: evt.data?.message?.model,
          messageId: evt.data?.message?.id,
        });
      }

      await writeEvent(res, evt);
      if (isToolUseStartEvent(evt)) {
        toolIndexes.add(evt.data?.index);
        sawToolActivity = true;
      } else if (isToolUseDeltaEvent(evt, toolIndexes)) {
        sawToolActivity = true;
      } else if (isToolUseStopEvent(evt, toolIndexes)) {
        toolIndexes.delete(evt.data?.index);
        sawToolActivity = true;
      }
      if (autoEndOnMessageStop && isMessageStopEvent(evt)) {
        if (toolIndexes.size > 0) {
          onToolClose?.();
        }
        clearToolUseIdleTimer();
        stoppedOnMessageStop = true;
        return;
      }
    }

    if (sawToolActivity && !stoppedOnMessageStop) {
      sawToolActivity = false;
      scheduleToolUseIdleClose();
    }
  }

  try {
    while (true) {
      if (signal?.aborted) {
        clearToolUseIdleTimer();
        await reader.cancel();
        break;
      }

      const { done, value } = await readWithDeadline(reader, {
        signal,
        idleTimeoutMs,
        deadline,
      });
      if (done) break;

      if (!sawFirstByte) {
        sawFirstByte = true;
        onFirstByte?.();
      }
      const chunk = decoder.decode(value, { stream: true });
      parser.feed(chunk);
      await flushEvents(pendingEvents.splice(0));
      if (stoppedOnMessageStop) {
        clearToolUseIdleTimer();
        await reader.cancel();
        break;
      }
    }
  } finally {
    clearToolUseIdleTimer();
    reader.releaseLock();
  }

  return { stoppedOnMessageStop };
}

function normalizeEvents(events) {
  if (!events) {
    return [];
  }
  return Array.isArray(events) ? events : [events];
}

function isResponseWritable(res) {
  return !res.writableEnded && !res.destroyed;
}

async function writeEvent(res, evt) {
  const payload = `event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`;
  if (!res.write(payload)) {
    await waitForDrain(res);
  }
  if (typeof res.flush === 'function') {
    res.flush();
  }
}

function waitForDrain(res) {
  return new Promise((resolve) => {
    const cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

function isToolUseStartEvent(evt) {
  return evt.event === 'content_block_start' && evt.data?.content_block?.type === 'tool_use';
}

function isToolUseDeltaEvent(evt, toolIndexes) {
  return (
    evt.event === 'content_block_delta' &&
    toolIndexes.has(evt.data?.index) &&
    evt.data?.delta?.type === 'input_json_delta'
  );
}

function isToolUseStopEvent(evt, toolIndexes) {
  return evt.event === 'content_block_stop' && toolIndexes.has(evt.data?.index);
}

function isMessageStopEvent(evt) {
  return evt.event === 'message_stop';
}

function resolveDeadline(totalTimeoutMs) {
  return Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : null;
}

async function readWithDeadline(reader, { signal, idleTimeoutMs, deadline }) {
  if (signal?.aborted) {
    await reader.cancel(signal.reason).catch(() => {});
    return { done: true, value: undefined };
  }

  const totalRemaining = deadline === null ? null : deadline - Date.now();
  if (totalRemaining !== null && totalRemaining <= 0) {
    await reader.cancel('Upstream total timeout').catch(() => {});
    throw createTimeoutError('Upstream stream exceeded its total deadline');
  }
  const timeoutMs = minimumPositive(idleTimeoutMs, totalRemaining);
  if (timeoutMs === null) {
    return reader.read();
  }

  let timer;
  let onAbort;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = createTimeoutError(
            totalRemaining !== null && totalRemaining <= timeoutMs
              ? 'Upstream stream exceeded its total deadline'
              : 'Upstream stream was idle for too long',
          );
          reject(error);
          reader.cancel(error).catch(() => {});
        }, timeoutMs);
        timer.unref?.();
      }),
      ...(signal
        ? [
            new Promise((resolve) => {
              onAbort = () => {
                reader.cancel(signal.reason).catch(() => {});
                resolve({ done: true, value: undefined });
              };
              signal.addEventListener('abort', onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function minimumPositive(...values) {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0);
  return positive.length > 0 ? Math.min(...positive) : null;
}

function createTimeoutError(message) {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

export async function collectSSEEvents(response) {
  const events = [];

  await parseSSEStream(response, (event) => {
    events.push(event);
  });

  return events;
}
