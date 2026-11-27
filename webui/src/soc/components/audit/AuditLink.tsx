/**
 * A link into the audit log (Round 14 SPEC §4.5.8): the Case trace ("View in audit
 * log"), Users ("Audit events for this user") and the Account page link here. It is an
 * `<a href>` (a navigation, never a button that changes the hash), shown only to people
 * who hold `audit:view`, and it opens the log through the router so a page's leave guard
 * is asked first.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import type { NavOpts } from '@/lib/types';
import { useCan } from '@/soc/components/Can';
import { pageHash } from '@/soc/router';
import { useRouteLinkClick } from '@/soc/route-link';

export interface AuditLogLinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** The audit log filters to open with (`scope`, `case`, `actor`, `target`, ...). */
  opts: NavOpts;
  children: React.ReactNode;
}

/**
 * Whether the person may read the audit log. Outside an `AuthProvider` (a component
 * rendered on its own, as many tests do) there is no grant to read, so the link stays
 * hidden rather than throwing.
 */
function useAuditReadable(): boolean {
  try {
    return useCan('audit', 'view');
  } catch {
    return false;
  }
}

export function AuditLogLink({ opts, children, className, onClick, ...rest }: AuditLogLinkProps) {
  const allowed = useAuditReadable();
  const href = pageHash('audit', opts);
  const follow = useRouteLinkClick(href, onClick);
  if (!allowed) return null;
  return (
    <a
      href={href}
      onClick={follow}
      className={cn(
        'rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...rest}
    >
      {children}
    </a>
  );
}
