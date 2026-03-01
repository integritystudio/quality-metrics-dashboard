import type { ReactNode } from 'react';

interface EmptyCardProps {
  children: ReactNode;
}

export function EmptyCard({ children }: EmptyCardProps) {
  return (
    <div className="card card--empty">
      {children}
    </div>
  );
}
