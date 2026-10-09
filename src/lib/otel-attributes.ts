/**
 * OTel attribute names shared with the parent toolkit, for code that reads or
 * writes spans: API routes, the React app and their tests. Re-export only, so a
 * semconv rename lands in the parent's `lib/otel/` and nowhere here. `scripts/`
 * imports the same modules by source path.
 */
export {
  GENAI_AGENT_ATTRIBUTES,
  GENAI_CORE_ATTRIBUTES,
  GENAI_EVALUATION_ATTRIBUTES,
  GENAI_REQUEST_ATTRIBUTES,
  GENAI_RESPONSE_ATTRIBUTES,
  GENAI_TOOL_ATTRIBUTES,
} from '@parent/lib/otel/genai-attributes.js';
export { SESSION_ATTRIBUTES } from '@parent/lib/otel/constants-otel.js';
