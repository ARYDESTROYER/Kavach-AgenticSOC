/**
 * CaseHeaderMeta — the case header's meta row (Round 12, CM-2 / SYNTHESIS-ux §3.3).
 *
 * The facts every tab needs, on one wrapping line under the title: id + copy, source
 * severity, risk with its band word, STATUS (glyph + text, no fill), the OUTCOME of
 * record (filled badge, analyst provenance; omitted while pending), the AI verdict
 * (outline chip), the owner (quick reassign), tags (first two + "+n", editable), age and
 * SLA, campaign and the Sample badge. Three grammars, never mixed (D15).
 *
 * SECURITY (#9): every case-derived value (id, owner, tags, campaign name) renders as a
 * plain text node. #3: owner and tag edits are the existing collaboration routes; nothing
 * here changes status, verdict or disposition.
 */
import * as React from 'react';
import { Check, Copy, Info, Plus, Tag as TagIcon, UserRound, X } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';
import { humanizeAge } from '@/lib/format';
import type { Case, SlaPolicy } from '@/lib/types';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

import { AiVerdictChip, OutcomeBadge, SeverityBadge, severityBand } from '@/soc/components/badges';
import { DemoBadge, isDemoCase } from '@/soc/components/DemoBadge';
import type { CaseOutcome } from '@/soc/components/outcome';
import { ProvenanceTag, severityProvenance } from '@/soc/components/ProvenanceTag';
import { scoreBand, semanticIcon } from '@/soc/components/palette';
import type { PickableUser } from '@/soc/pages/CaseDetail.api';
import { CampaignChip } from '@/soc/pages/Campaigns';
import type { Campaign } from '@/soc/pages/Campaigns.api';

import { AssigneePicker } from './CollaborationPanel';
import {
  caseDisplayId,
  caseTags,
  monogram,
  riskValue,
  severityVersusRiskNote,
  slaReading,
  statusWords,
} from './caseFacts';

/** Risk band → text tone. Value-driven: only a high/critical SCORE is coloured. */
const RISK_TONE: Record<string, string> = {
  critical: 'text-critical-text',
  high: 'text-high-text',
  medium: 'text-foreground',
  low: 'text-foreground',
};

const SLA_TONE: Record<string, string> = {
  met: 'text-muted-foreground',
  running: 'text-foreground',
  due_soon: 'text-warning-text',
  breached: 'text-critical-text',
};

const Dot = () => (
  <span aria-hidden className="text-muted-foreground/60">
    ·
  </span>
);

/** Copy the case's display id; confirms in place and via a toast. */
const CopyId: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
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
  campaign?: Campaign | null;
  onOpenCampaign?: () => void;
  users: PickableUser[];
  currentUser?: string | null;
  canAssign: boolean;
  canTag: boolean;
  slaPolicy?: SlaPolicy | null;
  /** The authoritative case after an owner / tag edit (queue + detail sync). */
  onCaseChange: (next: Case) => void;
  /** Controlled owner popover (the M shortcut opens it). */
  ownerOpen: boolean;
  onOwnerOpenChange: (open: boolean) => void;
  /** Controlled tags popover (the T shortcut opens it). */
  tagsOpen: boolean;
  onTagsOpenChange: (open: boolean) => void;
}

