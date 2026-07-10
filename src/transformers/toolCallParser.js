import { randomUUID } from 'node:crypto';

export function normalizeToolNameToken(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
}

export function generateToolUseId() {
  return `toolu_01${randomUUID().replace(/-/g, '').slice(0, 22)}`;
}

export function parseStructuredToolCall(jsonContent) {
  if (typeof jsonContent !== 'string' || !jsonContent.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonContent);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string') {
      return null;
    }
    let input = parsed.parameters ?? parsed.arguments ?? parsed.input ?? {};
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch (_error) {
        return null;
      }
    }
    return {
      toolName: parsed.name,
      arguments: input,
      toolUseId: parsed.id || parsed.toolUseId || null,
    };
  } catch (_error) {
    return null;
  }
}
