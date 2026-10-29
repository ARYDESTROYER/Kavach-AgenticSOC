/**
 * The one https-only link helper for runbook references and step evidence links (Round 14,
 * SPEC §4.10.2 `references`, §4.10.7 `StepEvidence.url`; WP-0 hand-off to W7a and W7b).
 *
 * Runbook text is operator-authored and a draft may hold any text in `references`, and a
 * step evidence link is typed by an analyst: neither is ever trusted as a URL just because
 * it is stored. Only an absolute `https:` URL with a host, no credentials and no control
 * or white-space characters becomes a link; anything else is shown as plain text, so a
 * `javascript:`, `data:`, `http:` or protocol-relative value can never run or leave the
 * Console unannounced. React does not sanitise `href`, so this check is the only gate:
 * every runbook surface renders a reference through {@link RunbookExternalLink}.
 */
import * as React from 'react';
import { ExternalLink } from 'lucide-react';

import { cn } from '@/lib/cn';

/** The longest link the model stores (`RUNBOOK_EVIDENCE_MAX_URL_CHARS`). */
export const RUNBOOK_LINK_MAX_CHARS = 500;

// eslint-disable-next-line no-control-regex -- exactly the characters a URL parser strips or splits on
const UNSAFE_CHARS = /[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff\\]/;

/**
 * `value` as a safe absolute https URL string, or `null`. The check runs on the raw value
 * (no trimming: a value with surrounding spaces is not what was stored as a link) and on
 * what the URL parser makes of it: the scheme must be `https:`, the host present, and no
 * user name or password embedded.
 */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value || value.length > RUNBOOK_LINK_MAX_CHARS) return null;
  if (UNSAFE_CHARS.test(value)) return null;
  if (!/^https:\/\/[^/]/i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return url.href;
}

export interface RunbookExternalLinkProps {
  /** The stored value: a link when it passes {@link safeHttpsUrl}, plain text otherwise. */
  href: string;
  /** Visible text; defaults to the stored value. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * A runbook reference or evidence link: an `<a>` that opens in a new tab (with
 * `noopener noreferrer`) when the value is a safe https URL, otherwise the value as plain
 * text with a note for assistive technology that it is not a link.
 */
export function RunbookExternalLink({ href, children, className }: RunbookExternalLinkProps) {
  const safe = safeHttpsUrl(href);
  if (!safe) {
    return (
      <span className={cn('[overflow-wrap:anywhere]', className)} data-runbook-link="text">
        {children ?? href}
        <span className="sr-only"> (not a secure https link, shown as text)</span>
      </span>
    );
  }
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      data-runbook-link="https"
      className={cn(
        'inline-flex max-w-full items-baseline gap-1 rounded-sm text-primary underline-offset-2 [overflow-wrap:anywhere] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <span className="min-w-0">{children ?? href}</span>
      <ExternalLink className="size-3 shrink-0 self-center" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
