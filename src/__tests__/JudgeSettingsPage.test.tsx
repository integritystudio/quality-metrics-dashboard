/**
 * JudgeSettingsPage against the real useApiQuery + react-query + apiFetch stack. Substituted:
 * `useAuth`, `window.confirm`, and `fetch`, backed by an in-memory fake of `/api/admin/judge`
 * that keeps the config a save writes, so the page's refetch shows what the worker would.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { JudgeSettingsPage } from '../pages/JudgeSettingsPage.js';
import { JUDGE_CONFIG_API_PATH, type JudgeConfig } from '../lib/validation/judge-config-schemas.js';
import { TEST_ACCESS_TOKEN, makeQueryWrapper } from './support/query-harness.js';
import { CONTENT_TYPE_HEADER, ContentType, HttpStatus } from '../lib/http-constants.js';

const getAccessToken = () => Promise.resolve(TEST_ACCESS_TOKEN);

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ session: null, getAccessToken }),
}));

const PROVIDER_KEY = 'sk-ant-org-provider-key';
const KEY_PREVIEW = 'sk-...-key';
const MODEL = 'claude-haiku-5-5';
const UPDATED_AT = '2026-11-22T10:00:00.000000+00:00';
const FORBIDDEN_MESSAGE = 'Only an org owner or admin may change the judge';

type Sent = { method: string; body: unknown };

const UNCONFIGURED: JudgeConfig = { configured: false };

function startFakeWorker({ initial = UNCONFIGURED, refuseWith }: { initial?: JudgeConfig; refuseWith?: number } = {}) {
  let config: JudgeConfig = initial;
  const sent: Sent[] = [];
  const json = (body: unknown, status: number = HttpStatus.Ok) => new Response(JSON.stringify(body), { status, headers: { [CONTENT_TYPE_HEADER]: ContentType.Json } });

  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url !== JUDGE_CONFIG_API_PATH) return Promise.resolve(json({ error: 'not found' }, HttpStatus.NotFound));
    if (method === 'GET') return Promise.resolve(json(config));
    sent.push({ method, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined });
    if (refuseWith) return Promise.resolve(json({ error: FORBIDDEN_MESSAGE }, refuseWith));
    if (method === 'PUT') {
      const { provider, model } = sent.at(-1)?.body as { provider: 'anthropic' | 'openai'; model: string };
      config = { configured: true, provider, model, keyPreview: KEY_PREVIEW, updatedAt: UPDATED_AT };
      return Promise.resolve(json(config));
    }
    config = { configured: false };
    return Promise.resolve(new Response(null, { status: HttpStatus.NoContent }));
  });
  return { sent };
}

function renderPage() {
  const { wrapper } = makeQueryWrapper();
  return render(<JudgeSettingsPage />, { wrapper });
}

const keyInput = () => screen.getByLabelText('API key');
const modelInput = () => screen.getByLabelText('Model id');

function fillAndSubmit(model: string, key: string) {
  fireEvent.change(modelInput(), { target: { value: model } });
  fireEvent.change(keyInput(), { target: { value: key } });
  fireEvent.submit(screen.getByRole('form', { name: 'Judge settings' }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('JudgeSettingsPage', () => {
  it('saves the provider, model and key, then shows only the masked preview', async () => {
    const { sent } = startFakeWorker();
    renderPage();
    await screen.findByText('No judge key is stored for this organization.');

    fillAndSubmit(MODEL, PROVIDER_KEY);

    await screen.findByText(KEY_PREVIEW);
    expect(sent).toEqual([{ method: 'PUT', body: { provider: 'anthropic', model: MODEL, apiKey: PROVIDER_KEY } }]);
    expect((keyInput() as HTMLInputElement).value).toBe('');
    expect(keyInput()).toHaveAttribute('type', 'password');
    expect(document.body.textContent).not.toContain(PROVIDER_KEY);
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeInTheDocument();
  });

  it('refuses a malformed model id without sending anything, and still clears the key', async () => {
    const { sent } = startFakeWorker();
    renderPage();
    await screen.findByText('No judge key is stored for this organization.');

    fillAndSubmit('Claude Haiku', PROVIDER_KEY);

    expect(await screen.findByRole('alert')).toHaveTextContent('enter a model id');
    expect(sent).toEqual([]);
    expect((keyInput() as HTMLInputElement).value).toBe('');
  });

  it('shows the worker\'s refusal', async () => {
    startFakeWorker({ refuseWith: HttpStatus.Forbidden });
    renderPage();
    await screen.findByText('No judge key is stored for this organization.');

    fillAndSubmit(MODEL, PROVIDER_KEY);

    expect(await screen.findByRole('alert')).toHaveTextContent(FORBIDDEN_MESSAGE);
  });

  it('removes the key after confirmation', async () => {
    const { sent } = startFakeWorker({ initial: { configured: true, provider: 'anthropic', model: MODEL, keyPreview: KEY_PREVIEW, updatedAt: UPDATED_AT } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove key' }));

    await screen.findByText('No judge key is stored for this organization.');
    expect(sent).toEqual([{ method: 'DELETE', body: undefined }]);
  });

  it('sends nothing when the removal is not confirmed', async () => {
    const { sent } = startFakeWorker({ initial: { configured: true, provider: 'anthropic', model: MODEL, keyPreview: null, updatedAt: UPDATED_AT } });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove key' }));

    await waitFor(() => expect(screen.getByText('stored')).toBeInTheDocument());
    expect(sent).toEqual([]);
  });
});
