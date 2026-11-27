/**
 * Memory: operator-managed durable facts the agents always know (NEW UI).
 *
 * Memory is a curated set of durable facts (internal IP ranges, known scanners,
 * naming conventions, standing exceptions) injected into every investigation and
 * chat turn as a DISTINCT TRUSTED operator block. A human can add / inline-edit /
 * retire facts here, or teach them conversationally in Chat ("remember: …" /
 * "forget …"), which the chat engine reflects back as a `memory_action`.
 *
 * Security: agent-authored facts (`source: 'agent'`) are source-influenceable, so
 * ALL memory text is rendered as PLAIN text (never markup). Memory NEVER overrides
 * the deterministic close/escalate decision — it only informs the LLM.
 *
 * Mirrors the legacy MemoryPage data wiring: api.getMemory / addMemory /
 * updateMemory / deleteMemory, optimistic local upsert, toasts, filters (search /
 * source / active / category), sort, group-by-category, inline edit + delete-confirm.
 *
 * Round 14 (IN2, IN3, IN7, F10): no "Memory controls" band and no permanent "What is
 * memory?" callout; the explanation is a help tip on the saved-memories panel, whose
 * actions hold the icon Refresh (the Intelligence host owns the page header). Counts are a
 * compact `KpiStrip`; the add form and the saved memories are panels, with Category and
 * Tags as two aligned `Field`s; filters are one `FilterBar`; rows are hairline-divided
 * (no card per fact); the delete icon is neutral at rest.
 */
import * as React from 'react';
import {
  Bot,
  CircleAlert,
  CircleCheck,
  Folder,
  Pencil,
  Plus,
  Save,
  Search,
  Tag,
  Trash2,
  User,
  X,
  Brain,
} from 'lucide-react';
import { toast } from 'sonner';

import { api, type MemoryPatch } from '@/lib/api';
import type { MemoryEntry } from '@/lib/types';
import { fmtNumber, formatTimestamp, humanizeAge, humanizeToken } from '@/lib/format';
import { errorMessage } from '@/lib/errorMessage';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/dialog';

import { PageHeader } from '@/soc/components/PageHeader';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { useCan } from '@/soc/components/Can';
import { KpiStrip } from '@/soc/components/KpiStrip';
import { KpiTile } from '@/soc/components/KpiTile';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { Field } from '@/soc/components/Field';
import { HelpTip } from '@/soc/components/HelpTip';
import { FilterBar, type FilterChip } from '@/soc/components/FilterBar';
import { LoadingState, Panel } from '@/design-system';
import { TagInput, usePendingTagDraft } from '@/soc/components/TagInput';
import { headingOf, useReturnFocus } from '@/soc/hooks/useReturnFocus';

/** What memory is: the help tip on the saved-memories panel (formerly a permanent callout). */
const MEMORY_HELP =
  'A curated set of durable facts the agents can use: internal IP ranges, known scanners, ' +
  'naming conventions and standing exceptions. Only active, operator-approved facts are ' +
  'given to the agents as trusted context; pending agent suggestions stay fenced as ' +
  'untrusted text. Memory can inform the AI but never overrides the close or escalate ' +
  'decision, which code makes. Turn Active off to retire a fact without deleting it. ' +
  'Authorized operators can manage memory here, or say "remember: ..." and "forget ..." in Chat.';

/** The standalone page help (the Intelligence host has its own). */
const PAGE_HELP = 'Operator-approved durable facts used across investigations and chat.';

/** Uncategorised facts collect under this stable bucket label. */
const UNCATEGORISED = 'Uncategorised';

/** Sentinel for the "any" option in single-select filters (Radix forbids ""). */
const ANY = '__any__';

type SortKey = 'updated' | 'created' | 'active' | 'category';
type SourceFilter = 'all' | 'human' | 'agent';
type ActiveFilter = 'all' | 'active' | 'inactive';

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Newest first' },
  { value: 'active', label: 'Active first' },
  { value: 'category', label: 'By category' },
];

