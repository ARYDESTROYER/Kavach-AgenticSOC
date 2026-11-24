/**
 * AutomationApplied: the SAFE actions threshold automation applied to a case (F10), under
 * the decision on the Investigation tab (Round 15, SPEC D8.3; it was in the Overview's
 * "Provenance & audit" disclosure). Renders nothing when none ran.
 *
 * Non-binding: automation can tag, recommend, notify, attach a runbook, queue a
 * re-investigation or draft a proposal, but NEVER sets the case status (#3). Every detail
 * text is operator- or agent-authored, rendered as plain text (#9).
 *
 * A `notify` record says whether the notification went out: its detail notes "Not sent"
 * or "Partly sent" with the reason when it did not all go (`notifyDelivery`, the reading
 * the case activity uses), so the label never claims a send that did not happen.
 *
 * A `run_playbook` record keeps its stored token (the naming contract). Since Round 14 the
 * action is the rule editor's "Attach a runbook" and records whether it attached one; a
 * record from before Round 14 keeps its legacy name (Round 14 SPEC §3.1). Console copy
 * never says "playbook".
 */
import * as React from 'react';
import { Bell, BellOff, BookOpen, Info, Lock, Tag, Zap } from 'lucide-react';

import type { Case } from '@/lib/types';
import { humanizeAge, humanizeToken } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { notifyDelivery } from '@/soc/components/caseActivityText';

import type { ScoreTone } from './shared';

type AutomationMeta = { label: string; icon: React.ComponentType<{ className?: string }>; tone: ScoreTone };

/** Map an automation action verb → label + icon + tone. */
const AUTOMATION_META: Record<string, AutomationMeta> = {
  tag: { label: 'Tagged', icon: Tag, tone: 'info' },
  recommend: { label: 'Recommendation', icon: Info, tone: 'medium' },
  notify: { label: 'Notified', icon: Bell, tone: 'info' },
  // A record from before Round 14 keeps its token; the label is Console-authored.
  run_playbook: { label: 'Runbook automation (before Round 14)', icon: BookOpen, tone: 'low' },
  request_approval: { label: 'Proposed (needs approval)', icon: Lock, tone: 'high' },
};

/** What an "Attach a runbook" action records (`engine/threshold_automation.py`). */
const ATTACH_RUNBOOK_DETAIL = /^attach_runbook=(.*) attached=(True|False)$/s;

/** The label of an automation record (see the module note). */
export function automationMeta(action: string, detail: unknown): AutomationMeta | undefined {
  if (action === 'notify') {
    const { delivery } = notifyDelivery(detail);
    if (delivery === 'not_sent') return { label: 'Not notified', icon: BellOff, tone: 'high' };
    if (delivery === 'partly_sent') return { label: 'Partly notified', icon: Bell, tone: 'medium' };
    return AUTOMATION_META.notify;
  }
  if (action !== 'run_playbook') return AUTOMATION_META[action];
  const attach = typeof detail === 'string' ? ATTACH_RUNBOOK_DETAIL.exec(detail) : null;
  if (!attach) return AUTOMATION_META.run_playbook;
  return attach[2] === 'True'
    ? { label: 'Runbook attached', icon: BookOpen, tone: 'low' }
    : { label: 'Runbook not attached', icon: BookOpen, tone: 'info' };
}

export const AutomationApplied: React.FC<{ c: Case; className?: string }> = ({ c, className }) => {
  const actions = Array.isArray(c.automation_actions) ? c.automation_actions : [];
  if (!actions.length) return null;
  return (
    <div className={className} data-testid="automation-applied">
      <h3 className="text-sm font-semibold text-foreground">Automation applied</h3>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
        What threshold automation did after the decision. It can tag, recommend, notify,
        attach a runbook, queue a re-investigation or draft a proposal; it never changes the
        lifecycle status or closes a case.
      </p>
      <ul className="mt-2 divide-y divide-border/60">
        {actions.map((a, i) => {
          const meta = automationMeta(String(a.action || ''), a.detail) || {
            label: humanizeToken(String(a.action || 'Action')),
            icon: Zap,
            tone: 'info' as ScoreTone,
          };
          const Icon = meta.icon;
          return (
            <li key={`${a.rule_id || a.action || i}-${i}`} className="flex items-start gap-3 py-2.5 text-sm">
              <Badge variant={meta.tone === 'low' ? 'success' : meta.tone} className="shrink-0 gap-1">
                <Icon className="h-3 w-3" />
                {meta.label}
              </Badge>
              <div className="min-w-0 flex-1">
                {a.detail ? (
                  /* UNTRUSTED: plain text. */
                  <p className="whitespace-pre-wrap break-words text-foreground/90">{a.detail}</p>
                ) : null}
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {a.rule_id ? <span className="font-mono">rule {a.rule_id}</span> : null}
                  {a.proposal_id ? <span className="font-mono">proposal {a.proposal_id}</span> : null}
                  {a.at ? <span>{humanizeAge(a.at)}</span> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default AutomationApplied;
