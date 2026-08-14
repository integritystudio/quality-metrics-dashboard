import { z } from 'zod';
import { FRONTEND_ACTIVITY_EVENTS } from '../../types/activity.js';
import { RoleSchema } from '../roles.js';

/**
 * Auth0 JWT payload — result of jwtVerify() in the worker.
 * The `sub` claim is the Auth0 subject identifier (e.g. "auth0|abc123").
 */
export const Auth0JwtPayloadSchema = z.object({
  sub: z.string(),
  email: z.email().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number(),
  exp: z.number(),
});

export type Auth0JwtPayload = z.infer<typeof Auth0JwtPayloadSchema>;

/**
 * public.users table row — app-level user record linked to auth.users
 */
export const PublicUserSchema = z.object({
  id: z.string().uuid(),
  email: z.email(),
  created_at: z.iso.datetime().optional(),
  updated_at: z.iso.datetime().optional(),
  /** Active-org preference (FK organizations.id) — read by the P5 org resolution. */
  default_organization_id: z.string().uuid().nullable().optional(),
});

export type PublicUser = z.infer<typeof PublicUserSchema>;

// ---------------------------------------------------------------------------
// Org-scoped RBAC (P5) — membership rows, session summaries, org switch
// ---------------------------------------------------------------------------

export const OrgMembershipRoleSchema = z.enum(['owner', 'admin', 'member', 'billing_admin', 'viewer']);
export type OrgMembershipRoleValue = z.infer<typeof OrgMembershipRoleSchema>;

export const DashboardRoleSchema = z.enum(['owner', 'admin', 'read', 'e2e-dashboard-reader']);
export type DashboardRoleValue = z.infer<typeof DashboardRoleSchema>;

/** organization_memberships row joined with organizations — worker auth fetch. */
export const OrgMembershipRowSchema = z.object({
  role: OrgMembershipRoleSchema,
  organization_id: z.string().uuid(),
  organizations: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
  }).nullable(),
});
export type OrgMembershipRow = z.infer<typeof OrgMembershipRowSchema>;

/** Session/me-payload membership summary. */
export const OrgMembershipSummarySchema = z.object({
  orgId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  membershipRole: OrgMembershipRoleSchema,
  dashboardRole: DashboardRoleSchema,
});

/** POST /api/org/switch request body. */
export const OrgSwitchRequestSchema = z.object({
  orgId: z.string().uuid(),
});
export type OrgSwitchRequest = z.infer<typeof OrgSwitchRequestSchema>;

/** organization_memberships row joined with users — GET /api/admin/members fetch. */
export const AdminMemberRowSchema = z.object({
  user_id: z.string().uuid(),
  role: OrgMembershipRoleSchema,
  users: z.object({
    id: z.string().uuid(),
    email: z.email().optional().nullable(),
  }).nullable(),
});
export type AdminMemberRow = z.infer<typeof AdminMemberRowSchema>;

/** Member list item returned by GET /api/admin/members. */
export const AdminMemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.email().optional(),
  membershipRole: OrgMembershipRoleSchema,
  dashboardRole: DashboardRoleSchema,
});
export type AdminMember = z.infer<typeof AdminMemberSchema>;

/** POST /api/admin/members/:userId/role request body. */
export const UpdateMemberRoleRequestSchema = z.object({
  membershipRole: OrgMembershipRoleSchema,
});
export type UpdateMemberRoleRequest = z.infer<typeof UpdateMemberRoleRequestSchema>;

/**
 * user_roles joined with roles — returns role metadata and permissions
 */
export const UserRoleRowSchema = z.object({
  roles: z.object({
    name: z.string(),
    permissions: z.array(z.string()),
  }).nullable(),
});

export type UserRoleRow = z.infer<typeof UserRoleRowSchema>;

/**
 * POST /api/activity request body — frontend-initiated audit events
 * Only login/logout are accepted; view events are logged server-side by route handlers.
 */
export const ActivityRequestSchema = z.object({
  activity_type: z.enum(FRONTEND_ACTIVITY_EVENTS),
});

/**
 * Role record from public.roles — used by admin endpoints
 */
export const AdminRoleSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  permissions: z.array(z.string()),
});

export type AdminRole = z.infer<typeof AdminRoleSchema>;

/**
 * user_roles row joined with roles — used by GET /api/admin/users
 */
export const AdminUserRoleRowSchema = z.object({
  user_id: z.string().uuid(),
  role_id: z.string().uuid(),
  roles: z.object({
    id: z.string().uuid(),
    name: z.string(),
  }).nullable(),
});

export type AdminUserRoleRow = z.infer<typeof AdminUserRoleRowSchema>;

/**
 * User list item returned by GET /api/admin/users
 * email is optional — phone-auth or OAuth users may not have a verified email address.
 */
export const AdminUserSchema = z.object({
  id: z.string().uuid(),
  email: z.email().optional(),
  created_at: z.iso.datetime().optional(),
  roles: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
});

export type AdminUser = z.infer<typeof AdminUserSchema>;

/**
 * POST /api/admin/users/:userId/roles request body
 */
export const AssignRoleRequestSchema = z.object({
  role_id: z.string().uuid(),
});

export type AssignRoleRequest = z.infer<typeof AssignRoleRequestSchema>;

/**
 * API /api/me response
 * Dashboard API authentication and permission resolution result
 */
export const MeResponseSchema = z.object({
  email: z.email(),
  roles: z.array(z.string()),
  permissions: z.array(z.enum([
    'dashboard.read',
    'dashboard.executive',
    'dashboard.operator',
    'dashboard.auditor',
    'dashboard.traces.read',
    'dashboard.sessions.read',
    'dashboard.agents.read',
    'dashboard.pipeline.read',
    'dashboard.compliance.read',
    'dashboard.admin',
  ])),
  allowedViews: z.array(RoleSchema),
  // Org-scoping fields (P5) — optional: absent when ORG_SCOPING_ENABLED is off
  // or the session resolved via the legacy global path, so pre-cutover
  // responses validate unchanged.
  activeOrg: z.string().uuid().optional(),
  memberships: z.array(OrgMembershipSummarySchema).optional(),
  role: DashboardRoleSchema.optional(),
  isStaff: z.boolean().optional(),
});

export type MeResponse = z.infer<typeof MeResponseSchema>;
