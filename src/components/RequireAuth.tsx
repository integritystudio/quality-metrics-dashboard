import { type ReactNode } from 'react';
import { Redirect } from 'wouter';
import { useAuth } from '../contexts/AuthContext.js';

interface RequireAuthProps {
  children: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { session, isLoading } = useAuth();

  if (isLoading) return null;
  if (!session) return <Redirect to="/login" />;
  return <>{children}</>;
}
