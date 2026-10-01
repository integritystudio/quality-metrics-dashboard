/**
 * The worker's id check and the auth schemas must accept the same ids
 * (ORG-ID-UUID-CHECKS-DISAGREE).
 *
 * The worker gates X-Org-Id and path ids with `UUID_PATTERN`; the schemas gate
 * the org-switch body and the `/api/me` membership list. They used
 * `z.string().uuid()`, which in Zod 4 also checks version and variant digits,
 * so a fixture-style id passed as a header but failed the switch body, and
 * failed the session parse that drops the whole session.
 */

import { describe, it, expect } from 'vitest';
import { UUID_PATTERN } from '../lib/worker-contract.js';
import { OrgMembershipSummarySchema, OrgSwitchRequestSchema } from '../lib/validation/auth-schemas.js';

const FIXTURE_STYLE_ID = '11111111-1111-1111-1111-111111111111';

const IDS = [
  { label: 'a v4 id', id: '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c' },
  { label: 'an upper-case id', id: '3F2B8C1E-9A4D-4E7B-8C2A-1D5E6F7A8B9C' },
  { label: 'a fixture-style id with no version digit', id: FIXTURE_STYLE_ID },
  { label: 'an id with a non-hex digit', id: '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9g' },
  { label: 'a non-id', id: 'not-a-uuid' },
];

function membershipWith(orgId: string) {
  return { orgId, slug: 'org', name: 'Org', membershipRole: 'member', dashboardRole: 'read' };
}

describe('org id validation', () => {
  it.each(IDS)('the switch body agrees with the X-Org-Id check on $label', ({ id }) => {
    expect(OrgSwitchRequestSchema.safeParse({ orgId: id }).success).toBe(UUID_PATTERN.test(id));
  });

  it.each(IDS)('the session membership agrees with the X-Org-Id check on $label', ({ id }) => {
    expect(OrgMembershipSummarySchema.safeParse(membershipWith(id)).success).toBe(UUID_PATTERN.test(id));
  });

  it('accepts a fixture-style id everywhere the worker does', () => {
    expect(UUID_PATTERN.test(FIXTURE_STYLE_ID)).toBe(true);
    expect(OrgSwitchRequestSchema.safeParse({ orgId: FIXTURE_STYLE_ID }).success).toBe(true);
    expect(OrgMembershipSummarySchema.safeParse(membershipWith(FIXTURE_STYLE_ID)).success).toBe(true);
  });
});
