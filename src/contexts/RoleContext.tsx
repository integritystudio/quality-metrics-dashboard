import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useRoute } from 'wouter';
import {
  getRoleFeatureConfig,
  type FeatureRoleType,
  type RoleFeatureConfig,
} from '../../../dist/lib/quality-feature-engineering.js';

const VALID_ROLES = new Set<FeatureRoleType>(['executive', 'operator', 'auditor']);

interface RoleContextValue {
  role: FeatureRoleType;
  config: RoleFeatureConfig;
  hasFeature: (feature: keyof RoleFeatureConfig) => boolean;
}

const RoleContext = createContext<RoleContextValue | null>(null);

export function RoleProvider({ children }: { children: ReactNode }) {
  const [, params] = useRoute('/role/:roleName');
  const roleName = params?.roleName as string | undefined;

  const role: FeatureRoleType =
    roleName && VALID_ROLES.has(roleName as FeatureRoleType)
      ? (roleName as FeatureRoleType)
      : 'executive';

  const value = useMemo<RoleContextValue>(() => {
    const config = getRoleFeatureConfig(role);
    return {
      role,
      config,
      hasFeature: (feature: keyof RoleFeatureConfig) => {
        const v = config[feature];
        if (typeof v === 'boolean') return v;
        return v !== undefined && v !== null;
      },
    };
  }, [role]);

  return (
    <RoleContext.Provider value={value}>
      {children}
    </RoleContext.Provider>
  );
}

export function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext);
  if (!ctx) {
    throw new Error('useRole must be used within a RoleProvider');
  }
  return ctx;
}

export function RoleGate({ feature, children }: {
  feature: keyof RoleFeatureConfig;
  children: ReactNode;
}) {
  const { hasFeature } = useRole();
  return hasFeature(feature) ? <>{children}</> : null;
}
