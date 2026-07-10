function schemaTypes(schema) {
  const type = schema?.type;
  if (Array.isArray(type)) {
    return type.filter((entry) => typeof entry === 'string');
  }
  return typeof type === 'string' ? [type] : [];
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function coercePrimitive(value, types) {
  if (typeof value !== 'string' || types.includes('string')) {
    return value;
  }
  const trimmed = value.trim();
  if (types.includes('boolean') && (trimmed === 'true' || trimmed === 'false')) {
    return trimmed === 'true';
  }
  if (types.includes('integer') && /^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  if (types.includes('number') && trimmed !== '' && Number.isFinite(Number(trimmed))) {
    return Number(trimmed);
  }
  if (types.includes('null') && trimmed === 'null') {
    return null;
  }
  if (types.some((type) => type === 'array' || type === 'object')) {
    try {
      return JSON.parse(trimmed);
    } catch (_error) {
      return value;
    }
  }
  return value;
}

function coerceValue(value, schema) {
  if (!schema || typeof schema !== 'object') {
    return value;
  }
  if (Array.isArray(schema.anyOf)) {
    for (const candidate of schema.anyOf) {
      const coerced = coerceValue(value, candidate);
      if (validateValue(coerced, candidate) === null) {
        return coerced;
      }
    }
  }
  if (Array.isArray(schema.oneOf)) {
    for (const candidate of schema.oneOf) {
      const coerced = coerceValue(value, candidate);
      if (validateValue(coerced, candidate) === null) {
        return coerced;
      }
    }
  }

  const coerced = coercePrimitive(value, schemaTypes(schema));
  if (Array.isArray(coerced) && schema.items) {
    return coerced.map((entry) => coerceValue(entry, schema.items));
  }
  if (coerced && typeof coerced === 'object' && !Array.isArray(coerced)) {
    const properties = schema.properties || {};
    return Object.fromEntries(
      Object.entries(coerced).map(([key, entry]) => [key, coerceValue(entry, properties[key])]),
    );
  }
  return coerced;
}

function validateValue(value, schema, path = 'input') {
  if (!schema || typeof schema !== 'object') {
    return null;
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((entry) => validateValue(value, entry) === null)
      ? null
      : `${path} does not match any allowed schema`;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((entry) => validateValue(value, entry) === null);
    return matches.length === 1 ? null : `${path} does not match exactly one allowed schema`;
  }

  const types = schemaTypes(schema);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return `${path} does not match schema type ${types.join('|')}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    return `${path} is not an allowed enum value`;
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateValue(value[index], schema.items, `${path}[${index}]`);
      if (error) return error;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!(required in value)) {
        return `${path}.${required} is required`;
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!(key in properties) && schema.additionalProperties === false) {
        return `${path}.${key} is not allowed`;
      }
      const error = validateValue(entry, properties[key], `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

export function coerceAndValidateToolInput(input, schema) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, input, error: 'tool input must be an object' };
  }
  const coerced = coerceValue(input, schema);
  const error = validateValue(coerced, schema);
  return { valid: error === null, input: coerced, error };
}
