import { describe, expect, it } from 'vitest';
import { coerceAndValidateToolInput } from '../../src/transformers/toolInput.js';

describe('tool input schema enforcement', () => {
  const schema = {
    type: 'object',
    required: ['count', 'enabled'],
    additionalProperties: false,
    properties: {
      count: { type: 'integer' },
      enabled: { type: 'boolean' },
    },
  };

  it('coerces safe primitive strings before validation', () => {
    expect(coerceAndValidateToolInput({ count: '3', enabled: 'true' }, schema)).toEqual({
      valid: true,
      input: { count: 3, enabled: true },
      error: null,
    });
  });

  it('rejects missing and undeclared properties', () => {
    expect(coerceAndValidateToolInput({ count: 3 }, schema)).toMatchObject({
      valid: false,
      error: 'input.enabled is required',
    });
    expect(
      coerceAndValidateToolInput({ count: 3, enabled: true, extra: 'no' }, schema),
    ).toMatchObject({
      valid: false,
      error: 'input.extra is not allowed',
    });
  });
});
