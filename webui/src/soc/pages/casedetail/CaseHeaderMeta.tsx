/**
 * CaseHeaderMeta: the case header's one meta row (Round 12, CM-2; Round 15, SPEC D8.2).
 *
 * The facts every tab needs, on one wrapping line under the title, in this order: the
 * case number with its copy control, severity, the STATUS while the case is open or the
 * OUTCOME of record once it ended (never both, the same rule as a queue row), the AI
 * verdict (outline chip), the owner (its one editable home: quick reassign and "Assign to
 * me"), the opened age and, while the case is open, the SLA. Tags, the campaign, the risk
 * reading, Ask AI and the Sample mark live in the facts rail.
 *
 * SECURITY (#9): every case-derived value (id, owner) renders as a plain text node. #3:
 * the owner edit is the existing collaboration route; nothing here changes status,
 * verdict or disposition.
 */
import * as React from 'react';
import { Check, Copy, UserRound } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';
import { humanizeAge } from '@/lib/format';
import type { Case, SlaPolicy } from '@/lib/types';

import { Button } from '@/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

import { AiVerdictChip, OutcomeBadge, SeverityBadge, severityBand } from '@/soc/components/badges';
import { OwnerMonogram, assignedToLabel } from '@/soc/components/OwnerMonogram';
import type { CaseOutcome } from '@/soc/components/outcome';
import { semanticIcon } from '@/soc/components/palette';
import type { PickableUser } from '@/soc/pages/CaseDetail.api';

import { AssigneePicker } from './AssigneePicker';
import { caseDisplayId, slaReading, statusWords } from './caseFacts';

const SLA_TONE: Record<string, string> = {
  met: 'text-muted-foreground',
  running: 'text-foreground',
  due_soon: 'text-warning-text',
  breached: 'text-critical-text',
};

/** Copy the case's display id; confirms in place and via a toast. */
const CopyId: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={copied ? 'Case ID copied' : 'Copy case ID'}
          onClick={() =>
            void copyText(value).then((ok) => {
              if (!ok) {
                toast.error('Could not copy the case ID.');
                return;
              }
              setCopied(true);
              toast.success('Case ID copied.');
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success-text" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{copied ? 'Copied' : 'Copy case ID'}</TooltipContent>
    </Tooltip>
  );
};

export interface CaseHeaderMetaProps {
  c: Case;
  outcome: CaseOutcome;
  users: PickableUser[];
  currentUser?: string | null;
  canAssign: boolean;
  slaPolicy?: SlaPolicy | null;
  /** The authoritative case after an owner edit (queue + detail sync). */
  onCaseChange: (next: Case) => void;
  /** Controlled owner popover (the M shortcut opens it). */
  ownerOpen: boolean;
  onOwnerOpenChange: (open: boolean) => void;
}

export const CaseHeaderMeta: React.FC<CaseHeaderMetaProps> = ({
  c,
  outcome,
  users,
  currentUser,
  canAssign,
  slaPolicy,
  onCaseChange,
  ownerOpen,
  onOwnerOpenChange,
}) => {
  const displayId = caseDisplayId(c);
  const severity = severityBand(c.severity_band) ?? severityBand(c.risk_score);
  const status = String(c.status || '').toLowerCase();
  const StatusGlyph = semanticIcon(status === 'reopened' ? 'investigating' : status);
  const owner = (c.assignee || '').trim();
  const sla = slaReading(c, slaPolicy);
  // Once the case ended, its outcome of record replaces the status (never both).
  const showOutcome = outcome.terminal && outcome.source !== 'pending';
  const [assigningSelf, setAssigningSelf] = React.useState(false);

  const assignToMe = React.useCallback(async () => {
    if (!currentUser) return;
    setAssigningSelf(true);
    try {
      onCaseChange(await api.caseAssign(c.case_id, currentUser));
      onOwnerOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not assign the case.');
    } finally {
      setAssigningSelf(false);
    }
  }, [c.case_id, currentUser, onCaseChange, onOwnerOpenChange]);

  return (
    <div
      data-testid="case-detail-meta"
      className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground"
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-0.5">
        <span data-testid="case-detail-id" className="min-w-0 break-all font-mono text-foreground/80">
          {displayId}
        </span>
        <CopyId value={displayId} />
      </span>

      {severity ? (
        <SeverityBadge severity={severity} labelSuffix="severity" className="h-5 shrink-0 px-1.5" />
      ) : null}

      {showOutcome ? (
        <OutcomeBadge outcome={outcome} className="shrink-0" />
      ) : (
        <span
          data-testid="case-detail-status"
          className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground"
        >
          {StatusGlyph ? <StatusGlyph className="size-3.5 text-muted-foreground" aria-hidden /> : null}
          {statusWords(c.status)}
        </span>
      )}

      {c.verdict ? (
        <AiVerdictChip
          verdict={c.verdict}
          confidence={c.confidence}
          className="h-5 shrink-0"
          labelClassName="hidden @[48rem]/case:inline"
        />
      ) : null}

      <Popover open={ownerOpen} onOpenChange={onOwnerOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="case-detail-owner"
            aria-keyshortcuts="M"
            aria-label={owner ? `${assignedToLabel(owner)}. Change owner` : 'Unassigned. Choose an owner'}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-sm text-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {owner ? (
              /* The button's label already names the owner: the disk is decorative here. */
              <OwnerMonogram name={owner} decorative />
            ) : (
              <UserRound className="size-3.5 text-muted-foreground" aria-hidden />
            )}
            <span className={cn('max-w-[10rem] truncate', !owner && 'text-muted-foreground')}>
              {owner || 'Unassigned'}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-3">
          <p className="text-sm font-semibold text-foreground">Owner</p>
          <AssigneePicker
            c={c}
            users={users}
            canWrite={canAssign}
            onAssigned={(next) => {
              onCaseChange(next);
              onOwnerOpenChange(false);
            }}
          />
          {canAssign && currentUser && owner.toLowerCase() !== currentUser.toLowerCase() ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full"
              disabled={assigningSelf}
              onClick={() => void assignToMe()}
            >
              Assign to me
            </Button>
          ) : null}
          {!canAssign ? (
            <p className="text-xs text-muted-foreground">You can view the owner but not change it.</p>
          ) : null}
        </PopoverContent>
      </Popover>

      <span className="inline-flex shrink-0 items-center gap-1 tabular-nums" data-testid="case-detail-times">
        {c.created_at ? <span>Opened {humanizeAge(c.created_at)}</span> : null}
      </span>
      {sla && !outcome.terminal ? (
        <span
          data-testid="case-detail-sla"
          data-sla-state={sla.state}
          className={cn('inline-flex shrink-0 items-center gap-1 font-medium', SLA_TONE[sla.state])}
        >
          {sla.priority} · {sla.text}
        </span>
      ) : null}
    </div>
  );
};

export default CaseHeaderMeta;
