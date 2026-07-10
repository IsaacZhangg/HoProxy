const activeStreams = new Set();

export function registerActiveStream(controller) {
  activeStreams.add(controller);
  return () => activeStreams.delete(controller);
}

export function abortActiveStreams(reason = new Error('HoProxy is shutting down')) {
  for (const controller of activeStreams) {
    controller.abort(reason);
  }
  activeStreams.clear();
}

export function getActiveStreamCount() {
  return activeStreams.size;
}
