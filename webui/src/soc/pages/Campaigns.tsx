/**
 * Campaigns — the cross-case CAMPAIGN surface (Round 4 / Wave 4).
 *
 * READ-ONLY views over the running campaign list the deterministic clustering pass
 * (`backend/app/engine/campaigns.py`) produces: a list of campaigns (member count,
 * shared entities, MITRE union, severity rollup, first/last seen), a detail slide-over
 * with the member cases + shared entities + MITRE, and a manual "Recorrelate" action
 * (admin) that re-runs the deterministic pass on demand.
 *
 * RBAC: the whole page is gated behind <ProtectedRoute resource="cases" action="read">.
 * The manual pass and policy writer additionally require `users:manage` in the UI and
 * the matching administrator dependency server-side, so the analyst review remains
 * the default read-only surface without controls that will predictably return 403.
 *
 * ⛔ ADVISORY ONLY (#3/#4): a campaign is a reporting grouping. It NEVER force-merges
 * cases, recomputes a `cluster_signature`, or feeds the deterministic `decide()`. A
 * NEEDS_HUMAN case that joins a campaign stays NEEDS_HUMAN.
 *
 * SECURITY (#9): every campaign name / entity `value` / MITRE id is source-derived
 * PLAIN data, rendered as plain text / <InlineCode> — never HTML, never into a prompt.
 *
 * Also exports <CampaignChip> — a small "part of campaign X" chip CaseDetail mounts to
 * link a case to its campaign.
 */
import * as React from 'react';
import { Network, Loader2, ArrowRight, Layers } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Callout, LoadingState, Panel, PANEL_GAP } from '@/design-system';
import { humanizeToken, humanizeAge, fmtNumber, DASH } from '@/lib/format';
import { useNavigateOptional, type Navigate } from '@/soc/router';
import type { CampaignConfig } from '@/lib/types';

import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Separator } from '@/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';

import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { errorMessage } from '@/lib/errorMessage';
import { InlineCode } from '@/soc/components/CodeBlock';
import { SeverityBadge } from '@/soc/components/badges';
import { ProtectedRoute, useCan } from '@/soc/components/Can';
import { Field } from '@/soc/components/Field';
import { StickySaveBar } from '@/soc/components/SettingsGrid';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { useConfigEditor } from '@/soc/components/rules';
import {
  campaignsApi,
  CAMPAIGN_ENTITY_KIND_LABELS,
  CAMPAIGN_STATUS_LABELS,
  type Campaign,
} from './Campaigns.api';

/** Backend defaults (mirror `config.CampaignConfig`). */
const DEFAULT_CAMPAIGN_CONFIG: Required<CampaignConfig> = {
  enabled: false,
  cadence: 'daily',
};

const CAMPAIGN_CADENCES: NonNullable<CampaignConfig['cadence']>[] = [
  'hourly',
  'daily',
  'weekly',
  'manual',
];

/**
 * A shared entity's kind in the console's words ("IP", "File hash"; `humanizeToken` turned
 * "ip" into "Ip"). An unknown kind reads in sentence case.
 */
function entityKindLabel(type: string): string {
  const key = type.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CAMPAIGN_ENTITY_KIND_LABELS, key) ? CAMPAIGN_ENTITY_KIND_LABELS[key] : humanizeToken(type);
}

/**
 * A campaign's readable label (Round 14, D29): the entity its cases share and how many
 * cases there are ("198.51.100.23 · 3 cases"), else its first MITRE technique, else its
 * display number or id. The id itself stays in the detail sheet. Source-derived values
 * (#9) are joined as plain text.
 */
export function campaignLabel(c: Pick<Campaign, 'id' | 'name' | 'case_count' | 'entities' | 'mitre'>): string {
  const cases = `${fmtNumber(c.case_count)} ${c.case_count === 1 ? 'case' : 'cases'}`;
  const entity = c.entities.find((e) => typeof e.value === 'string' && e.value.trim())?.value.trim();
  if (entity) return `${entity} · ${cases}`;
  const technique = c.mitre.find((m) => typeof m === 'string' && m.trim())?.trim();
  if (technique) return `${technique} · ${cases}`;
  return c.name || c.id;
}

