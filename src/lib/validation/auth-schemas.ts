import { z } from 'zod';

/**
 * Supabase /auth/v1/user endpoint response
 * Required for JWT verification after bearer token is validated.
 * See: https://supabase.com/docs/reference/auth-api#get-user
 */
export const AuthUserResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().optional(),
  email_confirmed_at: z.string().datetime().optional().nullable(),
  user_metadata: z.record(z.unknown()).optional(),
  app_metadata: z.record(z.unknown()).optional(),
  identities: z.array(z.unknown()).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
  last_sign_in_at: z.string().datetime().optional().nullable(),
  phone: z.string().optional().nullable(),
  confirmed_at: z.string().datetime().optional().nullable(),
});

export type AuthUserResponse = z.infer<typeof AuthUserResponseSchema>;

/**
 * public.users table row — app-level user record linked to auth.users
 */
export const PublicUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
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
 * Supabase sign-in/sign-up response
 * From: AuthContext.tsx signIn() / signUp() via supabase.auth.signInWithPassword, etc.
 */
export const AuthTokenResponseSchema = z.object({
  session: z.object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    user: z.object({
      id: z.string().uuid(),
      email: z.string().email().optional(),
      user_metadata: z.record(z.unknown()).optional(),
    }).optional(),
  }).nullable().optional(),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email().optional(),
    user_metadata: z.record(z.unknown()).optional(),
  }).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;

/**
 * Frontend login/signin request payload
 * Sent to Supabase /auth/v1/token endpoint
 */
export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * Refresh token request payload
 * Sent to Supabase /auth/v1/token endpoint with grant_type=refresh_token
 */
export const RefreshTokenRequestSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token is required'),
});

export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;

/**
 * POST /api/activity request body — frontend-initiated audit events
 * Only login/logout are accepted; view events are logged server-side by route handlers.
 */
export const ActivityRequestSchema = z.object({
  activity_type: z.enum(['login', 'logout']),
});

export type ActivityRequest = z.infer<typeof ActivityRequestSchema>;

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
 */
export const AdminUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  created_at: z.string().datetime().optional(),
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
  email: z.string().email(),
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
  allowedViews: z.array(z.enum(['executive', 'operator', 'auditor'])),
});

export type MeResponse = z.infer<typeof MeResponseSchema>;
