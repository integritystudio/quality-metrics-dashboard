import { z } from 'zod';
import { FRONTEND_ACTIVITY_EVENTS } from '../../types/activity.js';
import { RoleSchema } from '../constants.js';

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
});

export type PublicUser = z.infer<typeof PublicUserSchema>;

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
});

export type MeResponse = z.infer<typeof MeResponseSchema>;
