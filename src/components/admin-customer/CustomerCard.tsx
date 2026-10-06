/**
 * The Flutter `DashboardCard` (lib/widgets/common/dashboard_card.dart): a titled card with
 * an optional trailing badge and an in-card loading indicator, plus the error card and the
 * Refresh row the four screens share.
 */
import type { ReactNode } from 'react';
import { CUSTOMER_VIEW } from '../../lib/admin-customer-strings.js';

interface CustomerCardProps {
  title: string;
  isLoading: boolean;
  trailing?: ReactNode;
  children: ReactNode;
}

export function CustomerCard({ title, isLoading, trailing, children }: CustomerCardProps) {
  return (
    <section className="card customer-card" aria-busy={isLoading}>
      <div className="customer-card__header">
        <h3 className="customer-card__title">{title}</h3>
        {trailing}
      </div>
      {isLoading && <div className="customer-spinner" role="status" aria-label="Loading" />}
      <div className="customer-card__body">{children}</div>
    </section>
  );
}

/** The Flutter `ErrorCard`: the message and a "Try again" button. */
export function CustomerErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-state" role="alert">
      <p>{message}</p>
      <div className="error-actions">
        <button type="button" onClick={onRetry}>{CUSTOMER_VIEW.common.tryAgain}</button>
      </div>
    </div>
  );
}

/** The screens' action row: Refresh, disabled while a load is in flight, plus anything the screen adds. */
export function CustomerCardActions({ onRefresh, disabled, children }: { onRefresh: () => void; disabled: boolean; children?: ReactNode }) {
  return (
    <div className="customer-card__actions">
      <button type="button" className="btn-xs" onClick={onRefresh} disabled={disabled}>
        {CUSTOMER_VIEW.common.refresh}
      </button>
      {children}
    </div>
  );
}

export type PillTone = 'success' | 'warning' | 'error' | 'muted' | 'info';

/** The Flutter `StatusBadge`: a coloured pill. */
export function StatusPill({ label, tone }: { label: string; tone: PillTone }) {
  return <span className="customer-pill" data-tone={tone}>{label}</span>;
}

/** A `label: value` line with an optional bar beneath it (`_InfoRow`, `_QuotaRow`). */
export function CustomerRow({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="customer-row">
      <div className="customer-row__line">
        <span className="customer-row__label">{label}: </span>
        <span className="customer-row__value">{value}</span>
      </div>
      {children}
    </div>
  );
}
