// Minimal JSON Schema checker for the subset of OpenAPI 3.1 used by
// backend/openapi.json. Returns a list of "path: problem" strings.
import { readFileSync } from 'node:fs';

export const openapi = JSON.parse(readFileSync(new URL('../../backend/openapi.json', import.meta.url), 'utf8'));

function resolve(ref) {
  return ref.slice(2).split('/').reduce((node, key) => node?.[key], openapi);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

function validateSchema(value, schema, at = '$', errors = []) {
  if (schema === false) {
    errors.push(`${at}: no value allowed`);
    return errors;
  }
  if (!schema || schema === true) {
    return errors;
  }
  if (schema.$ref) {
    return validateSchema(value, resolve(schema.$ref), at, errors);
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((option) => validateSchema(value, option, at).length === 0);
    if (passing.length !== 1) {
      errors.push(`${at}: matches ${passing.length} oneOf options`);
    }
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    const prefix = schema.prefixItems || [];
    value.forEach((item, index) => {
      const itemSchema = index < prefix.length ? prefix[index] : schema.items;
      if (itemSchema !== undefined) validateSchema(item, itemSchema, `${at}[${index}]`, errors);
    });
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    (schema.required || []).forEach((key) => {
      if (!(key in value)) errors.push(`${at}: missing required ${key}`);
    });
    Object.entries(value).forEach(([key, child]) => {
      if (schema.properties?.[key]) {
        validateSchema(child, schema.properties[key], `${at}.${key}`, errors);
      } else if (schema.additionalProperties !== undefined) {
        validateSchema(child, schema.additionalProperties, `${at}.${key}`, errors);
      }
    });
  }
  return errors;
}

/** Schema of the 200 response for an operationId. */
function responseSchema(operationId) {
  for (const item of Object.values(openapi.paths)) {
    for (const operation of Object.values(item)) {
      if (operation.operationId === operationId) {
        let response = operation.responses['200'];
        if (response.$ref) response = resolve(response.$ref);
        return response.content['application/json'].schema;
      }
    }
  }
  throw new Error(`Unknown operationId ${operationId}`);
}

export function schemaErrors(operationId, value) {
  return validateSchema(value, responseSchema(operationId));
}
