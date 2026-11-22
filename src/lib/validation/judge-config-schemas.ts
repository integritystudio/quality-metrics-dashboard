/**
 * An org's specified judge (parent docs/roadmap/judge-model-tiers.md, Phase 4), as the settings
 * page and `/api/admin/judge` exchange it. The provider key travels only in a save request: no
 * response carries it, and the worker never stores it, forwarding it to the provisioning
 * receiver, which hands it to AI Gateway.
 *
 * The provider list and model pattern repeat the receiver's (`services/api-provisioning-receiver/
 * src/schemas.ts`) and the `org_judge_configs` CHECK constraints: three deployables, no shared
 * package. Change all three together.
 */
import { z } from 'zod';
import { SupabaseTimestampSchema } from './auth-schemas.js';

/** The worker route the settings page reads and writes. */
export const JUDGE_CONFIG_API_PATH = '/api/admin/judge';

export const JUDGE_PROVIDERS = ['anthropic', 'openai'] as const;
export const JudgeProviderSchema = z.enum(JUDGE_PROVIDERS);
export type JudgeProvider = z.infer<typeof JudgeProviderSchema>;

export const JUDGE_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.:-]{0,127}$/;
export const MAX_JUDGE_API_KEY_LENGTH = 512;

export const JudgeModelIdSchema = z.string().trim().regex(JUDGE_MODEL_ID_PATTERN);

export const SetJudgeConfigRequestSchema = z.object({
  provider: JudgeProviderSchema,
  model: JudgeModelIdSchema,
  apiKey: z.string().trim().min(1).max(MAX_JUDGE_API_KEY_LENGTH),
});
export type SetJudgeConfigRequest = z.infer<typeof SetJudgeConfigRequestSchema>;

/** An `org_judge_configs` row as the worker selects it. */
export const JudgeConfigRowSchema = z.object({
  provider: JudgeProviderSchema,
  model: z.string(),
  key_preview: z.string().nullable(),
  updated_at: SupabaseTimestampSchema,
});

export const JudgeConfigSchema = z.discriminatedUnion('configured', [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    provider: JudgeProviderSchema,
    model: z.string(),
    keyPreview: z.string().nullable(),
    updatedAt: SupabaseTimestampSchema,
  }),
]);
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;
