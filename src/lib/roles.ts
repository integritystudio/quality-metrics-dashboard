import { z } from 'zod';

/**
 * Dashboard RBAC roles. Worker-safe: this module has no `import.meta.env` access, so
 * it can be imported by `worker/` and API-server code alike.
 */
export const RoleSchema = z.enum(['executive', 'operator', 'auditor']);
export type Role = z.infer<typeof RoleSchema>;
export const ROLES = RoleSchema.options;
export const DEFAULT_ROLE: Role = 'executive';
