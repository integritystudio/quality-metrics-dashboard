import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { OrgSwitcher } from '../components/OrgSwitcher.js';
import type { OrgMembershipSummary } from '../types/auth.js';

const ORG_A = 'a0000000-0000-4000-8000-00000000000a';
const ORG_B = 'b0000000-0000-4000-8000-00000000000b';
const FAILURE_TEXT = 'Failed to switch organization';

function membership(orgId: string, name: string): OrgMembershipSummary {
  return { orgId, slug: name, name, membershipRole: 'member', dashboardRole: 'read' };
}

const mockSwitchOrg = vi.fn<(orgId: string) => Promise<boolean>>();

vi.mock('../contexts/OrgContext.js', () => ({
  useOrg: () => ({
    activeOrgId: ORG_A,
    memberships: [membership(ORG_A, 'org-a'), membership(ORG_B, 'org-b')],
    isStaff: false,
    switchOrg: mockSwitchOrg,
  }),
}));

function renderSwitcher() {
  const queryClient = new QueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  render(<OrgSwitcher />, { wrapper: Wrapper });
  return screen.getByRole('combobox', { name: 'Switch organization' });
}

afterEach(() => {
  cleanup();
  mockSwitchOrg.mockReset();
});

describe('OrgSwitcher', () => {
  it('switches to the chosen org without an error', async () => {
    mockSwitchOrg.mockResolvedValue(true);
    const select = renderSwitcher();

    fireEvent.change(select, { target: { value: ORG_B } });

    await waitFor(() => expect(select).toBeEnabled());
    expect(mockSwitchOrg).toHaveBeenCalledWith(ORG_B);
    expect(screen.queryByText(FAILURE_TEXT)).not.toBeInTheDocument();
  });

  it('reports a failed switch and re-enables the select', async () => {
    mockSwitchOrg.mockResolvedValue(false);
    const select = renderSwitcher();

    fireEvent.change(select, { target: { value: ORG_B } });

    expect(await screen.findByText(FAILURE_TEXT)).toBeInTheDocument();
    expect(select).toBeEnabled();
  });

  it('ignores re-selecting the active org', () => {
    const select = renderSwitcher();

    fireEvent.change(select, { target: { value: ORG_A } });

    expect(mockSwitchOrg).not.toHaveBeenCalled();
  });
});
