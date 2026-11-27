/**
 * AutomationApplied: the SAFE actions threshold automation applied to a case (F10), in the
 * Brief's Decision lane behind "Automation applied (N)" (Round 16, SPEC D8; the
 * Investigation tab's Decision before it). Renders nothing when none ran.
 *
 * Round 16 ([cmux] R8): an approval request reads as one sentence, "Approval requested:
 * acknowledge (automation)", with the proposal named once and "Open in Approvals" for a
 * viewer who can read the queue; the exact recorded detail stays one click away under
 * Details (#2, #9). A detail that does not parse is shown as it was recorded.
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
import { ArrowRight, Bell, BellOff, BookOpen, ChevronDown, Info, Lock, Tag, Zap } from 'lucide-react';

import type { Case } from '@/lib/types';
import { humanizeAge, humanizeToken } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { notifyDelivery } from '@/soc/components/caseActivityText';

import type { ScoreTone } from './shared';

type AutomationMeta = { label: string; icon: React.ComponentType<{ className?: string }>; tone: ScoreTone };

/** Map an automation action verb → label + icon + tone. */
const AUTOMATION_META: Record<string, AutomationMeta> = {
  tag: { label: 'Tagged', icon: Tag, tone: 'info' },
  recommend: { label: 'Recommendation', icon: Info, tone: 'medium' },
  notify: { label: 'Notified', icon: Bell, tone: 'info' },
  // A record from before Round 14 keeps its token; the label is Console-authored.
  run_playbook: { label: 'Older runbook automation', icon: BookOpen, tone: 'low' },
  request_approval: { label: 'Proposed (needs approval)', icon: Lock, tone: 'high' },
};

/** What an "Attach a runbook" action records (`engine/threshold_automation.py`). */
const ATTACH_RUNBOOK_DETAIL = /^attach_runbook=(.*) attached=(True|False)$/s;

/** What a "Request approval" action records (`engine/threshold_automation.py`). */
const APPROVAL_DETAIL = /^proposal=(\S+) kind=([a-z_]+)$/;

/** The words for a proposal kind (the `Proposal.kind` vocabulary). */
const PROPOSAL_KIND_WORDS: Record<string, string> = {
  automation_ack: 'acknowledge (automation)',
  suppression: 'a suppression rule',
  memory: 'a memory note',
  tuning: 'a threshold change',
};

/** An approval request in words, or null when its detail does not parse. */
export function approvalRequest(detail: unknown): { proposalId: string; words: string } | null {
  if (typeof detail !== 'string') return null;
  const hit = APPROVAL_DETAIL.exec(detail.trim());
  if (!hit) return null;
  const words = PROPOSAL_KIND_WORDS[hit[2]];
  return words ? { proposalId: hit[1], words } : null;
}

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

/** The exact recorded detail, one click away (#2: shown as recorded; #9: plain text). */
const RecordedDetail: React.FC<{ detail: string }> = ({ detail }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1">
      <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/* UNTRUSTED: plain text, exactly as recorded. */}
        <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{detail}</p>
      </CollapsibleContent>
    </Collapsible>
  );
};

export interface AutomationAppliedProps {
  c: Case;
  className?: string;
  /** Open the Approvals queue (offered only to a viewer who can read it). */
  onOpenApprovals?: () => void;
  /** Show the panel's own heading (off inside the Brief's "Automation applied (N)"). */
  heading?: boolean;
}

export const AutomationApplied: React.FC<AutomationAppliedProps> = ({
  c,
  className,
  onOpenApprovals,
  heading = false,
}) => {
  const actions = Array.isArray(c.automation_actions) ? c.automation_actions : [];
  if (!actions.length) return null;
  return (
    <div className={className} data-testid="automation-applied">
      {heading ? <h3 className="text-sm font-semibold text-foreground">Automation applied</h3> : null}
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
          const approval = String(a.action || '') === 'request_approval' ? approvalRequest(a.detail) : null;
          // The proposal is named once: the parsed detail's id, else the record's own.
          const proposalId = approval?.proposalId || a.proposal_id || '';
          return (
            <li key={`${a.rule_id || a.action || i}-${i}`} className="flex items-start gap-3 py-2.5 text-sm">
              <Badge variant={meta.tone === 'low' ? 'success' : meta.tone} className="shrink-0 gap-1">
                <Icon className="h-3 w-3" />
                {meta.label}
              </Badge>
              <div className="min-w-0 flex-1">
                {approval ? (
                  <p className="text-foreground/90" data-testid="automation-approval">
                    Approval requested: {approval.words}
                  </p>
                ) : a.detail ? (
                  /* UNTRUSTED: plain text. */
                  <p className="whitespace-pre-wrap break-words text-foreground/90">{a.detail}</p>
                ) : null}
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {a.rule_id ? <span className="font-mono">rule {a.rule_id}</span> : null}
                  {proposalId ? <span className="font-mono">proposal {proposalId}</span> : null}
                  {a.at ? <span>{humanizeAge(a.at)}</span> : null}
                  {approval && onOpenApprovals ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={onOpenApprovals}
                    >
                      Open in Approvals
                      <ArrowRight className="h-3 w-3" aria-hidden />
                    </Button>
                  ) : null}
                </div>
                {approval && a.detail ? <RecordedDetail detail={a.detail} /> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default AutomationApplied;
