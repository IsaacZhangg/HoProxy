export function isThinkingModel(model) {
  if (typeof model !== 'string') {
    return false;
  }
  const normalized = model.toLowerCase();
  return (
    normalized.includes('-thinking') ||
    normalized.includes('thinking') ||
    normalized.includes('opus-4.5') ||
    normalized.includes('opus-4-5')
  );
}

export function normalizeMaxTokens(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const integer = Math.floor(value);
  return integer > 0 ? integer : null;
}

export function normalizeStopSequences(value) {
  if (Array.isArray(value)) {
    return value.filter((sequence) => typeof sequence === 'string' && sequence.length > 0);
  }
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }
  return [];
}
