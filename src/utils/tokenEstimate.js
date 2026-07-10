const IMAGE_TOKEN_ESTIMATE = 1_600;
const MESSAGE_OVERHEAD_TOKENS = 8;
const CONTENT_BLOCK_OVERHEAD_TOKENS = 4;

function textTokens(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return 0;
  }
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 3);
}

function estimateContent(content) {
  if (typeof content === 'string') {
    return textTokens(content);
  }
  if (!Array.isArray(content)) {
    return textTokens(JSON.stringify(content ?? ''));
  }

  let tokens = 0;
  for (const block of content) {
    tokens += CONTENT_BLOCK_OVERHEAD_TOKENS;
    if (!block || typeof block !== 'object') {
      tokens += textTokens(String(block ?? ''));
    } else if (block.type === 'text') {
      tokens += textTokens(block.text);
    } else if (block.type === 'image') {
      tokens += IMAGE_TOKEN_ESTIMATE;
    } else {
      tokens += textTokens(JSON.stringify(block));
    }
  }
  return tokens;
}

export function estimateInputTokens(request) {
  let tokens = textTokens(request.model) + estimateContent(request.system);
  for (const message of request.messages || []) {
    tokens += MESSAGE_OVERHEAD_TOKENS + textTokens(message.role) + estimateContent(message.content);
  }
  if (Array.isArray(request.tools)) {
    tokens += textTokens(JSON.stringify(request.tools)) + request.tools.length * 16;
  }
  if (request.tool_choice) {
    tokens += textTokens(JSON.stringify(request.tool_choice));
  }
  return Math.max(1, tokens);
}
