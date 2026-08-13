/**
 * Navigation type contracts for the SOC shell router.
 *
 * `NavOpts` lived in `lib/types.ts` historically; it is a UI-only navigation
 * contract (not a backend data mirror), so Round-5 moves it here next to the
 * router/shell that owns it. `lib/types.ts` keeps a re-export shim so existing
 * `import type { NavOpts } from '@/lib/types'` sites keep working unchanged.
 */

/**
 * Navigation options threaded through `Navigate` (router.tsx / App.tsx) so
 * deep-links / drill-throughs can pre-seed a destination page's filters/tab.
 * All fields are optional and additive. Most are carried in memory only; `caseId`
 * is serialized for Cases / Case Manager so an exact selected-case handoff survives
 * refresh and browser history.
 *
 * `section`/`anchor` (Round-5 Sett-C) are also serialized: for the `settings` page they
 * are serialized into the URL hash (`#/settings?s=<section>&a=<anchor>`) so a Cmd-K
 * jump / card-level deep-link survives a full hashchange. They are ignored for every
 * other page.
 */
export type NavOpts = {
  caseId?: string;
  status?: string;
  /** Exact assignee value as useful result context; it is not a stored job-ID cohort. */
  assignee?: string;
  /** Exact tag value as useful result context; it is not a stored job-ID cohort. */
  tag?: string;
  /**
   * Severity-band drill-through (Round-6 #38): a coarse band the destination Cases view
   * seeds its severity filter from — one of `critical | high | medium | low | info`
   * (matching the Cases severity dropdown + `severityBand`). Lets the Overview
   * Critical/High KPI + the open-by-severity rows deep-link to a severity-filtered list.
   */
  severity?: string;
  /** Exact Noise Reduction outcome cohort used by the dashboard drill-through. */
  noiseOutcome?: 'auto_cleared' | 'escalated' | 'closed';
  window?: number;
  tab?: string;
  /** Settings section id — serialized to `#/settings?s=<section>`. */
  section?: string;
  /** In-section card anchor — serialized to `&a=<anchor>` for a scroll+highlight. */
  anchor?: string;
};
