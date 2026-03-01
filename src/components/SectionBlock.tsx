import type { ReactNode } from 'react';

interface SectionBlockProps {
  label: string;
  className?: string; // appended after "mb-3"
  children: ReactNode;
}

export function SectionBlock({ label, className, children }: SectionBlockProps) {
  return (
    <div className={`mb-3${className ? ` ${className}` : ''}`}>
      <div className="section-label mb-1-5">{label}</div>
      {children}
    </div>
  );
}
