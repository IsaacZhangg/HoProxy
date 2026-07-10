import { describe, expect, it } from 'vitest';
import { HopGPTToAnthropicTransformer } from '../../src/transformers/hopGPTToAnthropic.js';

const tools = [
  {
    name: 'allowed_tool',
    input_schema: {
      type: 'object',
      required: ['count'],
      additionalProperties: false,
      properties: { count: { type: 'integer' } },
    },
  },
];

function finalEvent(content) {
  return {
    event: 'message',
    data: JSON.stringify({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        content,
      },
    }),
  };
}

function transformer() {
  return new HopGPTToAnthropicTransformer('claude-sonnet-4-5', {
    toolNames: ['allowed_tool'],
    tools,
  });
}

describe('response tool policy', () => {
  it('does not emit undeclared tool names', () => {
    const instance = transformer();
    instance.transformEvent(
      finalEvent([{ type: 'tool_use', id: 'tool-1', name: 'other_tool', input: {} }]),
    );
    expect(instance.buildNonStreamingResponse().content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool_use' })]),
    );
  });

  it('coerces valid input and rejects input that remains schema-invalid', () => {
    const valid = transformer();
    valid.transformEvent(
      finalEvent([
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'allowed_tool',
          input: { count: '3' },
        },
      ]),
    );
    expect(valid.buildNonStreamingResponse().content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_use',
          name: 'allowed_tool',
          input: { count: 3 },
        }),
      ]),
    );

    const invalid = transformer();
    invalid.transformEvent(
      finalEvent([
        {
          type: 'tool_use',
          id: 'tool-2',
          name: 'allowed_tool',
          input: { count: 'not-a-number' },
        },
      ]),
    );
    expect(invalid.buildNonStreamingResponse().content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool_use' })]),
    );
  });
});
