import { Link } from 'wouter';

interface ArrowLinkProps {
  href: string;
  children: string;
  className?: string;
}

export function ArrowLink({ href, children, className }: ArrowLinkProps) {
  return (
    <Link href={href} className={`text-xs link-accent${className ? ` ${className}` : ''}`}>
      {children} &rarr;
    </Link>
  );
}
