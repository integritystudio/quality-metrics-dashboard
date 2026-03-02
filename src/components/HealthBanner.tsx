import type { ReactNode } from 'react';
import { StatusBadge } from './Indicators.js';

interface HealthBannerProps {
  status: string;
  message: ReactNode;
  children?: ReactNode;
}

export function HealthBanner({ status, message, children }: HealthBannerProps) {
  return (
    <div className="health-banner flex-center" data-status={status}>
      <div className="flex-center gap-3">
        <StatusBadge status={status} />
        <div>{message}</div>
      </div>
      {children && <div className="d-flex gap-6">{children}</div>}
    </div>
  );
}
