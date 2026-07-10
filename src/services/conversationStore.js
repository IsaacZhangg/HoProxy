import { createHash, randomUUID } from 'node:crypto';
import { loggers } from '../utils/logger.js';

const log = loggers.session;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TRANSCRIPT_ALIASES_PER_SESSION = 32;
const DEFAULT_MAX_SESSIONS = 1_000;
const DEFAULT_MAX_STATE_VALUE_LENGTH = 262_144;

const sessionStore = new Map();
const transcriptIndex = new Map();
const transcriptAliasesBySession = new Map();

function normalizeId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStateValue(value) {
  const normalized = normalizeId(value);
  if (!normalized) {
    return null;
  }
  const maxLength = getMaxStateValueLength();
  return normalized.length <= maxLength ? normalized : null;
}

function getTtlMs() {
  const configured = Number.parseInt(process.env.CONVERSATION_TTL_MS, 10);
  const isValidTtl = Number.isFinite(configured) && configured > 0;

  return isValidTtl ? configured : DEFAULT_TTL_MS;
}

function getTranscriptAliasesPerSessionLimit() {
  const configured = Number.parseInt(process.env.TRANSCRIPT_ALIASES_PER_SESSION, 10);
  const isValidLimit = Number.isFinite(configured) && configured > 0;

  return isValidLimit ? configured : DEFAULT_TRANSCRIPT_ALIASES_PER_SESSION;
}

function getMaxSessions() {
  const configured = Number.parseInt(process.env.HOPROXY_MAX_SESSIONS, 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_SESSIONS;
}

function getMaxStateValueLength() {
  const configured = Number.parseInt(process.env.HOPROXY_MAX_STATE_VALUE_LENGTH, 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_STATE_VALUE_LENGTH;
}

function cleanupExpiredSessions(now = Date.now()) {
  const ttlMs = getTtlMs();
  let expiredCount = 0;
  for (const [sessionId, entry] of sessionStore.entries()) {
    if (now - entry.lastTouchedAt > ttlMs) {
      sessionStore.delete(sessionId);
      removeTranscriptAliasesForSession(sessionId);
      expiredCount++;
    }
  }
  if (expiredCount > 0) {
    log.debug(`Cleaned up ${expiredCount} expired sessions`, { remaining: sessionStore.size });
  }
}

function enforceSessionLimit() {
  const maxSessions = getMaxSessions();
  while (sessionStore.size > maxSessions) {
    let oldestSessionId = null;
    let oldestTouchedAt = Number.POSITIVE_INFINITY;
    for (const [sessionId, entry] of sessionStore) {
      if (entry.lastTouchedAt < oldestTouchedAt) {
        oldestSessionId = sessionId;
        oldestTouchedAt = entry.lastTouchedAt;
      }
    }
    if (!oldestSessionId) {
      break;
    }
    sessionStore.delete(oldestSessionId);
    removeTranscriptAliasesForSession(oldestSessionId);
  }
}

const cleanupTimer = setInterval(cleanupExpiredSessions, 60_000);
cleanupTimer.unref?.();

function removeTranscriptAliasesForSession(sessionId) {
  const aliases = transcriptAliasesBySession.get(sessionId);
  if (aliases) {
    for (const key of aliases) {
      const sessions = transcriptIndex.get(key);
      sessions?.delete(sessionId);
      if (sessions?.size === 0) {
        transcriptIndex.delete(key);
      }
    }
    transcriptAliasesBySession.delete(sessionId);
    return;
  }

  for (const [key, indexedSessionIds] of transcriptIndex.entries()) {
    indexedSessionIds.delete(sessionId);
    if (indexedSessionIds.size === 0) {
      transcriptIndex.delete(key);
    }
  }
}

function indexTranscriptAlias(sessionId, transcriptKey) {
  let aliases = transcriptAliasesBySession.get(sessionId);
  if (!aliases) {
    aliases = new Set();
    transcriptAliasesBySession.set(sessionId, aliases);
  }

  if (aliases.has(transcriptKey)) {
    aliases.delete(transcriptKey);
  }
  aliases.add(transcriptKey);
  let indexedSessionIds = transcriptIndex.get(transcriptKey);
  if (!indexedSessionIds) {
    indexedSessionIds = new Set();
    transcriptIndex.set(transcriptKey, indexedSessionIds);
  }
  indexedSessionIds.add(sessionId);

  const maxAliases = getTranscriptAliasesPerSessionLimit();
  while (aliases.size > maxAliases) {
    const oldestKey = aliases.values().next().value;
    aliases.delete(oldestKey);
    const sessions = transcriptIndex.get(oldestKey);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) {
      transcriptIndex.delete(oldestKey);
    }
  }
}

function extractSessionIdFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  return (
    normalizeId(metadata.session_id) ||
    normalizeId(metadata.sessionId) ||
    normalizeId(metadata.conversation_id) ||
    normalizeId(metadata.conversationId)
  );
}

