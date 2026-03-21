import { type ReactNode } from 'react';
import { Redirect, useLocation } from 'wouter';
import { useAuth } from '../contexts/AuthContext.js';

interface RequireAuthProps {
  children: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { session, isLoading } = useAuth();
  const [location] = useLocation();

  if (isLoading) return <div className="auth-loading" role="status" aria-label="Loading" />;
  if (!session) {
    const redirect = location !== '/login' ? `?redirect=${encodeURIComponent(location)}` : '';
    return <Redirect to={`/login${redirect}`} />;
  }
  return <>{children}</>;
}
