import * as React from 'react';
import { PageHeader } from './PageHeader';
import type { LucideIcon } from 'lucide-react';

export interface HeroPanelProps {
  /** @deprecated Round 14 (C8): page headers carry no overline. Ignored. */
  eyebrow?: string;
  /** Main title. Plain text. */
  title: string;
  /**
   * The page's explanation, one or two plain sentences. Shown in the help tip beside the
   * title (Round 14, C8), never as a line under it.
   */
  description?: string;
  /** @deprecated Round 14 (C8): no icon chip beside a page title. Ignored. */
  icon?: LucideIcon;
  /** Right-aligned meta (e.g. "Last refresh ..."), rendered above actions. */
  meta?: React.ReactNode;
  /** Right-aligned actions slot (toggles, refresh button, etc.). */
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
  /** Optional stable test anchor forwarded to the header root. */
  'data-testid'?: string;
}

/**
 * @deprecated `HeroPanel` is a thin wrapper over the one page header (`PageHeader`), kept
 * only for `CommandCenterLayout`. New code uses `PageHeader` directly.
 *
 * Round 14 (SPEC §4.9.3): it renders the Overview grammar like every page header: the
 * title with its explanation in the help tip, no overline, no icon chip and no hero band.
 * The right-side `meta` over `actions` stack is kept in the header's `actions` slot.
 * Every string renders as plain text (#9).
 */
export function HeroPanel({
  title,
  description,
  meta,
  actions,
  className,
  children,
  'data-testid': dataTestId,
}: HeroPanelProps) {
  const right =
    meta || actions ? (
      <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
        {meta ? <div className="text-sm tabular-nums text-muted-foreground">{meta}</div> : null}
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    ) : undefined;

  return (
    <>
      <PageHeader
        title={title}
        help={description}
        actions={right}
        className={className}
        data-testid={dataTestId}
      />
      {children}
    </>
  );
}

export default HeroPanel;