/** What the label is built from, in words ("Shared IP", "Shared MITRE technique"). */
function campaignBasis(c: Pick<Campaign, 'entities' | 'mitre'>): string | null {
  const entity = c.entities.find((e) => typeof e.value === 'string' && e.value.trim());
  if (entity) {
    const kind = entityKindLabel(entity.entity_type);
    // "IP", "URL" keep their capitals; other kinds read in the sentence ("shared file hash").
    return `shared ${/^[A-Z0-9]+$/.test(kind) ? kind : kind.toLowerCase()}`;
  }
  return c.mitre.some((m) => typeof m === 'string' && m.trim()) ? 'shared MITRE technique' : null;
}

/** Map a campaign status to a Badge variant. */
function statusVariant(status: string): 'success' | 'info' | 'secondary' {
  if (status === 'open') return 'success';
  if (status === 'monitoring') return 'info';
  return 'secondary';
}

export interface CampaignsProps {
  onNavigate?: Navigate;
}

export default function Campaigns({ onNavigate }: CampaignsProps) {
  return (
    <ProtectedRoute resource="cases" action="read">
      <CampaignsInner onNavigate={onNavigate} />
    </ProtectedRoute>
  );
}

export function CampaignsInner({ onNavigate }: CampaignsProps) {
  // Coupling-A: prop wins (host/test); else resolve navigate from the router context.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  // BUG #9: "Recorrelate" is admin-gated server-side (require_admin == users:manage).
  // A `cases:read` user must not see policy or execution controls that will 403 — gate
  // the complete administrator workspace on the SAME grant. The server remains
  // authoritative for every mutation.
  const canManage = useCan('users', 'manage');
  const [campaigns, setCampaigns] = React.useState<Campaign[]>([]);
  const [enabled, setEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [hasLoaded, setHasLoaded] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [recorrelating, setRecorrelating] = React.useState(false);
  const [detail, setDetail] = React.useState<Campaign | null>(null);
  const [workspace, setWorkspace] = React.useState<'review' | 'policy'>('review');

  // The shared `api.campaign` client now targets the PLURAL `campaigns/config` route
  // (`routes_campaigns.py`); use it directly so there is ONE config client (Round-6 §27).
  const cfg = useConfigEditor<CampaignConfig>(api.campaign, DEFAULT_CAMPAIGN_CONFIG);
  const cfgDraft = { ...DEFAULT_CAMPAIGN_CONFIG, ...cfg.draft };

  const saveConfig = React.useCallback(async () => {
    try {
      const saved = await cfg.save();
      setEnabled(Boolean(saved.enabled));
      toast.success('Campaign policy saved.');
    } catch (e) {
      toast.error(errorMessage(e, 'Could not save the campaign policy.'));
    }
  }, [cfg]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await campaignsApi.list();
      setCampaigns(res.campaigns ?? []);
      setEnabled(Boolean(res.enabled));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const initialLoading = loading && !hasLoaded;

  const recorrelate = React.useCallback(async () => {
    setRecorrelating(true);
    try {
      const res = await campaignsApi.recorrelate();
      setCampaigns(res.campaigns ?? []);
      toast.success(
        `Re-correlated: ${fmtNumber(res.count)} campaign${res.count === 1 ? '' : 's'}.`,
      );
    } catch (e) {
      toast.error(errorMessage(e, 'Could not re-correlate campaigns.'));
    } finally {
      setRecorrelating(false);
    }
  }, []);

  const columns = React.useMemo<DataTableColumn<Campaign>[]>(
    () => [
      {
        id: 'name',
        header: 'Campaign',
        lockVisible: true,
        minWidth: 280,
        text: (c) => campaignLabel(c),
        cell: (c) => {
          const basis = campaignBasis(c);
          const status = humanizeToken(CAMPAIGN_STATUS_LABELS[c.status] ?? c.status);
          return (
            // A readable label from the shared entity and the case count (D29); the
            // internal id stays in the detail sheet.
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-medium text-foreground">{campaignLabel(c)}</span>
              <span className="truncate text-xs text-muted-foreground">{basis ? `${status} · ${basis}` : status}</span>
            </div>
          );
        },
      },
      {
        id: 'cases',
        header: 'Cases',
        kind: 'number',
        width: '5.5rem',
        cell: (c) => fmtNumber(c.case_count),
      },
      {
        id: 'severity',
        header: 'Severity',
        width: '6.5rem',
        text: (c) => (c.severity_rollup ? humanizeToken(c.severity_rollup) : 'Not graded'),
        cell: (c) =>
          c.severity_rollup ? (
            <SeverityBadge severity={c.severity_rollup} className="px-1.5 text-2xs" />
          ) : (
            <span className="text-xs text-muted-foreground">{DASH}</span>
          ),
      },
      {
        id: 'entities',
        header: 'Shared entities',
        width: '15rem',
        text: (c) => c.entities.map((e) => e.value).join(', '),
        cell: (c) =>
          c.entities.length ? (
            <div className="flex min-w-0 items-center gap-1">
              {c.entities.slice(0, 2).map((e, i) => (
                <InlineCode key={`${e.entity_type}:${e.value}:${i}`} className="min-w-0 truncate" title={e.value}>
                  {e.value}
                </InlineCode>
              ))}
              {c.entities.length > 2 ? (
                <span className="shrink-0 text-xs text-muted-foreground">+{c.entities.length - 2}</span>
              ) : null}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">{DASH}</span>
          ),
      },
      {
        id: 'mitre',
        header: 'MITRE',
        width: '12rem',
        text: (c) => c.mitre.join(', '),
        cell: (c) =>
          c.mitre.length ? (
            <div className="flex min-w-0 items-center gap-1">
              {c.mitre.slice(0, 2).map((m) => (
                <Badge key={m} variant="outline" className="shrink-0">
                  {m}
                </Badge>
              ))}
              {c.mitre.length > 2 ? (
                <span className="shrink-0 text-xs text-muted-foreground">+{c.mitre.length - 2}</span>
              ) : null}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">{DASH}</span>
          ),
      },
      {
        id: 'last_seen',
        header: 'Last seen',
        kind: 'time',
        width: '7rem',
        align: 'right',
        cell: (c) => <span className="text-sm text-muted-foreground">{humanizeAge(c.last_seen)}</span>,
      },
    ],
    [],
  );

  const reviewWorkspace = initialLoading ? (
    <LoadingState
      label="Loading campaigns"
      description="Preparing related-case groups and shared threat context."
      layout="page"
      shape="rows"
      shapeRows={6}
    />
  ) : (
    <div className={cn('flex flex-col', PANEL_GAP)}>
      {!enabled ? (
        <Callout intent="warning" title="Automatic campaign correlation is off">
          Existing groups stay available.
          {canManage ? ' Run the correlation now or set its schedule in Policy and schedule.' : ' An administrator can run it or set its schedule.'}
        </Callout>
      ) : null}

      {error ? (
        <LoadError
          error={error}
          title="Could not load campaigns"
          fallback="Could not load campaigns."
          onRetry={() => void load()}
        />
      ) : null}

      {!(error && campaigns.length === 0) ? (
        <Panel title="Active campaigns" padding="none" data-testid="campaigns-panel">
          <DataTable
            surface="panel"
            columns={columns}
            rows={campaigns}
            getRowId={(c) => c.id}
            loading={loading && campaigns.length > 0}
            onRowClick={(c) => setDetail(c)}
            getRowActionLabel={(c) => `Open campaign ${campaignLabel(c)}`}
            ariaLabel="Campaigns"
            emptyState={
              <div className="px-4 pb-4 xl:px-5 3xl:px-6">
                <EmptyState
                  icon={Network}
                  compact
                  title="No campaigns yet"
                  description="Related cases appear here after the deterministic campaign pass finds a shared entity or MITRE technique."
                />
              </div>
            }
          />
        </Panel>
      ) : null}
    </div>
  );

  const policyWorkspace = cfg.error ? (
    <LoadError
      error={cfg.error}
      title="Could not load campaign policy"
      fallback="Could not load the campaign policy."
      onRetry={() => void cfg.reload()}
    />
  ) : cfg.loading ? (
    <LoadingState
      label="Loading campaign policy"
      description="Preparing the saved cross-case correlation configuration."
      layout="panel"
      shape="panel"
    />
  ) : (
    <Panel
      title="Automatic campaign correlation"
      caption="Groups cases for investigation context. It never merges cases, changes a cluster signature, or takes part in the close or escalate decision."
      actions={
        <Button size="sm" onClick={() => void recorrelate()} disabled={recorrelating}>
          {recorrelating ? (
            <Loader2 className="mr-1.5 size-4 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Layers className="mr-1.5 size-4" aria-hidden />
          )}
          Run correlation now
        </Button>
      }
      data-testid="campaign-policy"
    >
      <fieldset className="divide-y divide-border/70">
        <legend className="sr-only">Campaign correlation policy</legend>

        <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="campaign-enabled" className="text-sm font-medium">
              Enable scheduled correlation
            </Label>
            <p className="text-sm text-muted-foreground">Run the campaign pass automatically at the selected cadence.</p>
          </div>
          <Switch
            id="campaign-enabled"
            checked={cfgDraft.enabled}
            onCheckedChange={(v) => cfg.update({ enabled: v })}
          />
        </div>

        <div className="grid gap-3 pt-4 sm:grid-cols-[minmax(0,1fr)_18rem] sm:items-start">
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-foreground">Correlation cadence</p>
            <p className="text-sm text-muted-foreground">Manual runs stay available whatever the saved schedule.</p>
          </div>
          <Field label="Correlation cadence" hideLabel>
            {({ id, labelledBy, describedBy }) => (
              <Select
                value={cfgDraft.cadence ?? 'daily'}
                onValueChange={(v) => cfg.update({ cadence: v as CampaignConfig['cadence'] })}
              >
                <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAMPAIGN_CADENCES.map((cadence) => (
                    <SelectItem key={cadence} value={cadence}>
                      {humanizeToken(cadence)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        </div>
      </fieldset>
    </Panel>
  );

  const header = (
    <PageHeader
      title="Campaigns"
      help="Related cases grouped by shared entities and overlapping MITRE techniques. Campaigns add context only and never decide a case."
      controls={
        <>
          <span className="text-sm tabular-nums text-muted-foreground" data-testid="campaigns-count">
            {initialLoading
              ? 'Loading'
              : `${fmtNumber(campaigns.length)} ${campaigns.length === 1 ? 'campaign' : 'campaigns'}`}
          </span>
          <RefreshButton
            display="icon"
            label="Refresh campaigns"
            refreshing={loading}
            onClick={() => void load()}
          />
        </>
      }
    />
  );

  return (
    <PageContainer variant="wide">
      {header}

      {canManage ? (
        // Page sections take the underline tabs (Round 14, SPEC §4.9.2), 13px with no icons.
        <Tabs
          value={workspace}
          onValueChange={(value) => setWorkspace(value as 'review' | 'policy')}
          className={cn('flex flex-col', PANEL_GAP)}
        >
          <TabsList variant="underline" aria-label="Campaign workspaces">
            <TabsTrigger value="review">Campaign review</TabsTrigger>
            <TabsTrigger value="policy">Policy and schedule</TabsTrigger>
          </TabsList>
          <TabsContent value="review" className="mt-0">
            {reviewWorkspace}
          </TabsContent>
          <TabsContent value="policy" className="mt-0">
            {policyWorkspace}
          </TabsContent>
        </Tabs>
      ) : (
        reviewWorkspace
      )}

      {canManage ? (
        <StickySaveBar
          visible={cfg.dirty}
          busy={cfg.saving}
          message="Unsaved campaign-policy changes."
          onSave={() => void saveConfig()}
          onDiscard={cfg.discard}
        />
      ) : null}

      <CampaignDetailSheet
        campaign={detail}
        onClose={() => setDetail(null)}
        onNavigate={navigate}
      />
    </PageContainer>
  );
}

/* ------------------------------------------------------------------------- */
/* Detail slide-over                                                          */
/* ------------------------------------------------------------------------- */

/**
 * The member cases' display numbers for the open campaign (`GET /api/campaigns/{id}`
 * `case_numbers`, Round 13 polish), so the sheet names members as the rest of the
 * console does ("CASE-000045"). `null` while the read is in flight; on a failed read,
 * or for a member without a number, the internal id stands in.
 */
function useMemberNumbers(campaignId: string | null): Record<string, string> | null {
  const [numbers, setNumbers] = React.useState<{ id: string; map: Record<string, string> } | null>(null);
  React.useEffect(() => {
    if (!campaignId) return undefined;
    let live = true;
    const settle = (map: Record<string, string>) => {
      if (live) setNumbers({ id: campaignId, map });
    };
    // Through a resolved promise, so even a synchronous throw falls back to the ids.
    Promise.resolve()
      .then(() => campaignsApi.get(campaignId))
      .then((res) => settle(res && typeof res.case_numbers === 'object' && res.case_numbers ? res.case_numbers : {}))
      .catch(() => settle({}));
    return () => {
      live = false;
    };
  }, [campaignId]);
  return numbers && numbers.id === campaignId ? numbers.map : null;
}

/**
 * The member cases in reading order (re-shoot PW3-7): the campaign stores its members by
 * internal id, so in that order the numbers read shuffled (CASE-000085, CASE-000087,
 * CASE-000086). Once the numbers are known, numbered members come first in number order
 * (digit runs compared as numbers, so CASE-9 precedes CASE-10), then members without a
 * number, by id. While the numbers load, the stored order holds each row's place.
 */
function orderMembers(caseIds: readonly string[], numbers: Record<string, string> | null): string[] {
  if (!numbers) return [...caseIds];
  const numberOf = (id: string) => numbers[id]?.trim() || null;
  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return [...caseIds].sort((a, b) => {
    const na = numberOf(a);
    const nb = numberOf(b);
    if (na && nb) return natural(na, nb) || natural(a, b);
    if (na || nb) return na ? -1 : 1;
    return natural(a, b);
  });
}

function CampaignDetailSheet({
  campaign,
  onClose,
  onNavigate,
}: {
  campaign: Campaign | null;
  onClose: () => void;
  onNavigate?: Navigate;
}) {
  const numbers = useMemberNumbers(campaign?.id ?? null);
  const members = React.useMemo(() => orderMembers(campaign?.case_ids ?? [], numbers), [campaign?.case_ids, numbers]);
  const memberIdBase = React.useId();
  return (
    <Sheet open={Boolean(campaign)} onOpenChange={(o) => (o ? undefined : onClose())}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        {campaign ? (
          <div className="flex h-full flex-col">
            <SheetHeader>
              {/* The icon keeps its size beside a title that wraps (PW4-3: at 390 px a long
                  id squeezed it to 0 px). */}
              {/* The readable label (D29), the same one the list shows; the campaign's own
                  number or id is said under it. Proportional numerals: the name is text,
                  and tabular figures set the hyphen of an id wide. */}
              <SheetTitle className="min-w-0 break-words proportional-nums">{campaignLabel(campaign)}</SheetTitle>
              <SheetDescription>
                {humanizeToken(CAMPAIGN_STATUS_LABELS[campaign.status] ?? campaign.status)}
                {campaignBasis(campaign) ? ` · ${campaignBasis(campaign)}` : ''}
              </SheetDescription>
            </SheetHeader>

            {/* The body is inset like the sheet header (p-6): it started 1 px from the edge (PW4-3). */}
            <div className="mt-4 flex flex-wrap items-center gap-2 px-6">
              <Badge variant={statusVariant(campaign.status)}>
                {humanizeToken(CAMPAIGN_STATUS_LABELS[campaign.status] ?? campaign.status)}
              </Badge>
              {campaign.severity_rollup ? (
                <SeverityBadge severity={campaign.severity_rollup} />
              ) : null}
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3 px-6 text-sm text-muted-foreground">
              <div className="col-span-2 min-w-0">
                <dt className="font-medium text-foreground">Campaign</dt>
                {/* The display number, else the internal id (the list shows the label). */}
                <dd className="min-w-0 break-all font-mono text-xs" data-testid="campaign-id">
                  {campaign.name || campaign.id}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">First seen</dt>
                <dd>{humanizeAge(campaign.first_seen)}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Last seen</dt>
                <dd>{humanizeAge(campaign.last_seen)}</dd>
              </div>
            </dl>

            <Separator className="my-4" />

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
              {/* Shared entities */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Shared entities</h3>
                {campaign.entities.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {campaign.entities.map((e, i) => (
                      <span
                        key={`${e.entity_type}:${e.value}:${i}`}
                        className="inline-flex items-center gap-1"
                      >
                        <span className="text-xs text-muted-foreground">
                          {entityKindLabel(e.entity_type)}:
                        </span>
                        <InlineCode>{e.value}</InlineCode>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">None.</p>
                )}
              </section>

              {/* MITRE */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">MITRE techniques</h3>
                {campaign.mitre.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {campaign.mitre.map((m) => (
                      <Badge key={m} variant="outline">
                        {m}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">None.</p>
                )}
              </section>

              {/* Member cases */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Member cases</h3>
                {members.length ? (
                  <ul className="divide-y divide-border/70">
                    {members.map((cid, index) => {
                      // The case number, as the rest of the console names a case; the
                      // internal id only in the tooltip and the accessible description.
                      const number = numbers?.[cid]?.trim() || null;
                      const label = number ?? cid;
                      const idNoteId = `${memberIdBase}-m${index}`;
                      return (
                        <li
                          key={cid}
                          className="flex items-center justify-between gap-2 px-1 py-1.5"
                          data-member-case={cid}
                        >
                          {numbers === null ? (
                            // The skeleton's look without its module: the page's preload list
                            // (in the entry chunk) gains no file for one placeholder bar.
                            <span aria-hidden="true" className="block h-4 w-28 rounded-md bg-muted/75" data-testid="member-case-pending" />
                          ) : number ? (
                            <span className="font-mono text-xs text-foreground" title={`Internal id: ${cid}`}>
                              {number}
                            </span>
                          ) : (
                            <InlineCode>{cid}</InlineCode>
                          )}
                          {onNavigate ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="shrink-0"
                              aria-label={`Open ${label}`}
                              aria-describedby={number ? idNoteId : undefined}
                              onClick={() => onNavigate('cases', { caseId: cid })}
                            >
                              Open
                              <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden />
                            </Button>
                          ) : null}
                          {number ? (
                            <span id={idNoteId} hidden>
                              {`Internal id ${cid}`}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">None.</p>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------------- */
/* CampaignChip — a small "part of campaign X" chip for CaseDetail             */
/* ------------------------------------------------------------------------- */

export interface CampaignChipProps {
  /** The campaign this case belongs to (from GET /api/cases/{id}/campaign). */
  campaign: Pick<Campaign, 'id' | 'name' | 'case_count'>;
  /** Navigate to the Campaigns surface when clicked. */
  onOpen?: () => void;
  className?: string;
}

/**
 * A compact "part of campaign X" chip CaseDetail mounts when a case belongs to a
 * campaign. Plain text (#9); clicking calls `onOpen` (the host routes to Campaigns).
 */
export function CampaignChip({ campaign, onOpen, className }: CampaignChipProps) {
  const label = campaign.name || campaign.id;
  const body = (
    <>
      <Network className="h-3 w-3" aria-hidden />
      <span className="truncate">Part of campaign: {label}</span>
      {campaign.case_count ? (
        <span className="text-muted-foreground">({campaign.case_count})</span>
      ) : null}
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={className}
        aria-label={`Part of campaign ${label}`}
      >
        <Badge variant="info" className="max-w-full cursor-pointer gap-1">
          {body}
        </Badge>
      </button>
    );
  }
  return (
    <Badge variant="info" className={className ? `max-w-full gap-1 ${className}` : 'max-w-full gap-1'}>
      {body}
    </Badge>
  );
}
