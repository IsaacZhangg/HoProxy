import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cacheThinkingSignature,
  cacheToolSignature,
  clearSignatureCacheForTests,
  getCachedToolSignature,
  getSignatureCacheSize,
} from '../../src/transformers/signatureCache.js';

describe('signature cache bounds', () => {
  beforeEach(() => {
    clearSignatureCacheForTests();
    process.env.HOPROXY_MAX_SIGNATURE_ENTRIES = '2';
  });

  afterEach(() => {
    clearSignatureCacheForTests();
    delete process.env.HOPROXY_MAX_SIGNATURE_ENTRIES;
  });

  it('evicts the least-recently-used entry at the configured cap', () => {
    cacheToolSignature('first', 'a'.repeat(50));
    cacheToolSignature('second', 'b'.repeat(50));
    expect(getCachedToolSignature('first')).toBe('a'.repeat(50));
    cacheThinkingSignature('c'.repeat(50));

    expect(getSignatureCacheSize()).toEqual({ tool: 1, thinking: 1 });
    expect(getCachedToolSignature('first')).toBe('a'.repeat(50));
    expect(getCachedToolSignature('second')).toBeNull();
  });

  it('rejects signatures above the configured length limit', () => {
    process.env.HOPROXY_MAX_SIGNATURE_LENGTH = '50';
    cacheToolSignature('oversized', 'x'.repeat(51));
    expect(getSignatureCacheSize().tool).toBe(0);
    delete process.env.HOPROXY_MAX_SIGNATURE_LENGTH;
  });
});
