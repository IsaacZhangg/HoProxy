const DEFAULT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_SIGNATURE_LENGTH = 32_768;
export const MIN_SIGNATURE_LENGTH = 50;

const toolSignatureCache = new Map();
const thinkingSignatureCache = new Map();

function resolveCacheTtlMs() {
  const configured = Number.parseInt(process.env.SIGNATURE_CACHE_TTL_MS, 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_CACHE_TTL_MS;
}

function resolveMaxEntries() {
  const configured = Number.parseInt(process.env.HOPROXY_MAX_SIGNATURE_ENTRIES, 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_ENTRIES;
}

function resolveMaxSignatureLength() {
  const configured = Number.parseInt(process.env.HOPROXY_MAX_SIGNATURE_LENGTH, 10);
  return Number.isFinite(configured) && configured >= MIN_SIGNATURE_LENGTH
    ? configured
    : DEFAULT_MAX_SIGNATURE_LENGTH;
}

function isValidSignature(signature) {
  return (
    typeof signature === 'string' &&
    signature.length >= MIN_SIGNATURE_LENGTH &&
    signature.length <= resolveMaxSignatureLength()
  );
}

function cleanupExpired(cache, now = Date.now()) {
  for (const [key, entry] of cache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function enforceCacheLimit() {
  const maxEntries = resolveMaxEntries();
  while (toolSignatureCache.size + thinkingSignatureCache.size > maxEntries) {
    const oldestTool = toolSignatureCache.entries().next().value;
    const oldestThinking = thinkingSignatureCache.entries().next().value;
    if (!oldestTool) {
      thinkingSignatureCache.delete(oldestThinking[0]);
    } else if (!oldestThinking) {
      toolSignatureCache.delete(oldestTool[0]);
    } else if (oldestTool[1].touchedAt <= oldestThinking[1].touchedAt) {
      toolSignatureCache.delete(oldestTool[0]);
    } else {
      thinkingSignatureCache.delete(oldestThinking[0]);
    }
  }
}

export function cacheToolSignature(toolUseId, signature) {
  if (typeof toolUseId !== 'string' || toolUseId.length > 1_024 || !isValidSignature(signature)) {
    return;
  }
  cleanupExpired(toolSignatureCache);
  const ttlMs = resolveCacheTtlMs();
  const now = Date.now();
  toolSignatureCache.delete(toolUseId);
  toolSignatureCache.set(toolUseId, {
    signature,
    expiresAt: now + ttlMs,
    touchedAt: now,
  });
  enforceCacheLimit();
}

export function getCachedToolSignature(toolUseId) {
  if (!toolUseId) {
    return null;
  }
  const entry = toolSignatureCache.get(toolUseId);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    toolSignatureCache.delete(toolUseId);
    return null;
  }
  entry.touchedAt = Date.now();
  toolSignatureCache.delete(toolUseId);
  toolSignatureCache.set(toolUseId, entry);
  return entry.signature;
}

export function cacheThinkingSignature(signature, family = 'claude') {
  if (!isValidSignature(signature)) {
    return;
  }
  cleanupExpired(thinkingSignatureCache);
  const ttlMs = resolveCacheTtlMs();
  const now = Date.now();
  thinkingSignatureCache.delete(signature);
  thinkingSignatureCache.set(signature, {
    family,
    expiresAt: now + ttlMs,
    touchedAt: now,
  });
  enforceCacheLimit();
}

export function getCachedThinkingSignatureFamily(signature) {
  if (!signature) {
    return null;
  }
  const entry = thinkingSignatureCache.get(signature);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    thinkingSignatureCache.delete(signature);
    return null;
  }
  entry.touchedAt = Date.now();
  thinkingSignatureCache.delete(signature);
  thinkingSignatureCache.set(signature, entry);
  return entry.family || null;
}

export function cleanupSignatureCache() {
  const now = Date.now();
  cleanupExpired(toolSignatureCache, now);
  cleanupExpired(thinkingSignatureCache, now);
}

export function getSignatureCacheSize() {
  cleanupSignatureCache();
  return {
    tool: toolSignatureCache.size,
    thinking: thinkingSignatureCache.size,
  };
}

export function clearSignatureCacheForTests() {
  toolSignatureCache.clear();
  thinkingSignatureCache.clear();
}

const cleanupTimer = setInterval(cleanupSignatureCache, 60_000);
cleanupTimer.unref?.();