const SOURCE_OPTIONS: Array<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: 'All authors' },
  { value: 'human', label: 'Operator' },
  { value: 'agent', label: 'Agent' },
];

const ACTIVE_OPTIONS: Array<{ value: ActiveFilter; label: string }> = [
  { value: 'all', label: 'All states' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

function isAgentEntry(e: MemoryEntry): boolean {
  return (e.source || '').toLowerCase() === 'agent';
}

function isApprovedEntry(e: MemoryEntry): boolean {
  return (e.review_status || (isAgentEntry(e) ? 'pending' : 'approved')) === 'approved';
}

function isEffectiveActive(e: MemoryEntry): boolean {
  return Boolean(e.active && isApprovedEntry(e));
}

/* --------------------------------------------------------------- source badge -- */

/** A small author pill — human operator vs agent-authored suggestion. */
function SourceBadge({ source, author }: { source?: string; author?: string }) {
  const agent = (source || '').toLowerCase() === 'agent';
  const Icon = agent ? Bot : User;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant={agent ? 'info' : 'secondary'} className="gap-1">
              <Icon className="h-3 w-3" aria-hidden />
              {agent ? 'Agent' : 'Operator'}
              {author ? ` · ${author}` : ''}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {agent
            ? 'Written by an agent. It remains untrusted until an authorized operator approves it.'
            : 'Authored by a human operator and approved at creation.'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/* ----------------------------------------------------------- add-memory card -- */

function AddMemoryCard({
  categories,
  onAdded,
}: {
  categories: string[];
  onAdded: (e: MemoryEntry) => void;
}) {
  const [text, setText] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [tags, setTags] = React.useState<string[]>([]);
  const tagDraft = usePendingTagDraft();
  const [submitting, setSubmitting] = React.useState(false);

  const submit = React.useCallback(async () => {
    const body = text.trim();
    if (!body) return;
    // Text typed into Tags but not added is never saved silently: stop and ask.
    if (!tagDraft.settled()) return;
    setSubmitting(true);
    try {
      const entry = await api.addMemory({
        text: body,
        category: category.trim() || undefined,
        tags: tags.length ? tags : undefined,
      });
      onAdded(entry);
      setText('');
      setCategory('');
      setTags([]);
      tagDraft.reset();
      toast.success('Memory saved.');
    } catch (e) {
      toast.error(errorMessage(e, 'Could not save memory.'));
    } finally {
      setSubmitting(false);
    }
  }, [text, category, tags, tagDraft, onAdded]);

  return (
    <Panel
      title="Add a memory"
      caption="A durable fact the agents should always know."
      data-testid="memory-add"
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="mem-text">Fact</Label>
          <Textarea
            id="mem-text"
            rows={2}
            placeholder="For example: 10.20.0.0/16 is our internal corporate network. Never treat it as external."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        {/* F10: both are Fields, so their labels, controls and help lines align. */}
        <div className="grid items-start gap-4 sm:grid-cols-2" data-testid="memory-add-fields">
          <Field label="Category (optional)" description="For example network, scanners or policy.">
            {({ id, describedBy }) => (
              <>
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  list="mem-category-suggestions"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
                <datalist id="mem-category-suggestions">
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {humanizeToken(c)}
                    </option>
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <TagInput
            label="Tags (optional)"
            description="Type a tag and press Enter."
            value={tags}
            onChange={setTags}
            {...tagDraft.bind}
          />
        </div>

        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!text.trim() || submitting}
          >
            <Plus className="h-4 w-4" aria-hidden />
            {submitting ? 'Saving…' : 'Save memory'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/* --------------------------------------------------------------- memory row --- */

function MemoryRow({
  entry,
  busy,
  onSave,
  onToggleActive,
  onApprove,
  onDelete,
  canManage,
}: {
  entry: MemoryEntry;
  busy: boolean;
  onSave: (id: string, patch: MemoryPatch) => Promise<void>;
  onToggleActive: (entry: MemoryEntry) => void;
  onApprove: (entry: MemoryEntry) => void;
  /** `opener` is the row's Delete button, where focus returns if the delete is cancelled. */
  onDelete: (entry: MemoryEntry, opener: HTMLElement) => void;
  canManage: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(entry.text);
  const [category, setCategory] = React.useState(entry.category || '');
  const [tags, setTags] = React.useState<string[]>(entry.tags || []);
  const tagDraft = usePendingTagDraft();
  const [saving, setSaving] = React.useState(false);
  const approved = isApprovedEntry(entry);

  // Re-seed local edit buffers when the underlying entry changes (e.g. refresh),
  // unless the user is actively editing.
  React.useEffect(() => {
    if (!editing) {
      setText(entry.text);
      setCategory(entry.category || '');
      setTags(entry.tags || []);
    }
  }, [entry, editing]);

  const cancel = React.useCallback(() => {
    setEditing(false);
    setText(entry.text);
    setCategory(entry.category || '');
    setTags(entry.tags || []);
    tagDraft.reset();
  }, [entry, tagDraft]);

  const save = React.useCallback(async () => {
    if (!text.trim()) return;
    // Text typed into Tags but not added is never saved silently: stop and ask.
    if (!tagDraft.settled()) return;
    setSaving(true);
    try {
      await onSave(entry.id, {
        text: text.trim(),
        category: category.trim(),
        tags,
      });
      tagDraft.reset();
      setEditing(false);
    } catch {
      /* toast surfaced by caller; keep the editor open */
    } finally {
      setSaving(false);
    }
  }, [entry.id, text, category, tags, tagDraft, onSave]);

  if (editing) {
    return (
      <li className="list-none py-3" data-memory-row={entry.id}>
        <div className="space-y-4 rounded-md p-3 ring-1 ring-primary/30">
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Edit memory text"
          />
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label="Category">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              )}
            </Field>
            <TagInput
              label="Tags"
              placeholder="Type a tag and press Enter"
              value={tags}
              onChange={setTags}
              {...tagDraft.bind}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!text.trim() || saving}>
              <Save className="h-4 w-4" aria-hidden />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="list-none py-3" data-memory-row={entry.id}>
        <div className="flex items-start gap-4">
          {/* active accent rail */}
          <span
            className={cn(
              'mt-0.5 w-0.5 shrink-0 self-stretch rounded-full',
              isEffectiveActive(entry) ? 'bg-success/70' : 'bg-border',
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            {/* UNTRUSTED fact text — plain, never markup */}
            <p
              className={cn(
                'whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground',
                !entry.active && 'opacity-55',
              )}
            >
              {entry.text}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <SourceBadge source={entry.source} author={entry.author} />
              {!approved ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="warning" className="gap-1" tabIndex={0}>
                        <CircleAlert className="h-3 w-3" aria-hidden />
                        Pending review
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      This suggestion is fenced as untrusted and is not injected as operator memory.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
              {entry.category ? (
                <Badge variant="outline" className="gap-1">
                  <Folder className="h-3 w-3" aria-hidden />
                  {humanizeToken(entry.category)}
                </Badge>
              ) : null}
              {(entry.tags || []).map((t) => (
                <Badge key={t} variant="outline" className="gap-1">
                  <Tag className="h-3 w-3" aria-hidden />
                  {t}
                </Badge>
              ))}
              {!entry.active ? (
                <Badge variant="secondary" className="text-muted-foreground">
                  Inactive
                </Badge>
              ) : null}
              <span
                className="text-xs text-muted-foreground"
                title={formatTimestamp(entry.updated_at || entry.created_at)}
              >
                Updated {humanizeAge(entry.updated_at || entry.created_at)}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center">
                    <Switch
                      checked={entry.active}
                      onCheckedChange={() => onToggleActive(entry)}
                      disabled={busy || !approved || !canManage}
                      aria-label={
                        !approved
                          ? 'Memory pending review'
                          : entry.active
                            ? 'Deactivate memory'
                            : 'Activate memory'
                      }
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {!approved
                    ? 'Pending review: kept as untrusted text, not given to the agents as operator context'
                    : entry.active
                      ? 'Active: given to the agents as approved operator context'
                      : 'Inactive: kept, not given to the agents'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {!approved && canManage ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onApprove(entry)}
              >
                <CircleCheck className="h-4 w-4" aria-hidden />
                Approve
              </Button>
            ) : null}
            {canManage ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Edit memory"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete memory"
                  disabled={busy}
                  data-memory-delete=""
                  // Neutral at rest; red only on hover, focus and in the confirm dialog.
                  className="text-muted-foreground hover:text-critical-text focus-visible:text-critical-text"
                  onClick={(event) => onDelete(entry, event.currentTarget)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </>
            ) : null}
          </div>
        </div>
    </li>
  );
}

/* -------------------------------------------------------------------- page --- */

export interface MemoryPageProps {
  onNavigate?: (page: any, opts?: any) => void;
  /**
   * When hosted as a tab inside the Intelligence scaffold (Round-2 W4 consolidation),
   * suppress the page's own PageHeader. The host owns the one page title while this
   * leaf contributes a compact, labelled control row.
   */
  embedded?: boolean;
}

export default function Memory({ embedded = false }: MemoryPageProps = {}) {
  const canManage = useCan('memory', 'manage');
  const [entries, setEntries] = React.useState<MemoryEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<MemoryEntry | null>(null);
  // The delete dialog opens from a row's Delete button (no Radix trigger), so it hands
  // focus back to that button when cancelled (SPEC §3.3). A confirmed delete takes the
  // button away with its row: focus then goes to the next row's Delete, else the list's
  // heading, never to the page body.
  const deleteOpener = useReturnFocus();
  const listRef = React.useRef<HTMLElement>(null);
  const [deleting, setDeleting] = React.useState(false);

  // view controls
  const [search, setSearch] = React.useState('');
  const [sourceFilter, setSourceFilter] = React.useState<SourceFilter>('all');
  const [activeFilter, setActiveFilter] = React.useState<ActiveFilter>('all');
  const [categoryFilter, setCategoryFilter] = React.useState<string>(ANY);
  const [sort, setSort] = React.useState<SortKey>('updated');
  const [grouped, setGrouped] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getMemory();
      setEntries(res.entries ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const upsertLocal = React.useCallback((next: MemoryEntry) => {
    // A successful mutation means the backend is reachable — clear any stale load
    // error so the freshly-added/updated row is not hidden behind the error panel.
    setError(null);
    setEntries((prev) => {
      const i = prev.findIndex((e) => e.id === next.id);
      if (i === -1) return [next, ...prev];
      const copy = prev.slice();
      copy[i] = next;
      return copy;
    });
  }, []);

  const onAdded = React.useCallback(
    (entry: MemoryEntry) => upsertLocal(entry),
    [upsertLocal],
  );

  const onSave = React.useCallback(
    async (id: string, patch: MemoryPatch) => {
      setBusyId(id);
      try {
        const next = await api.updateMemory(id, patch);
        upsertLocal(next);
        toast.success('Memory updated.');
      } catch (e) {
        toast.error(errorMessage(e, 'Could not update memory.'));
        throw e;
      } finally {
        setBusyId(null);
      }
    },
    [upsertLocal],
  );

  const onToggleActive = React.useCallback(
    async (entry: MemoryEntry) => {
      setBusyId(entry.id);
      try {
        const next = await api.updateMemory(entry.id, { active: !entry.active });
        upsertLocal(next);
      } catch (e) {
        toast.error(errorMessage(e, 'Could not update memory.'));
      } finally {
        setBusyId(null);
      }
    },
    [upsertLocal],
  );

  const onApprove = React.useCallback(
    async (entry: MemoryEntry) => {
      setBusyId(entry.id);
      try {
        const next = await api.updateMemory(entry.id, { review_status: 'approved' });
        upsertLocal(next);
        toast.success('Memory approved as trusted operator context.');
      } catch (e) {
        toast.error(errorMessage(e, 'Could not approve memory.'));
      } finally {
        setBusyId(null);
      }
    },
    [upsertLocal],
  );

  const runDelete = React.useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteMemory(pendingDelete.id);
      setEntries((prev) => prev.filter((e) => e.id !== pendingDelete.id));
      toast.success('Memory deleted.');
      setPendingDelete(null);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not delete memory.'));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete]);

  // derived summary + facets
  const stats = React.useMemo(() => {
    let active = 0;
    let operator = 0;
    let agent = 0;
    let pending = 0;
    for (const e of entries) {
      if (isEffectiveActive(e)) active += 1;
      if (isAgentEntry(e)) agent += 1;
      else operator += 1;
      if (!isApprovedEntry(e)) pending += 1;
    }
    return { total: entries.length, active, operator, agent, pending };
  }, [entries]);

  const categoryFacet = React.useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) if (e.category) set.add(e.category);
    return Array.from(set).sort();
  }, [entries]);

  // Drop a selected category that no longer exists so the list can't silently empty.
  React.useEffect(() => {
    if (categoryFilter !== ANY && !categoryFacet.includes(categoryFilter)) {
      setCategoryFilter(ANY);
    }
  }, [categoryFacet, categoryFilter]);

  const filteredSorted = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = entries.filter((e) => {
      const agent = isAgentEntry(e);
      if (sourceFilter === 'agent' && !agent) return false;
      if (sourceFilter === 'human' && agent) return false;
      if (activeFilter === 'active' && !isEffectiveActive(e)) return false;
      if (activeFilter === 'inactive' && isEffectiveActive(e)) return false;
      if (categoryFilter !== ANY && e.category !== categoryFilter) return false;
      if (!q) return true;
      const hay = `${e.text} ${e.category || ''} ${(e.tags || []).join(' ')} ${
        e.author || ''
      }`.toLowerCase();
      return hay.includes(q);
    });
    const byTime = (e: MemoryEntry, useUpdated: boolean) =>
      (useUpdated ? e.updated_at || e.created_at : e.created_at) || '';
    return [...rows].sort((a, b) => {
      switch (sort) {
        case 'created':
          return byTime(b, false).localeCompare(byTime(a, false));
        case 'active':
          if (isEffectiveActive(a) !== isEffectiveActive(b)) return isEffectiveActive(a) ? -1 : 1;
          return byTime(b, true).localeCompare(byTime(a, true));
        case 'category':
          return (
            (a.category || UNCATEGORISED).localeCompare(b.category || UNCATEGORISED) ||
            byTime(b, true).localeCompare(byTime(a, true))
          );
        case 'updated':
        default:
          return byTime(b, true).localeCompare(byTime(a, true));
      }
    });
  }, [entries, search, sourceFilter, activeFilter, categoryFilter, sort]);

  const groups = React.useMemo(() => {
    if (!grouped) return null;
    const map = new Map<string, MemoryEntry[]>();
    for (const e of filteredSorted) {
      const key = e.category ? humanizeToken(e.category) : UNCATEGORISED;
      const arr = map.get(key);
      if (arr) arr.push(e);
      else map.set(key, [e]);
    }
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === UNCATEGORISED) return 1;
      if (b[0] === UNCATEGORISED) return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [filteredSorted, grouped]);

  const anyFilter =
    search.trim().length > 0 ||
    sourceFilter !== 'all' ||
    activeFilter !== 'all' ||
    categoryFilter !== ANY;

  const clearFilters = React.useCallback(() => {
    setSearch('');
    setSourceFilter('all');
    setActiveFilter('all');
    setCategoryFilter(ANY);
  }, []);

  const renderRow = (entry: MemoryEntry) => (
    <MemoryRow
      key={entry.id}
      entry={entry}
      busy={busyId === entry.id}
      onSave={onSave}
      onToggleActive={(e) => void onToggleActive(e)}
      onApprove={(e) => void onApprove(e)}
      onDelete={(e, opener) => {
        deleteOpener.remember(opener, {
          peers: () => listRef.current?.querySelectorAll('[data-memory-delete]') ?? [],
          empty: () => headingOf(listRef.current),
        });
        setPendingDelete(e);
      }}
      canManage={canManage}
    />
  );

  const refreshAction = (
    <RefreshButton
      onClick={() => void load()}
      refreshing={loading}
      label="Refresh memory"
      display="icon"
    />
  );

  // Active filters as removable chips (FilterBar grammar).
  const chips: FilterChip[] = [];
  if (categoryFilter !== ANY) {
    chips.push({
      id: 'category',
      label: `Category: ${humanizeToken(categoryFilter)}`,
      onRemove: () => setCategoryFilter(ANY),
    });
  }
  if (sourceFilter !== 'all') {
    chips.push({
      id: 'author',
      label: `Author: ${SOURCE_OPTIONS.find((o) => o.value === sourceFilter)?.label ?? sourceFilter}`,
      onRemove: () => setSourceFilter('all'),
    });
  }
  if (activeFilter !== 'all') {
    chips.push({
      id: 'state',
      label: `State: ${ACTIVE_OPTIONS.find((o) => o.value === activeFilter)?.label ?? activeFilter}`,
      onRemove: () => setActiveFilter('all'),
    });
  }

  // A hard load failure with no cached data: show one clean LoadError panel instead
  // of zeroed KPI tiles + an interactive add-card whose new rows would be invisible.
  const showLoadFail = !!error && entries.length === 0;
  const initialLoading = loading && entries.length === 0;
  const filtered = filteredSorted.length !== stats.total;

  return (
    <div className="flex flex-col gap-4 xl:gap-5 3xl:gap-6">
      {embedded ? null : (
        <PageHeader title="Memory" help={PAGE_HELP} controls={refreshAction} />
      )}

      {/* summary strip */}
      {showLoadFail ? null : initialLoading ? (
        <LoadingState
          layout="panel"
          shape="panel"
          label="Loading memory"
          description="Preparing durable facts and operator context."
        />
      ) : (
        <KpiStrip label="Memory summary" density="compact" data-testid="memory-summary">
          <KpiTile label="Total facts" value={fmtNumber(stats.total)} />
          <KpiTile
            label="Active"
            value={fmtNumber(stats.active)}
            context={stats.total > 0 ? `${fmtNumber(stats.total - stats.active)} not injected` : undefined}
          />
          <KpiTile label="Operator-authored" value={fmtNumber(stats.operator)} />
          <KpiTile
            label="Agent-authored"
            value={fmtNumber(stats.agent)}
            context={stats.pending > 0 ? `${fmtNumber(stats.pending)} pending review` : 'All reviewed'}
          />
        </KpiStrip>
      )}

      {showLoadFail || initialLoading || !canManage ? null : (
        <AddMemoryCard categories={categoryFacet} onAdded={onAdded} />
      )}

      {/* list / states */}
      {error ? (
        <LoadError
          error={error}
          title="Could not load memory"
          fallback="An unexpected error occurred."
          onRetry={() => void load()}
        />
      ) : initialLoading ? null : (
        <Panel
          ref={listRef}
          title="Saved memories"
          // One formatted count; the active and pending figures are on the strip above,
          // so the panel does not repeat them.
          count={
            filtered
              ? `${fmtNumber(filteredSorted.length)} of ${fmtNumber(stats.total)} shown`
              : fmtNumber(stats.total)
          }
          padding="none"
          data-testid="memory-saved"
          actions={
            <>
              <HelpTip label="About memory" text={MEMORY_HELP} />
              {refreshAction}
            </>
          }
        >
          {entries.length > 0 ? (
            <div className="px-4 pb-3 xl:px-5 3xl:px-6">
              <FilterBar
                aria-label="Memory filters"
                search={{
                  value: search,
                  onChange: setSearch,
                  label: 'Search memories',
                  placeholder: 'Search facts, category, tags',
                }}
                filters={[
                  ...(categoryFacet.length > 0
                    ? [
                        {
                          id: 'category',
                          label: 'Category',
                          active: categoryFilter !== ANY,
                          control: ({ placement }: { placement: 'bar' | 'menu' | 'sheet' }) => (
                            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                              <SelectTrigger
                                className={placement === 'bar' ? 'h-8 w-44' : 'h-9 w-full'}
                                aria-label="Filter by category"
                              >
                                <SelectValue placeholder="Category" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={ANY}>All categories</SelectItem>
                                {categoryFacet.map((c) => (
                                  <SelectItem key={c} value={c}>
                                    {humanizeToken(c)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ),
                        },
                      ]
                    : []),
                  {
                    id: 'author',
                    label: 'Author',
                    active: sourceFilter !== 'all',
                    control: ({ placement }: { placement: 'bar' | 'menu' | 'sheet' }) => (
                      <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SourceFilter)}>
                        <SelectTrigger
                          className={placement === 'bar' ? 'h-8 w-36' : 'h-9 w-full'}
                          aria-label="Filter by author"
                        >
                          <SelectValue placeholder="Author" />
                        </SelectTrigger>
                        <SelectContent>
                          {SOURCE_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ),
                  },
                  {
                    id: 'state',
                    label: 'State',
                    active: activeFilter !== 'all',
                    control: ({ placement }: { placement: 'bar' | 'menu' | 'sheet' }) => (
                      <Select value={activeFilter} onValueChange={(v) => setActiveFilter(v as ActiveFilter)}>
                        <SelectTrigger
                          className={placement === 'bar' ? 'h-8 w-32' : 'h-9 w-full'}
                          aria-label="Filter by active state"
                        >
                          <SelectValue placeholder="State" />
                        </SelectTrigger>
                        <SelectContent>
                          {ACTIVE_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ),
                  },
                ]}
                chips={chips}
                onClearAll={anyFilter ? clearFilters : undefined}
                end={
                  <div className="flex flex-wrap items-center gap-3">
                    {/* A native <label> does not forward clicks to a Radix Switch (a
                        <button role="switch">); the Switch is self-labeled via aria-label. */}
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Switch checked={grouped} onCheckedChange={setGrouped} aria-label="Group by category" />
                      Group by category
                    </div>
                    <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                      <SelectTrigger className="h-8 w-44" aria-label="Sort memories">
                        <SelectValue placeholder="Sort" />
                      </SelectTrigger>
                      <SelectContent>
                        {SORT_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                }
              />
            </div>
          ) : null}

          <div className="border-t border-border/70 px-4 xl:px-5 3xl:px-6">
            {entries.length === 0 ? (
              <EmptyState
                icon={Brain}
                title="No memories yet"
                description={
                  canManage
                    ? 'Add a durable fact above, or teach the agent one in Chat with "remember: ...".'
                    : 'No operator-approved memory is available yet.'
                }
              />
            ) : filteredSorted.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No memories match"
                description="No facts match the current filters. Clear them to see all memories."
                action={
                  <Button size="sm" variant="outline" onClick={clearFilters}>
                    <X className="h-4 w-4" aria-hidden />
                    Clear filters
                  </Button>
                }
              />
            ) : groups ? (
              <div className="divide-y divide-border/70">
                {groups.map(([label, rows]) => (
                  <section key={label} aria-label={label} className="py-3">
                    <div className="flex items-baseline gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{label}</h3>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {fmtNumber(rows.length)} {rows.length === 1 ? 'fact' : 'facts'}
                      </span>
                    </div>
                    <ul className="divide-y divide-border/70">{rows.map(renderRow)}</ul>
                  </section>
                ))}
              </div>
            ) : (
              <ul className="divide-y divide-border/70">{filteredSorted.map(renderRow)}</ul>
            )}
          </div>
        </Panel>
      )}

      {/* delete confirm */}
      <Dialog open={!!pendingDelete} onOpenChange={(o) => (!o ? setPendingDelete(null) : undefined)}>
        <DialogContent onCloseAutoFocus={deleteOpener.onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>Delete this memory?</DialogTitle>
            <DialogDescription>
              The agents will no longer know this fact. To retire it without deleting, toggle Active
              off instead.
            </DialogDescription>
          </DialogHeader>
          {pendingDelete ? (
            <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground">
              “{pendingDelete.text}”
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void runDelete()} disabled={deleting}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
