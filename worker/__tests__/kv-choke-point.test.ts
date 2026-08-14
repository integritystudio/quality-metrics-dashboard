/**
 * KV choke-point guard (P8, org-scoped-multi-tenancy.md § Guards/tests).
 *
 * Isolation is code-enforced (no storage-layer RLS), so the guard asserts the
 * shape of the code itself: every KV read in the worker must flow through
 * getKv (org-prefixed, with the home-org-only fallback) or getGlobalKv
 * (explicit allowlist). A raw `kv.get(...)` added to a route silently leaks
 * whatever key it names to every org — this test makes that a CI failure.
 *
 * Mutation-proven: adding `await c.env.DASHBOARD.get('dashboard:7d', 'json')`
 * to any route fails the first assertion.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
  'utf8',
);

describe('KV choke point (worker/index.ts source scan)', () => {
  it('exactly one raw kv.get exists — inside readKvEnvelope', () => {
    const rawGets = workerSource.match(/\bkv\.get\(/g) ?? [];
    expect(rawGets).toHaveLength(1);
    // And it sits inside readKvEnvelope, not a route handler.
    const envelopeBody = workerSource.slice(
      workerSource.indexOf('async function readKvEnvelope'),
      workerSource.indexOf('function', workerSource.indexOf('async function readKvEnvelope') + 10),
    );
    expect(envelopeBody).toContain('kv.get(');
  });

  it('no route reads the DASHBOARD binding directly', () => {
    expect(workerSource).not.toMatch(/DASHBOARD\s*\.\s*get\(/);
    expect(workerSource).not.toMatch(/DASHBOARD\s*\.\s*getWithMetadata\(/);
    expect(workerSource).not.toMatch(/DASHBOARD\s*\.\s*list\(/);
  });

  it('every getGlobalKv call site uses an allowlisted literal key', () => {
    // Call sites (skip the function definition itself).
    const callSites = [...workerSource.matchAll(/getGlobalKv[<>\w]*\(\s*[\w.]+\s*,\s*'([^']+)'\s*\)/g)];
    expect(callSites.length).toBeGreaterThan(0);
    for (const m of callSites) {
      expect(['system:lastSync']).toContain(m[1]);
    }
  });

  it('org-prefixing happens in exactly one place (getKv)', () => {
    const prefixBuilders = workerSource.match(/`org:\$\{/g) ?? [];
    expect(prefixBuilders).toHaveLength(1);
  });
});
