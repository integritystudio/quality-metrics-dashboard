/**
 * The active org's specified judge (parent docs/roadmap/judge-model-tiers.md, Phase 4): which
 * provider and model judge its turns, on a key the org supplies. The key field is write-only:
 * it is sent once in the save request, cleared from state as soon as it is submitted, and never
 * shown again; the page displays only the masked preview AI Gateway returns.
 */
import { useId, useState, type SyntheticEvent } from 'react';
import { format } from 'date-fns';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { useAuth } from '../contexts/AuthContext.js';
import { useOrgOptional } from '../contexts/OrgContext.js';
import { apiFetch } from '../lib/api-client.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import { SKELETON_HEIGHT_MD } from '../lib/constants.js';
import { CONTENT_TYPE_HEADER, ContentType } from '../lib/http-constants.js';
import {
  JUDGE_CONFIG_API_PATH,
  JUDGE_PROVIDERS,
  JudgeConfigSchema,
  MAX_JUDGE_API_KEY_LENGTH,
  SetJudgeConfigRequestSchema,
  type JudgeConfig,
  type JudgeProvider,
} from '../lib/validation/judge-config-schemas.js';

const JUDGE_QUERY_KEY = ['admin', 'judge'] as const;

const PROVIDER_LABELS: Record<JudgeProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };
const MODEL_PLACEHOLDERS: Record<JudgeProvider, string> = { anthropic: 'claude-haiku-5-5', openai: 'gpt-5.1' };

const ERR_NETWORK = 'Network error';
const ERR_SAVE_FAILED = 'Saving the judge settings failed';
const ERR_REMOVE_FAILED = 'Removing the judge key failed';
const ERR_INVALID_FORM = 'Choose a provider, enter a model id (lowercase letters, digits, dots, colons, hyphens) and paste a key.';
const CONFIRM_REMOVE = 'Remove this organization\'s judge key? Judging on it stops at once; nothing falls back to another key.';
const KEY_NOTICE = 'The key is stored in the gateway and never shown again. Saving a new one replaces it.';
const NO_PREVIEW = 'stored';

/** The worker's `{ error }` message, or `fallback`. */
async function failureMessage(res: Response, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (typeof body !== 'object' || body === null || !('error' in body)) return fallback;
  const { error } = body;
  return typeof error === 'string' && error !== '' ? error : fallback;
}

/** A mutation against the judge route that throws the worker's message on failure, then refetches the config. */
function useJudgeMutation<T>(method: string, fallback: string) {
  const { getAccessToken } = useAuth();
  const queryClient = useQueryClient();
  const activeOrgId = useOrgOptional()?.activeOrgId ?? null;
  return useMutation({
    // A confirmed removal or save must fail with ERR_NETWORK offline, not wait for reconnect.
    networkMode: 'always',
    mutationFn: async (body: T) => {
      const token = await getAccessToken();
      let res: Response;
      try {
        res = await apiFetch(JUDGE_CONFIG_API_PATH, token, activeOrgId, {
          method,
          headers: { [CONTENT_TYPE_HEADER]: ContentType.Json },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      } catch {
        throw new Error(ERR_NETWORK);
      }
      if (!res.ok) throw new Error(await failureMessage(res, fallback));
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: [activeOrgId, ...JUDGE_QUERY_KEY] }),
  });
}

function CurrentJudge({ config }: { config: JudgeConfig }) {
  const remove = useJudgeMutation<undefined>('DELETE', ERR_REMOVE_FAILED);

  if (!config.configured) {
    return <div className="card mb-4 text-secondary text-xs">No judge key is stored for this organization.</div>;
  }

  function handleRemove() {
    if (!window.confirm(CONFIRM_REMOVE)) return;
    remove.mutate(undefined);
  }

  return (
    <div className="card mb-4">
      <dl className="text-xs">
        <div><dt className="field-label text-muted">Provider</dt><dd>{PROVIDER_LABELS[config.provider]}</dd></div>
        <div className="mt-2"><dt className="field-label text-muted">Model</dt><dd className="mono">{config.model}</dd></div>
        <div className="mt-2"><dt className="field-label text-muted">Key</dt><dd className="mono">{config.keyPreview ?? NO_PREVIEW}</dd></div>
        <div className="mt-2"><dt className="field-label text-muted">Updated</dt><dd>{format(new Date(config.updatedAt), 'PPp')}</dd></div>
      </dl>
      <button className="btn-sm mt-2" onClick={handleRemove} disabled={remove.isPending}>Remove key</button>
      {remove.error && <div className="text-xs text-critical mt-1" role="alert">{remove.error.message}</div>}
    </div>
  );
}

function JudgeKeyForm({ replacing }: { replacing: boolean }) {
  const save = useJudgeMutation<unknown>('PUT', ERR_SAVE_FAILED);
  const [provider, setProvider] = useState<JudgeProvider>(JUDGE_PROVIDERS[0]);
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const baseId = useId();
  const ids = { provider: `${baseId}-provider`, model: `${baseId}-model`, key: `${baseId}-key`, keyNotice: `${baseId}-key-notice` };

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = SetJudgeConfigRequestSchema.safeParse({ provider, model, apiKey });
    // The key leaves component state at once, whether or not the request is sent.
    setApiKey('');
    if (!parsed.success) {
      setFormError(ERR_INVALID_FORM);
      return;
    }
    setFormError(null);
    save.mutate(parsed.data, { onSuccess: () => setModel('') });
  }

  const error = formError ?? save.error?.message ?? null;

  return (
    <div className="card">
      <form className="settings-form" onSubmit={handleSubmit} aria-label="Judge settings">
        <div className="settings-form__field text-xs">
          <label htmlFor={ids.provider} className="field-label text-muted">Provider</label>
          <select id={ids.provider} className="form-select" value={provider} onChange={(e) => setProvider(e.target.value as JudgeProvider)} disabled={save.isPending}>
            {JUDGE_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
          </select>
        </div>
        <div className="settings-form__field text-xs">
          <label htmlFor={ids.model} className="field-label text-muted">Model id</label>
          <input
            id={ids.model}
            className="form-input mono"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={MODEL_PLACEHOLDERS[provider]}
            autoComplete="off"
            spellCheck={false}
            disabled={save.isPending}
          />
        </div>
        <div className="settings-form__field text-xs">
          <label htmlFor={ids.key} className="field-label text-muted">API key</label>
          <input
            id={ids.key}
            className="form-input mono"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            maxLength={MAX_JUDGE_API_KEY_LENGTH}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={ids.keyNotice}
            disabled={save.isPending}
          />
          <span id={ids.keyNotice} className="text-muted">{KEY_NOTICE}</span>
        </div>
        <div>
          <button className="btn-sm" type="submit" disabled={save.isPending}>{replacing ? 'Replace key' : 'Save'}</button>
        </div>
        {error && <div className="text-xs text-critical" role="alert">{error}</div>}
      </form>
    </div>
  );
}

export function JudgeSettingsPage() {
  const { data, isLoading, error } = useApiQuery<unknown, JudgeConfig>(JUDGE_QUERY_KEY, () => JUDGE_CONFIG_API_PATH, {
    select: (raw) => JudgeConfigSchema.parse(raw),
  });

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      <DetailPageHeader title="Judge Model" />
      {data && <CurrentJudge config={data} />}
      <JudgeKeyForm replacing={data?.configured === true} />
    </PageShell>
  );
}
