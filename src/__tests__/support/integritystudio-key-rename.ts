/**
 * One session's hook attributes under the unprefixed keys the hooks moved under
 * `integritystudio.`, and the writers that spell them in each era.
 * Shared by the `/api/sessions/:id` route suite and the `computeSessionDetail`
 * suite, which read the same session through different layers.
 */
export type Attributes = Record<string, unknown>;
type AttributeWriter = (attrs: Attributes) => Attributes;

const VENDOR_PREFIX = 'integritystudio.';
const DECOY_OFFSET = 1000;

export const SESSION_START = { 'project.name': 'env-settings', 'context.message_count': 4, 'context.estimated_tokens': 9000, 'tasks.active': 2 };
export const TOKEN_METRICS = { 'tokens.messages': 12, 'tokens.input': 100, 'tokens.output': 50, 'tokens.cache_read': 7, 'tokens.cache_creation': 3, 'tokens.model': 'claude-opus-5' };
export const MCP_POST_TOOL = { 'mcp.tool': 'get_me' };
export const ALERT_EVALUATION = { 'alerts.triggered_count': 3 };

const withPrefix: AttributeWriter = (attrs) =>
  Object.fromEntries(Object.entries(attrs).map(([key, value]) => [`${VENDOR_PREFIX}${key}`, value]));
const unprefixed: AttributeWriter = (attrs) => attrs;
/** The unprefixed keys holding values no reader should surface when the prefixed key is present. */
const staleUnprefixed: AttributeWriter = (attrs) =>
  Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key, typeof value === 'number' ? value + DECOY_OFFSET : `stale-${String(value)}`]));

/** `[era label, writer]` rows for an `it.each` over both spellings. */
export const KEY_ERAS: Array<[string, AttributeWriter]> = [
  ['post-rename integritystudio.*', withPrefix],
  ['pre-rename unprefixed', unprefixed],
];

/** Both spellings on one span, the unprefixed one holding stale values. */
export const withBothSpellings: AttributeWriter = (attrs) => ({ ...staleUnprefixed(attrs), ...withPrefix(attrs) });
