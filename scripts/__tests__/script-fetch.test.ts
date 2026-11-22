import { afterEach, describe, expect, it } from 'vitest';
import { scriptFetch, setScriptFetch } from '../script-fetch.js';

const INSTALLED_BODY = 'from the installed fetch';

describe('scriptFetch', () => {
  afterEach(() => { setScriptFetch(undefined); });

  it('sends over a fetch installed after the client took its transport', async () => {
    const takenBeforeInstall = scriptFetch();
    const requested: string[] = [];
    setScriptFetch((input) => {
      requested.push(new Request(input).url);
      return Promise.resolve(new Response(INSTALLED_BODY));
    });

    const response = await takenBeforeInstall('https://ingest.test/v1/evaluations');

    expect(await response.text()).toBe(INSTALLED_BODY);
    expect(requested).toEqual(['https://ingest.test/v1/evaluations']);
  });
});