function stableNormalize(value) {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stableNormalize(item));
  }

  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = stableNormalize(value[key]);
  }
  return normalized;
}

function normalizeContentBlocks(content) {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    if (block.type === 'thinking') {
      continue;
    }

    if (block.type === 'text') {
      blocks.push({ type: 'text', text: String(block.text ?? '') });
      continue;
    }

    if (block.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: normalizeId(block.id),
        name: normalizeId(block.name),
        input: stableNormalize(block.input ?? {}),
      });
      continue;
    }

    if (block.type === 'tool_result') {
      const normalizedContent =
        typeof block.content === 'string' || Array.isArray(block.content)
          ? normalizeContentBlocks(block.content)
          : stableNormalize(block.content ?? null);
      blocks.push({
        type: 'tool_result',
        tool_use_id: normalizeId(block.tool_use_id),
        is_error: block.is_error === true,
        content: stableNormalize(normalizedContent),
      });
      continue;
    }

    blocks.push(stableNormalize(block));
  }

  return blocks;
}

function normalizeSystemPrompt(system) {
  if (typeof system === 'string') {
    const trimmed = system.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(system)) {
    return null;
  }

  const text = system
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const role = message.role === 'model' ? 'assistant' : message.role;
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }

  return {
    role,
    content: normalizeContentBlocks(message.content),
  };
}

