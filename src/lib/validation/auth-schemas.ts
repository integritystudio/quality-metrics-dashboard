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
