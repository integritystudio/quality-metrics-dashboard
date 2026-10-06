/**
 * The hub's `_buildNavCard` (lib/pages/dashboard_page.dart): a label, a description and a
 * chevron. Four of the five are links to the org's screens; Observability is an action.
 */
import { Link } from 'wouter';
import { CHEVRON_RIGHT } from '../../lib/symbols.js';

interface NavCardProps {
  label: string;
  description: string;
  href?: string;
  onClick?: () => void;
}

function NavCardBody({ label, description }: Pick<NavCardProps, 'label' | 'description'>) {
  return (
    <>
      <span className="customer-nav-card__text">
        <span className="customer-nav-card__label">{label}</span>
        <span className="customer-nav-card__description">{description}</span>
      </span>
      <span className="customer-nav-card__chevron" aria-hidden="true">{CHEVRON_RIGHT}</span>
    </>
  );
}

export function NavCard({ label, description, href, onClick }: NavCardProps) {
  if (href !== undefined) {
    return (
      <Link href={href} className="card card-link customer-nav-card">
        <NavCardBody label={label} description={description} />
      </Link>
    );
  }
  return (
    <button type="button" className="card card-link customer-nav-card btn-reset" onClick={onClick}>
      <NavCardBody label={label} description={description} />
    </button>
  );
}