function buildTranscriptKey(requestBody, messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  const normalizedMessages = messages.map((message) => normalizeMessage(message)).filter(Boolean);
  if (normalizedMessages.length === 0) {
    return null;
  }

  const payload = stableNormalize({
    version: 1,
    model: normalizeId(requestBody?.model),
    system: normalizeSystemPrompt(requestBody?.system),
    messages: normalizedMessages,
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function buildContinuationLookupKey(requestBody) {
  const messages = requestBody?.messages;
  if (!Array.isArray(messages) || messages.length < 3) {
    return null;
  }

  const latestMessage = normalizeMessage(messages[messages.length - 1]);
  if (latestMessage?.role !== 'user') {
    return null;
  }

  const prefixMessages = messages.slice(0, -1);
  const lastPrefixMessage = normalizeMessage(prefixMessages[prefixMessages.length - 1]);
  if (lastPrefixMessage?.role !== 'assistant') {
    return null;
  }

  return buildTranscriptKey(requestBody, prefixMessages);
}

function resolveClientNamespace(req) {
  const explicitClientId = normalizeId(req.get('x-hoproxy-client-id'));
  const source =
    explicitClientId ||
    [
      req.ip || req.socket?.remoteAddress || 'local',
      req.get('user-agent') || 'unknown-agent',
      req.get('anthropic-version') || 'unknown-version',
    ].join('|');
  return createHash('sha256').update(source).digest('hex');
}

function namespacedTranscriptKey(clientNamespace, transcriptKey) {
  return `${clientNamespace}:${transcriptKey}`;
}

function resolveSessionIdFromTranscript(requestBody, clientNamespace) {
  const transcriptKey = buildContinuationLookupKey(requestBody);
  if (!transcriptKey) {
    return null;
  }

  cleanupExpiredSessions();
  const indexKey = namespacedTranscriptKey(clientNamespace, transcriptKey);
  const legacyIndexKey = namespacedTranscriptKey('default', transcriptKey);
  const resolvedIndexKey = transcriptIndex.has(indexKey) ? indexKey : legacyIndexKey;
  const candidates = transcriptIndex.get(resolvedIndexKey);
  if (!candidates) {
    return null;
  }

  for (const sessionId of candidates) {
    if (!sessionStore.has(sessionId)) {
      candidates.delete(sessionId);
    }
  }
  if (candidates.size === 0) {
    transcriptIndex.delete(resolvedIndexKey);
    return null;
  }
  if (candidates.size > 1) {
    log.warn('Transcript matched multiple sessions; creating a new isolated session', {
      matches: candidates.size,
    });
    return null;
  }

  const sessionId = candidates.values().next().value;

  log.debug('Using transcript-matched session ID', {
    sessionId: `${sessionId.slice(0, 8)}...`,
  });
  return sessionId;
}

export function resolveSessionId(req, requestBody, options = {}) {
  const clientNamespace = resolveClientNamespace(req);
  const headerSessionId =
    normalizeId(req.get('x-session-id')) || normalizeId(req.get('x-sessionid'));
  const metadataSessionId = extractSessionIdFromMetadata(requestBody?.metadata);
  const explicitSessionId = headerSessionId || metadataSessionId;

  if (explicitSessionId) {
    log.debug('Using provided session ID', { sessionId: `${explicitSessionId.slice(0, 8)}...` });
    return { sessionId: explicitSessionId, isGenerated: false, clientNamespace };
  }

  if (options.allowTranscriptMatch !== false) {
    const transcriptSessionId = resolveSessionIdFromTranscript(requestBody, clientNamespace);
    if (transcriptSessionId) {
      return { sessionId: transcriptSessionId, isGenerated: false, clientNamespace };
    }
  }

  const newSessionId = randomUUID();
  log.debug('Generated new session ID', { sessionId: `${newSessionId.slice(0, 8)}...` });
  return { sessionId: newSessionId, isGenerated: true, clientNamespace };
}

export function shouldResetConversation(req, requestBody) {
  const headerReset = normalizeId(req.get('x-conversation-reset'));
  if (headerReset && headerReset.toLowerCase() === 'true') {
    return true;
  }

  const metadata = requestBody?.metadata;
  if (!metadata) {
    return false;
  }

  return (
    metadata.conversation_reset === true ||
    metadata.reset === true ||
    metadata.new_conversation === true
  );
}

export function getConversationState(sessionId) {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  cleanupExpiredSessions();

  const entry = sessionStore.get(normalizedSessionId);
  if (!entry) {
    log.debug('No existing conversation state', {
      sessionId: `${normalizedSessionId.slice(0, 8)}...`,
    });
    return null;
  }

  entry.lastTouchedAt = Date.now();
  log.debug('Retrieved conversation state', {
    sessionId: `${normalizedSessionId.slice(0, 8)}...`,
    hasConversationId: !!entry.conversationId,
    hasLastMessageId: !!entry.lastAssistantMessageId,
  });
  return {
    conversationId: entry.conversationId || null,
    lastAssistantMessageId: entry.lastAssistantMessageId || null,
    systemPrompt: entry.systemPrompt || null,
    toolPromptHash: entry.toolPromptHash || null,
  };
}

export function updateConversationState(sessionId, state) {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId || !state) {
    return;
  }

  cleanupExpiredSessions();

  const now = Date.now();
  const isNew = !sessionStore.has(normalizedSessionId);
  const entry = sessionStore.get(normalizedSessionId) || { createdAt: now };
  const conversationId = normalizeStateValue(state.conversationId);
  const lastAssistantMessageId = normalizeStateValue(state.lastAssistantMessageId);
  const systemPrompt = normalizeStateValue(state.systemPrompt);
  const toolPromptHash = normalizeStateValue(state.toolPromptHash);

  if (conversationId) {
    entry.conversationId = conversationId;
  }
  if (lastAssistantMessageId) {
    entry.lastAssistantMessageId = lastAssistantMessageId;
  }
  if (systemPrompt) {
    entry.systemPrompt = systemPrompt;
  }
  if (toolPromptHash) {
    entry.toolPromptHash = toolPromptHash;
  }

  entry.lastTouchedAt = now;
  sessionStore.set(normalizedSessionId, entry);
  enforceSessionLimit();

  log.debug(isNew ? 'Created conversation state' : 'Updated conversation state', {
    sessionId: `${normalizedSessionId.slice(0, 8)}...`,
    hasConversationId: !!conversationId,
    hasLastMessageId: !!lastAssistantMessageId,
    totalSessions: sessionStore.size,
  });
}

export function rememberConversationTurn(
  sessionId,
  requestBody,
  assistantMessage,
  clientNamespace = 'default',
) {
  const normalizedSessionId = normalizeId(sessionId);
  const requestMessages = requestBody?.messages;
  if (!normalizedSessionId || !Array.isArray(requestMessages) || !assistantMessage) {
    return;
  }

  cleanupExpiredSessions();
  if (!sessionStore.has(normalizedSessionId)) {
    return;
  }

  const normalizedAssistant = normalizeMessage(assistantMessage);
  if (normalizedAssistant?.role !== 'assistant') {
    return;
  }

  const transcriptKey = buildTranscriptKey(requestBody, [...requestMessages, normalizedAssistant]);
  if (!transcriptKey) {
    return;
  }

  indexTranscriptAlias(
    normalizedSessionId,
    namespacedTranscriptKey(clientNamespace, transcriptKey),
  );
  log.debug('Indexed transcript for session continuity', {
    sessionId: `${normalizedSessionId.slice(0, 8)}...`,
    transcriptAliases: transcriptIndex.size,
  });
}

export function resetConversationState(sessionId) {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId) {
    return;
  }
  const existed = sessionStore.has(normalizedSessionId);
  sessionStore.delete(normalizedSessionId);
  removeTranscriptAliasesForSession(normalizedSessionId);
  if (existed) {
    log.info('Reset conversation state', { sessionId: `${normalizedSessionId.slice(0, 8)}...` });
  }
}

export function clearConversationStoreForTests() {
  sessionStore.clear();
  transcriptIndex.clear();
  transcriptAliasesBySession.clear();
}

export function getConversationStoreSize() {
  cleanupExpiredSessions();
  return sessionStore.size;
}