export const CaseHeaderMeta: React.FC<CaseHeaderMetaProps> = ({
  c,
  outcome,
  campaign,
  onOpenCampaign,
  users,
  currentUser,
  canAssign,
  canTag,
  slaPolicy,
  onCaseChange,
  ownerOpen,
  onOwnerOpenChange,
  tagsOpen,
  onTagsOpenChange,
}) => {
  const displayId = caseDisplayId(c);
  const severity = severityBand(c.severity_band) ?? severityBand(c.risk_score);
  const risk = riskValue(c.risk_score);
  const band = risk === null ? null : scoreBand(risk);
  const status = String(c.status || '').toLowerCase();
  const StatusGlyph = semanticIcon(status === 'reopened' ? 'investigating' : status);
  const owner = (c.assignee || '').trim();
  const tags = caseTags(c);
  const sla = slaReading(c, slaPolicy);
  const acknowledged = c.acknowledged_at || c.first_response_at;
  const [tagDraft, setTagDraft] = React.useState('');
  const [savingTags, setSavingTags] = React.useState(false);
  const [assigningSelf, setAssigningSelf] = React.useState(false);

  const saveTags = React.useCallback(
    async (next: string[]) => {
      setSavingTags(true);
      try {
        onCaseChange(await api.caseTags(c.case_id, next));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not save the tags.');
      } finally {
        setSavingTags(false);
      }
    },
    [c.case_id, onCaseChange],
  );

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
      className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground"
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-0.5">
        <span data-testid="case-detail-id" className="min-w-0 break-all font-mono text-foreground/80">
          {displayId}
        </span>
        <CopyId value={displayId} />
      </span>

      {severity ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          <SeverityBadge severity={severity} labelSuffix="severity" className="h-5 px-1.5" />
          <ProvenanceTag kind={severityProvenance(c.severity_source)} variant="icon" />
        </span>
      ) : null}

      {risk !== null && band ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="case-detail-risk"
              className="inline-flex shrink-0 items-center gap-1 rounded-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Risk ${risk} of 100, ${band} risk. ${severityVersusRiskNote(c.severity_source)}`}
            >
              <span className={cn('font-medium', RISK_TONE[band])}>Risk {risk}</span>
              <span className="text-muted-foreground">{band.charAt(0).toUpperCase() + band.slice(1)}</span>
              <Info className="size-3" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs text-xs leading-relaxed">
            {severityVersusRiskNote(c.severity_source)}
          </TooltipContent>
        </Tooltip>
      ) : null}

      <Dot />
      <span
        data-testid="case-detail-status"
        className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground"
      >
        {StatusGlyph ? <StatusGlyph className="size-3.5 text-muted-foreground" aria-hidden /> : null}
        {statusWords(c.status)}
      </span>

      <OutcomeBadge outcome={outcome} />
      {c.verdict ? (
        <AiVerdictChip
          verdict={c.verdict}
          confidence={c.confidence}
          className="h-5"
          labelClassName="hidden @[48rem]/case:inline"
        />
      ) : null}

      <Dot />
      <Popover open={ownerOpen} onOpenChange={onOwnerOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="case-detail-owner"
            aria-keyshortcuts="M"
            aria-label={owner ? `Owner ${owner}. Change owner` : 'Unassigned. Choose an owner'}
            className="inline-flex shrink-0 items-center gap-1 rounded-sm text-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {owner ? (
              <span
                aria-hidden
                className="inline-flex size-5 items-center justify-center rounded-full bg-surface-sunken text-2xs font-semibold text-muted-foreground"
              >
                {monogram(owner)}
              </span>
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

      <Popover open={tagsOpen} onOpenChange={onTagsOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="case-detail-tags"
            aria-keyshortcuts="T"
            aria-label={tags.length ? `Tags: ${tags.join(', ')}. Edit tags` : 'No tags. Add a tag'}
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <TagIcon className="size-3.5 shrink-0" aria-hidden />
            {tags.length ? (
              <>
                {tags.slice(0, 2).map((tag) => (
                  <Badge key={tag} variant="outline" className="h-5 max-w-[8rem] truncate px-1.5 font-normal">
                    {tag}
                  </Badge>
                ))}
                {tags.length > 2 ? <span className="text-foreground">+{tags.length - 2}</span> : null}
              </>
            ) : (
              <span>No tags</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-3">
          <p className="text-sm font-semibold text-foreground">Tags</p>
          {tags.length ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Case tags">
              {tags.map((tag) => (
                <li key={tag}>
                  <Badge variant="secondary" className="gap-1 pr-0.5">
                    <span className="max-w-[12rem] truncate">{tag}</span>
                    {canTag ? (
                      <button
                        type="button"
                        aria-label={`Remove tag ${tag}`}
                        disabled={savingTags}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void saveTags(tags.filter((t) => t !== tag))}
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    ) : null}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No tags yet.</p>
          )}
          {canTag ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = tagDraft.trim();
                if (!value || tags.includes(value)) return;
                setTagDraft('');
                void saveTags([...tags, value]);
              }}
            >
              <Input
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                placeholder="Add a tag"
                aria-label="New tag"
                className="h-8"
                maxLength={40}
              />
              <Button type="submit" size="sm" variant="outline" disabled={!tagDraft.trim() || savingTags}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Add
              </Button>
            </form>
          ) : null}
        </PopoverContent>
      </Popover>

      <Dot />
      <span className="inline-flex shrink-0 items-center gap-1 tabular-nums" data-testid="case-detail-times">
        {c.created_at ? <span>Opened {humanizeAge(c.created_at)}</span> : null}
        {acknowledged ? (
          <>
            <Dot />
            <span>Ack {humanizeAge(acknowledged)}</span>
          </>
        ) : null}
      </span>
      {sla ? (
        <span
          data-testid="case-detail-sla"
          data-sla-state={sla.state}
          className={cn('inline-flex shrink-0 items-center gap-1 font-medium', SLA_TONE[sla.state])}
        >
          {sla.priority} · {sla.text}
        </span>
      ) : null}

      {campaign ? (
        /* A generated campaign id can be very long: cap the chip, keep the full name in
           its accessible name and on hover. */
        <span
          className="inline-flex min-w-0 max-w-[12rem] @[56rem]/case:max-w-[16rem]"
          title={campaign.name || campaign.id}
        >
          <CampaignChip
            campaign={campaign}
            onOpen={onOpenCampaign}
            className="inline-flex min-w-0 max-w-full"
          />
        </span>
      ) : null}
      <DemoBadge show={isDemoCase(c)} className="h-5 px-1.5 text-2xs" />
    </div>
  );
};

export default CaseHeaderMeta;
