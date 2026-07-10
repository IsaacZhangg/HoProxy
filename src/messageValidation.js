import { loadConfig } from './config.js';

const MAX_MODEL_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_CONTENT_BLOCKS_PER_MESSAGE = 10_000;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_METADATA_KEYS = 64;
const MAX_IMAGES = 100;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateContent(content, messageIndex) {
  if (typeof content === 'string') {
    return null;
  }
  if (!Array.isArray(content)) {
    return `messages[${messageIndex}].content must be a string or array`;
  }
  if (content.length > MAX_CONTENT_BLOCKS_PER_MESSAGE) {
    return `messages[${messageIndex}].content exceeds ${MAX_CONTENT_BLOCKS_PER_MESSAGE} blocks`;
  }

  let images = 0;
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (!isObject(block) || typeof block.type !== 'string') {
      return `messages[${messageIndex}].content[${index}] must be a typed object`;
    }
    if (block.type === 'text' && typeof block.text !== 'string') {
      return `messages[${messageIndex}].content[${index}].text must be a string`;
    }
    if (block.type === 'image') {
      images += 1;
      if (!isObject(block.source) || typeof block.source.type !== 'string') {
        return `messages[${messageIndex}].content[${index}].source is required`;
      }
    }
    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || typeof block.name !== 'string') {
        return `messages[${messageIndex}].content[${index}] requires tool id and name`;
      }
      if (!isObject(block.input)) {
        return `messages[${messageIndex}].content[${index}].input must be an object`;
      }
    }
    if (block.type === 'tool_result' && typeof block.tool_use_id !== 'string') {
      return `messages[${messageIndex}].content[${index}].tool_use_id is required`;
    }
  }

  if (images > MAX_IMAGES) {
    return `messages[${messageIndex}] exceeds ${MAX_IMAGES} images`;
  }
  return null;
}

function validateTools(tools, maxTools) {
  if (tools === undefined) {
    return null;
  }
  if (!Array.isArray(tools)) {
    return 'tools must be an array';
  }
  if (tools.length > maxTools) {
    return `tools exceeds the configured limit of ${maxTools}`;
  }

  const names = new Set();
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    if (!isObject(tool)) {
      return `tools[${index}] must be an object`;
    }
    const name = tool.name || tool.function?.name || tool.custom?.name;
    const schema = tool.input_schema || tool.parameters || tool.function?.parameters;
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_TOOL_NAME_LENGTH) {
      return `tools[${index}].name must be a non-empty string of at most ${MAX_TOOL_NAME_LENGTH} characters`;
    }
    if (names.has(name)) {
      return `tools contains duplicate name "${name}"`;
    }
    names.add(name);
    if (!isObject(schema)) {
      return `tools[${index}].input_schema must be an object`;
    }
  }
  return null;
}

function validateSampling(request) {
  for (const [name, min, max] of [
    ['temperature', 0, 1],
    ['top_p', 0, 1],
  ]) {
    const value = request[name];
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      return `${name} must be a finite number between ${min} and ${max}`;
    }
  }
  if (request.top_k !== undefined && (!Number.isInteger(request.top_k) || request.top_k < 0)) {
    return 'top_k must be a non-negative integer';
  }
  return null;
}

function validateMetadata(metadata, maxSessionIdLength) {
  if (metadata === undefined) {
    return null;
  }
  if (!isObject(metadata)) {
    return 'metadata must be an object';
  }
  if (Object.keys(metadata).length > MAX_METADATA_KEYS) {
    return `metadata exceeds ${MAX_METADATA_KEYS} keys`;
  }
  if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
    return `metadata exceeds ${MAX_METADATA_BYTES} bytes`;
  }

  for (const key of ['session_id', 'sessionId', 'conversation_id', 'conversationId']) {
    const value = metadata[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > maxSessionIdLength)) {
      return `metadata.${key} must be a string of at most ${maxSessionIdLength} characters`;
    }
  }
  return null;
}

export function validateMessagesRequest(request, config = loadConfig()) {
  if (!isObject(request)) {
    return 'request body must be a JSON object';
  }
  if (
    typeof request.model !== 'string' ||
    !request.model.trim() ||
    request.model.length > MAX_MODEL_LENGTH
  ) {
    return `model must be a non-empty string of at most ${MAX_MODEL_LENGTH} characters`;
  }
  if (
    !Number.isInteger(request.max_tokens) ||
    request.max_tokens <= 0 ||
    request.max_tokens > 1_000_000
  ) {
    return 'max_tokens must be an integer between 1 and 1000000';
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return 'messages must be a non-empty array';
  }
  if (request.messages.length > config.maxMessages) {
    return `messages exceeds the configured limit of ${config.maxMessages}`;
  }

  for (let index = 0; index < request.messages.length; index += 1) {
    const message = request.messages[index];
    if (!isObject(message)) {
      return `messages[${index}] must be an object`;
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      return `messages[${index}].role must be 'user' or 'assistant'`;
    }
    if (message.content === undefined || message.content === null) {
      return `messages[${index}].content is required`;
    }
    const contentError = validateContent(message.content, index);
    if (contentError) {
      return contentError;
    }
  }

  return (
    validateTools(request.tools, config.maxTools) ||
    validateSampling(request) ||
    validateMetadata(request.metadata, config.maxSessionIdLength)
  );
}

export function validateSessionHeaders(req, config = loadConfig()) {
  for (const name of ['x-session-id', 'x-sessionid', 'x-hoproxy-client-id']) {
    const value = req.get(name);
    if (value && value.length > config.maxSessionIdLength) {
      return `${name} exceeds the configured limit of ${config.maxSessionIdLength} characters`;
    }
  }
  return null;
}
