import { randomUUID } from 'node:crypto';

export function createInitialStreamState({ warningThreshold }) {
  return {
    messageId: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    hasStarted: false,
    inputTokens: 0,
    outputTokens: 0,
    conversationId: null,
    responseMessageId: null,
    currentBlockIndex: -1,
    currentBlockType: null,
    blockStarted: false,
    hasEmittedNonThinkingContent: false,
    contentBlocks: [],
    accumulatedText: '',
    accumulatedThinking: '',
    thinkingSignature: null,
    mcpToolCallBuffer: '',
    _toolBufferWarningEmitted: false,
    _nextToolBufferWarningAt: warningThreshold,
    currentToolUse: null,
    accumulatedToolUses: [],
    hasToolUse: false,
    _stopRequested: false,
    _suppressOutput: false,
    _textSanitizeBuffer: '',
    _toolLeakActive: false,
    _lastTextChunk: null,
    suppressedThinkingText: '',
    hopGPTStopReason: null,
    hopGPTStopSequence: null,
  };
}
