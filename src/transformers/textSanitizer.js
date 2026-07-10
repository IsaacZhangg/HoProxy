const TOOL_INSTRUCTION_MARKERS = [
  '# available tools',
  '## tool definitions',
  'you have access to the following tools',
  'important: you must use this exact xml format to call tools',
];

const ROLE_PREFIX_RE = /(^|\r?\n)\s*(?:H:|A:|Human:|Assistant:)\s*/g;

export function findToolInstructionStartIndex(text, fromIndex = 0) {
  if (!text) {
    return -1;
  }
  const normalized = text.toLowerCase();
  let earliest = -1;
  for (const marker of TOOL_INSTRUCTION_MARKERS) {
    const index = normalized.indexOf(marker, fromIndex);
    if (index !== -1 && (earliest === -1 || index < earliest)) {
      earliest = index;
    }
  }
  return earliest;
}

export function findNextAssistantMarkerIndex(text, fromIndex = 0) {
  if (!text) {
    return -1;
  }
  const pattern = /(^|\r?\n)\s*(?:A:|Assistant:)\s*/g;
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

export function stripRolePrefixes(text) {
  return text ? text.replace(ROLE_PREFIX_RE, '$1') : text;
}

export function stripToolInstructionLeak(text) {
  if (!text) {
    return text;
  }

  let result = text;
  while (true) {
    const startIndex = findToolInstructionStartIndex(result);
    if (startIndex === -1) {
      break;
    }
    const assistantIndex = findNextAssistantMarkerIndex(result, startIndex);
    if (assistantIndex === -1) {
      result = result.slice(0, startIndex);
      break;
    }
    result = result.slice(0, startIndex) + result.slice(assistantIndex);
  }
  return result;
}

export function sanitizeText(text) {
  return stripRolePrefixes(stripToolInstructionLeak(text));
}
