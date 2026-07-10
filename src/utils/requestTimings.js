import { performance } from 'node:perf_hooks';

export function createRequestTimings(log, requestId) {
  const startedAt = performance.now();
  const phases = {};
  let finished = false;

  return {
    mark(phase) {
      if (!(phase in phases)) {
        phases[phase] = Math.round(performance.now() - startedAt);
      }
    },
    finish(outcome) {
      if (finished) {
        return;
      }
      finished = true;
      log.info('Request phase timings', {
        requestId,
        outcome,
        totalMs: Math.round(performance.now() - startedAt),
        phases,
      });
    },
  };
}
