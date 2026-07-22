// Connector Runtime V1 — input validation (plan §4 step 9, "one production
// JSON Schema validator"). Reuses the existing ajv dependency — no new library.
//
// Behaviour (plan §4 "Schema validation"):
//   - reject unknown properties unless the schema allows them
//   - coerce safe primitive representations (string "5" -> 5 for an integer)
//   - apply defaults
//   - enforce string/array/pagination limits declared in the schema
// A validation failure throws InvalidInputError; the provider never receives an
// arbitrary model-generated object.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { InvalidInputError } from './errors.js';

// One shared, strict validator. removeAdditional:true drops undeclared props
// (defence against arg smuggling — mirrors tool-registry.validateAndSanitize).
// coerceTypes:true accepts "5"/"true" from loose model output. useDefaults
// fills declared defaults. Compiled schemas are cached by identity.
const ajv = new Ajv({
  allErrors: true,
  coerceTypes: true,
  removeAdditional: 'failing', // only strip props that violate additionalProperties:false
  useDefaults: true,
  strict: false, // tolerate provider schemas with vendor keywords
});
addFormats(ajv);

const _cache = new WeakMap();

function compileFor(schema) {
  let v = _cache.get(schema);
  if (!v) {
    try {
      v = ajv.compile(schema);
    } catch (e) {
      // A broken tool schema is a manifest bug, not a caller error — surface it.
      throw new InvalidInputError(`tool input schema failed to compile: ${e.message}`);
    }
    _cache.set(schema, v);
  }
  return v;
}

/**
 * Validate + coerce `input` against `tool.inputSchema`. Returns a NEW object
 * (never mutates caller args). Throws InvalidInputError on violation.
 */
export function validateInput(tool, input) {
  const schema = tool?.inputSchema;
  if (!schema || typeof schema !== 'object') return input || {};
  // clone so coercion/defaults/removeAdditional don't mutate the caller's args
  const data = input && typeof input === 'object' ? JSON.parse(JSON.stringify(input)) : {};
  const validate = compileFor(schema);
  const ok = validate(data);
  if (!ok) {
    const errs = (validate.errors || [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .slice(0, 6)
      .join('; ');
    throw new InvalidInputError(`invalid input for ${tool.name}: ${errs}`, { errors: validate.errors });
  }
  return data;
}
