/**
 * SourceEditor (new UI) — pick a connector, fill its DYNAMIC manifest-driven
 * form, configure advanced triage behaviour (N index patterns + roles, entity
 * strategy, message field), test the current draft, and save. The reusable
 * unit behind the Sources manager's add/edit flow.
 *
 * Field rendering is driven entirely by the backend manifest's `auth_fields` +
 * `config_fields` so any connector can be configured with zero per-connector UI.
 * Secrets (password fields) are write-only — never echoed; shown as `configured`.
 *
 * Security: all values typed here are operator input; nothing rendered from the
 * backend is interpolated as markup. The test-result message is shown as plain
 * text.
 */
import * as React from 'react';
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  Beaker,
  Save,
  CheckCircle2,
  AlertTriangle,
  FileUp,
  BookOpen,
  Sparkles,
  SlidersHorizontal,
} from 'lucide-react';
import type {
  AuthField,
  ConnectorManifest,
  EntityStrategy,
  FieldMappingsExtra,
  IndexPattern,
  SourceConfigExtras,
  SourceInstance,
} from '@/lib/types';
import { api, ApiError } from '@/lib/api';
import { useDemoGuard } from '@/soc/demo';
import { saveSource, slugify } from '@/lib/connectors';
import { cn } from '@/lib/cn';
import { LoadingGlyph, LoadingState } from '@/design-system/loading';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Slider } from '@/ui/slider';
import { Badge } from '@/ui/badge';
import { Separator } from '@/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from '@/ui/sheet';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/ui/tooltip';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/ui/accordion';

import { ConnectorPicker } from '@/soc/components/ConnectorPicker';
import { HelpTip, ConnectorFieldHelp } from '@/soc/components/HelpTip';

/** Best-effort human message from an unknown thrown value. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || 'Something went wrong.';
  return 'Something went wrong.';
}

// --------------------------------------------------------------------------- //
// The form value shape the lib/connectors saveSource() consumes.
// --------------------------------------------------------------------------- //
interface ConnectorFormValue {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

type FeedRole = 'events' | 'alerts' | 'ignore';

/** The three feed roles + their meaning, colour, and operator help (Wave 6). */
const ROLE_DEFS: Array<{
  value: FeedRole;
  label: string;
  help: string;
  /** Tailwind classes for the segmented control's active state. */
  active: string;
}> = [
  {
    value: 'events',
    label: 'Events',
    help: 'Raw logs. Correlated into clusters, then auto-investigated only when the firing rule is on the auto-forward allowlist (or per-feed auto-investigate is on).',
    active: 'bg-info/15 text-info-text border-info/40',
  },
  {
    value: 'alerts',
    label: 'Alerts',
    help: 'Pre-triaged detections. Every matching cluster is auto-investigated, bypassing the allowlist.',
    active: 'bg-critical/15 text-critical-text border-critical/40',
  },
  {
    value: 'ignore',
    label: 'Ignore',
    help: 'The feed is dropped — its events are skipped at ingest entirely and never form cases. Pinned last for precedence (a more specific ignore feed overrides a broader events/alerts feed).',
    active: 'bg-muted text-muted-foreground border-border line-through decoration-1',
  },
];

const ROLE_HELP: Record<FeedRole, string> = {
  events: ROLE_DEFS[0].help,
  alerts: ROLE_DEFS[1].help,
  ignore: ROLE_DEFS[2].help,
};

/** OCSF severity_id (1-6) → human label, for the per-feed severity-floor slider. */
const SEVERITY_LABELS: Record<number, string> = {
  1: 'Informational',
  2: 'Low',
  3: 'Medium',
  4: 'High',
  5: 'Critical',
  6: 'Fatal',
};

/** Entity-strategy choices (matches the backend's canonical EntityStrategy). */
const ENTITY_OPTIONS: Array<{ value: EntityStrategy; text: string }> = [
  { value: 'auto', text: 'Auto (IP → host → user → rule)' },
  { value: 'ip', text: 'Source IP' },
  { value: 'host', text: 'Host' },
  { value: 'user', text: 'User' },
  { value: 'rule', text: 'Rule' },
];

const CERT_ACCEPT = '.pem,.crt,.cer,.txt';

/* ----------------------------------------------------------- field helpers - */

function allFields(manifest: ConnectorManifest): AuthField[] {
  return [...(manifest.auth_fields || []), ...(manifest.config_fields || [])];
}

/** Group fields by their `group`, preserving first-seen group order. */
function groupFields(fields: AuthField[]): Array<[string, AuthField[]]> {
  const order: string[] = [];
  const map = new Map<string, AuthField[]>();
  for (const f of fields) {
    const g = f.group || 'Settings';
    if (!map.has(g)) {
      map.set(g, []);
      order.push(g);
    }
    map.get(g)!.push(f);
  }
  return order.map((g) => [g, map.get(g)!]);
}

/** Whether a required field is currently unsatisfied (for validation). */
function missingRequired(
  manifest: ConnectorManifest,
  value: ConnectorFormValue,
  configuredSecrets: string[] = [],
): AuthField[] {
  return allFields(manifest).filter((f) => {
    if (!f.required) return false;
    if (f.secret) {
      return !value.secrets[f.key] && !configuredSecrets.includes(f.key);
    }
    const v = value.config[f.key];
    return v === undefined || v === null || v === '';
  });
}

/** True when a textarea field carries a certificate / PEM blob. */
function isCertField(f: AuthField): boolean {
  const fmt = (f as { format?: string }).format;
  if (fmt === 'pem' || fmt === 'certificate' || fmt === 'cert') return true;
  const k = (f.key || '').toLowerCase();
  return k.includes('ca_cert') || k.includes('cert') || k.endsWith('_pem') || k.includes('pem');
}

function splitPatterns(s: unknown): string[] {
  if (typeof s !== 'string') return [];
  return s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * The editor's in-memory feed row — the rich Wave-6 shape with every field resolved
 * to a concrete (non-undefined) value so the form is fully controlled. Maps onto the
 * `config['index_patterns']` wire entries on save.
 */
interface FeedRow {
  /**
   * Stable React key — assigned once at creation, NEVER derived from the mutable
   * pattern and NEVER persisted. Keying the FeedCard on this (not on the
   * pattern-derived `id`) keeps the pattern input from remounting/losing focus as the
   * operator types.
   */
  uid: string;
  /** Stable feed id (derived from the pattern when absent). */
  id: string;
  label: string;
  pattern: string;
  role: FeedRole;
  enabled: boolean;
  query: string;
  /** OCSF severity_id floor 1-6; null = no floor ("none"). */
  severityFloor: number | null;
  correlate: boolean;
  /** null = derive the role default; otherwise an explicit operator override. */
  autoInvestigate: boolean | null;
  /** Per-feed poll interval seconds; null = inherit the source. */
  pollInterval: number | null;
  /** Per-feed field-mapping override (only non-empty entries are persisted). */
  fieldMapping: FieldMappingsExtra;
  messageField: string;
}

/** Lower-case slug of a pattern, mirroring the backend `slug(pattern)` fallback. */
function slugPattern(pattern: string): string {
  return (
    pattern
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'feed'
  );
}

function coerceRole(v: unknown): FeedRole {
  return v === 'alerts' || v === 'ignore' ? v : 'events';
}

/** The derived (role-aware) auto-investigate default when `auto_investigate` is null. */
function derivedAutoInvestigate(row: Pick<FeedRow, 'role' | 'correlate'>): boolean {
  if (row.role === 'ignore') return false;
  if (row.role === 'alerts') return true;
  // events: legacy `auto_correlate` drove the auto-forward decision.
  return row.correlate;
}

/** Monotonic per-session counter for stable, non-derived FeedRow React keys. */
let feedUidSeq = 0;
function nextFeedUid(): string {
  feedUidSeq += 1;
  return `feed-uid-${feedUidSeq}`;
}

function emptyFeed(): FeedRow {
  return {
    uid: nextFeedUid(),
    id: '',
    label: '',
    pattern: '',
    role: 'events',
    enabled: true,
    query: '',
    severityFloor: null,
    correlate: true,
    autoInvestigate: null,
    pollInterval: null,
    fieldMapping: {},
    messageField: '',
  };
}

/**
 * Derive editable feed rows from a source config. Accepts BOTH legacy entries
 * (`{pattern, role, auto_correlate}` or a bare string) AND the rich Wave-6 feed
 * shape, yielding identical effective behaviour for old configs:
 *   - legacy → `id=slug(pattern)`, `correlate=true`,
 *     `auto_investigate=(role=='alerts' || legacy auto_correlate)`.
 * Malformed entries are skipped (as the backend does).
 */
function deriveIndexPatterns(cfg: Record<string, unknown>): FeedRow[] {
  const existing = cfg.index_patterns;
  const rows: FeedRow[] = [];
  if (Array.isArray(existing)) {
    for (const item of existing) {
      // Bare-string legacy entry.
      if (typeof item === 'string' && item.trim()) {
        const pattern = item.trim();
        rows.push({ ...emptyFeed(), id: slugPattern(pattern), pattern });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const p = item as Partial<IndexPattern> & Record<string, unknown>;
      if (typeof p.pattern !== 'string' || !p.pattern.trim()) continue; // skip malformed
      const pattern = p.pattern.trim();
      const role = coerceRole(p.role);
      // Legacy split: `auto_correlate` historically drove BOTH correlate + auto-forward.
      const legacyAuto = p.auto_correlate !== false;
      const hasCorrelate = typeof p.correlate === 'boolean';
      const correlate = hasCorrelate ? (p.correlate as boolean) : legacyAuto || role === 'alerts';
      const autoInvestigate =
        typeof p.auto_investigate === 'boolean'
          ? p.auto_investigate
          : p.auto_investigate === null
            ? null
            : // legacy → derive: alerts always, else the legacy auto_correlate flag.
              role === 'alerts'
              ? true
              : legacyAuto
                ? true
                : false;
      rows.push({
        uid: nextFeedUid(),
        id: typeof p.id === 'string' && p.id ? p.id : slugPattern(pattern),
        label: typeof p.label === 'string' ? p.label : '',
        pattern,
        role,
        enabled: p.enabled !== false,
        query: typeof p.query === 'string' ? p.query : '',
        severityFloor:
          typeof p.severity_floor === 'number' && p.severity_floor >= 1 && p.severity_floor <= 6
            ? p.severity_floor
            : null,
        correlate,
        // For a legacy entry (no explicit correlate/auto_investigate split) leave
        // auto-investigate as `null` so the UI shows the derived default; only a
        // rich entry that carried an explicit boolean pins it.
        autoInvestigate: hasCorrelate || typeof p.auto_investigate === 'boolean' ? autoInvestigate : null,
        pollInterval:
          typeof p.poll_interval_seconds === 'number' && p.poll_interval_seconds > 0
            ? p.poll_interval_seconds
            : null,
        fieldMapping:
          p.field_mapping && typeof p.field_mapping === 'object'
            ? (p.field_mapping as FieldMappingsExtra)
            : {},
        messageField: typeof p.message_field === 'string' ? p.message_field : '',
      });
    }
  }
  if (rows.length) return rows;
  const fromSingle = splitPatterns(cfg.data_view_pattern).map((pattern): FeedRow => ({
    ...emptyFeed(),
    id: slugPattern(pattern),
    pattern,
  }));
  return fromSingle.length ? fromSingle : [emptyFeed()];
}

/**
 * Fold an editor feed row back into the wire `index_patterns` entry. Emits the rich
 * shape but stays back-compat: a default events feed serialises to essentially the
 * legacy `{pattern, role, auto_correlate}` plus an `id`. Only non-default fields are
 * written so the stored config stays lean.
 */
function feedToWire(row: FeedRow): IndexPattern {
  const pattern = row.pattern.trim();
  const wire: IndexPattern = {
    pattern,
    role: row.role,
    // Keep the legacy key in sync so the CURRENT backend (which only knows
    // `auto_correlate`) preserves identical auto-forward behaviour: a feed
    // auto-forwards when its effective auto-investigate is on.
    auto_correlate: derivedAutoInvestigate(row),
  };
  const id = (row.id || slugPattern(pattern)).trim();
  if (id) wire.id = id;
  if (row.label.trim()) wire.label = row.label.trim();
  if (!row.enabled) wire.enabled = false;
  if (row.query.trim()) wire.query = row.query.trim();
  if (row.severityFloor != null) wire.severity_floor = row.severityFloor;
  // The Wave-6 split. `correlate` defaults true; persist only when off.
  if (!row.correlate) wire.correlate = false;
  // auto_investigate: persist only an explicit operator override (null = derive).
  if (row.autoInvestigate !== null) wire.auto_investigate = row.autoInvestigate;
  if (row.pollInterval != null) wire.poll_interval_seconds = row.pollInterval;
  if (row.messageField.trim()) wire.message_field = row.messageField.trim();
  const fm: FieldMappingsExtra = {};
  for (const def of FIELD_MAPPING_DEFS) {
    const v = (row.fieldMapping[def.key] || '').trim();
    if (v) fm[def.key] = v;
  }
  if (Object.keys(fm).length) wire.field_mapping = fm;
  return wire;
}

/* ------------------------------------------------------------- cert picker - */

const CertFilePicker: React.FC<{ id: string; onText: (text: string) => void }> = ({
  id,
  onText,
}) => {
  const [err, setErr] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const onPick = (files: FileList | null) => {
    setErr(null);
    const file = files && files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onText(String(reader.result || '').trim());
    reader.onerror = () => setErr('Could not read the certificate file.');
    reader.readAsText(file);
  };

  return (
    <div className="space-y-1">
      <input
        ref={inputRef}
        id={`${id}-file`}
        type="file"
        accept={CERT_ACCEPT}
        className="hidden"
        onChange={(e) => onPick(e.target.files)}
        aria-label="Upload a certificate or PEM file"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
      >
        <FileUp className="h-4 w-4" aria-hidden /> Select a .pem / .crt file…
      </Button>
      <p className="text-xs text-muted-foreground">
        …or paste the certificate above. The file is read locally and only its text
        content is captured.
      </p>
      {err ? <p className="text-xs text-critical">{err}</p> : null}
    </div>
  );
};

/* ----------------------------------------------------------- dynamic field - */

const RequiredMark = () => <span className="text-critical"> *</span>;

const FieldRow: React.FC<{
  field: AuthField;
  manifest: ConnectorManifest;
  value: ConnectorFormValue;
  configuredSecrets: string[];
  showValidation: boolean;
  setConfig: (key: string, v: unknown) => void;
  setSecret: (key: string, v: string) => void;
}> = ({ field: f, manifest, value, configuredSecrets, showValidation, setConfig, setSecret }) => {
  const id = `cf-${manifest.source_type}-${f.key}`;
  const invalid =
    showValidation &&
    !!f.required &&
    (f.secret
      ? !value.secrets[f.key] && !configuredSecrets.includes(f.key)
      : value.config[f.key] === undefined ||
        value.config[f.key] === null ||
        value.config[f.key] === '');

  const help = f.help ? <p className="text-xs text-muted-foreground">{f.help}</p> : null;

  // bool → switch (inline)
  if (f.type === 'bool') {
    const checked =
      value.config[f.key] === undefined ? Boolean(f.default) : Boolean(value.config[f.key]);
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Switch
            id={id}
            checked={checked}
            onCheckedChange={(c) => setConfig(f.key, c)}
            aria-label={f.label}
          />
          <Label htmlFor={id} className="cursor-pointer">
            {f.label}
            {f.required ? <RequiredMark /> : null}
          </Label>
          <ConnectorFieldHelp field={f} />
        </div>
        {help}
      </div>
    );
  }

  let control: React.ReactNode;
  switch (f.type) {
    case 'password':
      control = (
        <Input
          id={id}
          type="password"
          autoComplete="off"
          placeholder={
            configuredSecrets.includes(f.key) ? 'configured — type to replace' : f.placeholder || ''
          }
          value={value.secrets[f.key] || ''}
          onChange={(e) => setSecret(f.key, e.target.value)}
          aria-invalid={invalid}
          className={cn(invalid && 'border-critical')}
        />
      );
      break;
    case 'number':
      control = (
        <Input
          id={id}
          type="number"
          placeholder={f.placeholder || ''}
          value={
            value.config[f.key] === undefined || value.config[f.key] === null
              ? f.default !== undefined && f.default !== null
                ? String(f.default)
                : ''
              : String(value.config[f.key])
          }
          onChange={(e) =>
            setConfig(f.key, e.target.value === '' ? '' : Number(e.target.value))
          }
          aria-invalid={invalid}
          className={cn(invalid && 'border-critical')}
        />
      );
      break;
    case 'textarea': {
      const textarea = (
        <Textarea
          id={id}
          placeholder={f.placeholder || ''}
          value={String(value.config[f.key] ?? f.default ?? '')}
          onChange={(e) => setConfig(f.key, e.target.value)}
          aria-invalid={invalid}
          className={cn('min-h-[7rem] font-mono text-xs', invalid && 'border-critical')}
        />
      );
      control = isCertField(f) ? (
        <div className="space-y-2">
          {textarea}
          <CertFilePicker id={id} onText={(text) => setConfig(f.key, text)} />
        </div>
      ) : (
        textarea
      );
      break;
    }
    case 'select': {
      const current = String(value.config[f.key] ?? f.default ?? '');
      control = (
        <Select
          value={current || undefined}
          onValueChange={(v) => setConfig(f.key, v)}
        >
          <SelectTrigger id={id} aria-invalid={invalid} className={cn(invalid && 'border-critical')}>
            <SelectValue placeholder="— select —" />
          </SelectTrigger>
          <SelectContent>
            {(f.options || []).map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
      break;
    }
    case 'multiselect': {
      // Render as a comma-joined text input fallback (the new UI keeps it simple;
      // values round-trip as an array). Each token is trimmed.
      const selected = Array.isArray(value.config[f.key])
        ? (value.config[f.key] as string[])
        : Array.isArray(f.default)
          ? (f.default as string[])
          : [];
      control = (
        <Input
          id={id}
          placeholder={f.placeholder || 'comma-separated values'}
          value={selected.join(', ')}
          onChange={(e) =>
            setConfig(
              f.key,
              e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          aria-invalid={invalid}
          className={cn(invalid && 'border-critical')}
        />
      );
      break;
    }
    default:
      control = (
        <Input
          id={id}
          placeholder={f.placeholder || ''}
          value={String(value.config[f.key] ?? f.default ?? '')}
          onChange={(e) => setConfig(f.key, e.target.value)}
          aria-invalid={invalid}
          className={cn(invalid && 'border-critical')}
        />
      );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex items-center gap-1.5">
        <span>
          {f.label}
          {f.required ? <RequiredMark /> : null}
        </span>
        <ConnectorFieldHelp field={f} />
        {f.secret && configuredSecrets.includes(f.key) ? (
          <span className="inline-flex items-center gap-1 text-xs text-success-text">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> configured
          </span>
        ) : null}
      </Label>
      {control}
      {f.secret ? (
        <p className="text-xs text-muted-foreground">
          {f.help ? `${f.help} ` : ''}Stored in the secret store; only ever shown as configured.
        </p>
      ) : (
        help
      )}
      {invalid ? <p className="text-xs text-critical">{f.label} is required.</p> : null}
    </div>
  );
};

/* ----------------------------------------------------------- feeds editor -- */

/** A 3-way role segmented control (events | alerts | ignore) with role colours. */
const RoleSegmented: React.FC<{
  value: FeedRole;
  onChange: (v: FeedRole) => void;
  idBase: string;
}> = ({ value, onChange, idBase }) => {
  // WAI-ARIA radiogroup: a SINGLE tab stop (roving tabindex — only the checked radio is
  // tabbable) plus arrow-key selection, so the announced radio semantics actually behave.
  const btnRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const move = (dir: 1 | -1) => {
    const cur = ROLE_DEFS.findIndex((r) => r.value === value);
    const next = ((cur < 0 ? 0 : cur) + dir + ROLE_DEFS.length) % ROLE_DEFS.length;
    onChange(ROLE_DEFS[next].value);
    btnRefs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Feed role"
      className="inline-flex rounded-md border border-border bg-surface p-0.5"
    >
      {ROLE_DEFS.map((r, i) => {
        const active = value === r.value;
        return (
          <button
            key={r.value}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            id={`${idBase}-role-${r.value}`}
            onClick={() => onChange(r.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(-1);
              }
            }}
            className={cn(
              'rounded px-2.5 py-1 text-xs font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? cn('border', r.active) : 'border border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
};

/** A small effective-config summary chip describing what a feed will actually do. */
const FeedPreviewChip: React.FC<{ row: FeedRow }> = ({ row }) => {
  if (row.role === 'ignore') {
    return (
      <Badge variant="secondary" className="font-normal">
        Dropped at ingest — never investigated
      </Badge>
    );
  }
  const ai = row.autoInvestigate === null ? derivedAutoInvestigate(row) : row.autoInvestigate;
  const parts: string[] = [];
  parts.push(row.role === 'alerts' ? 'Auto-triage every detection' : 'Correlate then triage');
  if (!row.correlate) parts.push('no correlation');
  parts.push(ai ? 'auto-investigate on' : 'manual triage only');
  if (row.severityFloor != null) {
    parts.push(`floor ≥ ${SEVERITY_LABELS[row.severityFloor]} (below: candidate only)`);
  }
  return (
    <Badge variant={row.role === 'alerts' ? 'critical' : 'info'} className="font-normal">
      {parts.join(' · ')}
    </Badge>
  );
};

/** The per-feed field-mapping override drawer (reuses the shared mapping editor). */
const FeedMappingDrawer: React.FC<{
  row: FeedRow;
  label: string;
  onChange: (patch: Partial<FeedRow>) => void;
}> = ({ row, label, onChange }) => {
  const count =
    Object.values(row.fieldMapping).filter((v) => (v || '').trim()).length +
    (row.messageField.trim() ? 1 : 0);
  const setMap = (key: keyof FieldMappingsExtra, v: string) =>
    onChange({ fieldMapping: { ...row.fieldMapping, [key]: v } });
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden /> Field mapping
          {count ? (
            <Badge variant="info" className="ml-1 px-1.5 py-0 font-normal">
              {count}
            </Badge>
          ) : null}
        </Button>
      </SheetTrigger>
      {/* The pinned SheetHeader (with the built-in close X) stays put while only the
          inner body scrolls — don't put overflow-y-auto on SheetContent itself, or the
          absolute X scrolls out of reach (#19). */}
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Feed field mapping</SheetTitle>
          <SheetDescription>
            Override how <span className="font-medium text-foreground">{label}</span> maps its
            native fields. Blank falls back to the source-level mapping, then global Settings.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <div className="space-y-1.5">
            <Label htmlFor={`${row.id}-msg`} className="flex items-center gap-1.5">
              Message field
              <HelpTip
                label="About the feed message field"
                text="The field shown as the human-readable message column for this feed. Overrides the source-level message field."
              />
            </Label>
            <Input
              id={`${row.id}-msg`}
              placeholder="e.g. message"
              value={row.messageField}
              onChange={(e) => onChange({ messageField: e.target.value })}
            />
          </div>
          {FIELD_MAPPING_DEFS.filter((d) => d.key !== 'message_field').map((def) => {
            const fid = `${row.id}-fm-${def.key}`;
            return (
              <div key={def.key} className="space-y-1.5">
                <Label htmlFor={fid} className="flex items-center gap-1.5">
                  {def.label}
                  <HelpTip label={`About ${def.label}`} text={def.help} />
                </Label>
                <Input
                  id={fid}
                  placeholder={def.placeholder}
                  value={row.fieldMapping[def.key] || ''}
                  onChange={(e) => setMap(def.key, e.target.value)}
                />
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
};

/** One editable feed card. */
const FeedCard: React.FC<{
  row: FeedRow;
  index: number;
  count: number;
  sourceId?: string;
  onPatch: (patch: Partial<FeedRow>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}> = ({ row, index, count, sourceId, onPatch, onRemove, onMove }) => {
  const idBase = `feed-${index}`;
  const label = row.label.trim() || row.pattern.trim() || `Feed ${index + 1}`;
  const ignore = row.role === 'ignore';
  const derivedAi = derivedAutoInvestigate(row);
  const aiChecked = row.autoInvestigate === null ? derivedAi : row.autoInvestigate;

  // --- the per-feed "test" affordance against the bounded browse endpoint ----
  const demoGuard = useDemoGuard();
  const [testing, setTesting] = React.useState(false);
  const [testMsg, setTestMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const runTest = async () => {
    if (!sourceId) {
      setTestMsg({ ok: false, text: 'Save the source first, then test a feed query.' });
      return;
    }
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await api.sourceLogs(sourceId, {
        limit: 5,
        query: row.query.trim() || undefined,
      });
      const n = res.count ?? res.logs.length;
      setTestMsg({ ok: true, text: `Matched — sampled ${n} event${n === 1 ? '' : 's'}.` });
    } catch (e) {
      setTestMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className={cn(
        'space-y-3 rounded-md border bg-surface/50 p-3',
        ignore ? 'border-dashed border-border opacity-90' : 'border-border',
      )}
    >
      {/* row 1: label + reorder/remove */}
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={`${idBase}-pattern`} className="flex items-center gap-1.5">
              Index / data-view pattern
              {!row.enabled ? (
                <Badge variant="secondary" className="px-1.5 py-0 font-normal">
                  disabled
                </Badge>
              ) : null}
            </Label>
            <Input
              id={`${idBase}-pattern`}
              placeholder="e.g. all-logs-* or wazuh-alerts-*"
              value={row.pattern}
              onChange={(e) => onPatch({ pattern: e.target.value })}
              aria-label={`Feed ${index + 1} index pattern`}
              className={cn('font-mono text-sm', ignore && 'line-through decoration-1')}
            />
          </div>
          <div className="space-y-1.5">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              Role
              <HelpTip
                label="About feed roles"
                text={`Alerts: ${ROLE_HELP.alerts}  ·  Events: ${ROLE_HELP.events}  ·  Ignore: ${ROLE_HELP.ignore}`}
              />
            </span>
            <RoleSegmented
              idBase={idBase}
              value={row.role}
              onChange={(v) => onPatch({ role: v })}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pt-6">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={index === 0}
            aria-label={`Move feed ${index + 1} up`}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={index === count - 1}
            aria-label={`Move feed ${index + 1} down`}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-critical"
            aria-label={`Remove feed ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      {/* row 2: label + enabled toggle */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={`${idBase}-label`}>Label (optional)</Label>
          <Input
            id={`${idBase}-label`}
            placeholder={row.pattern.trim() || 'A friendly name for this feed'}
            value={row.label}
            onChange={(e) => onPatch({ label: e.target.value })}
          />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch
            id={`${idBase}-enabled`}
            checked={row.enabled}
            onCheckedChange={(c) => onPatch({ enabled: c })}
            aria-label={`Feed ${index + 1} enabled`}
          />
          <Label htmlFor={`${idBase}-enabled`} className="cursor-pointer text-sm">
            Enabled
          </Label>
        </div>
      </div>

      {/* the triage knobs only apply when the feed is not ignored */}
      {!ignore ? (
        <>
          {/* row 3: correlate + auto-investigate switches */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex items-center gap-2">
              <Switch
                id={`${idBase}-correlate`}
                checked={row.correlate}
                onCheckedChange={(c) => onPatch({ correlate: c })}
                aria-label={`Feed ${index + 1} correlate`}
              />
              <Label htmlFor={`${idBase}-correlate`} className="cursor-pointer text-sm">
                Correlate
              </Label>
              <HelpTip
                label="About Correlate"
                text="When on (default), this feed's events are grouped into clusters before triage. Turn off only for feeds you never want correlated (events still register — they're never dropped)."
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id={`${idBase}-ai`}
                checked={aiChecked}
                onCheckedChange={(c) =>
                  // Toggling pins an explicit override; toggling back to the derived
                  // default keeps it explicit (operator intent is now recorded).
                  onPatch({ autoInvestigate: c })
                }
                aria-label={`Feed ${index + 1} auto-investigate`}
              />
              <Label htmlFor={`${idBase}-ai`} className="cursor-pointer text-sm">
                Auto-investigate
              </Label>
              {row.autoInvestigate === null ? (
                <Badge variant="secondary" className="px-1.5 py-0 font-normal">
                  default: {derivedAi ? 'on' : 'off'}
                </Badge>
              ) : null}
              <HelpTip
                label="About Auto-investigate"
                text="When on, this feed's clusters are auto-forwarded to AI investigation. Alerts feeds default on; events feeds follow Correlate. Showing 'default' means it's deriving from the role — toggle to pin it."
              />
            </div>
          </div>

          {/* row 4: severity floor slider */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5">
                Severity floor
                <HelpTip
                  label="About the severity floor"
                  text="Below this OCSF severity, events still register as candidates + live-tail (never dropped, non-negotiable #4) but are NOT auto-forwarded. 'None' = no floor."
                />
              </Label>
              <span className="text-xs font-medium text-muted-foreground">
                {row.severityFloor == null
                  ? 'None'
                  : `${SEVERITY_LABELS[row.severityFloor]} (${row.severityFloor})`}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Slider
                aria-label={`Feed ${index + 1} severity floor`}
                min={0}
                max={6}
                step={1}
                value={[row.severityFloor ?? 0]}
                onValueChange={(v) =>
                  onPatch({ severityFloor: v[0] === 0 ? null : v[0] })
                }
                className="max-w-sm"
              />
              {row.severityFloor != null ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => onPatch({ severityFloor: null })}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {/* row 5: connector-native query + test */}
      <div className="space-y-1.5">
        <Label htmlFor={`${idBase}-query`} className="flex items-center gap-1.5">
          Feed query (optional)
          <HelpTip
            label="About the feed query"
            text="A connector-native filter applied to this feed only (e.g. an Elasticsearch query_string). Operator-authored and trusted; it is never fed to the AI as a prompt."
          />
        </Label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <Input
            id={`${idBase}-query`}
            placeholder='e.g. event.outcome:"failure" and not user.name:"svc-*"'
            value={row.query}
            onChange={(e) => onPatch({ query: e.target.value })}
            className="flex-1 font-mono text-xs"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                // Soft-disable the GUARDED states (demo / not-yet-saved) so the button stays
                // hoverable/focusable and the tooltip that EXPLAINS why can still open; only
                // the transient in-flight `testing` uses the real disabled attribute.
                disabled={testing}
                aria-disabled={demoGuard.disabled || !sourceId || undefined}
                className={cn((demoGuard.disabled || !sourceId) && 'opacity-50')}
                onClick={() => {
                  if (!demoGuard.disabled) void runTest();
                }}
              >
                {testing ? (
                  <LoadingGlyph size="sm" className="size-3.5" />
                ) : (
                  <Beaker className="h-3.5 w-3.5" aria-hidden />
                )}
                Test
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {demoGuard.disabled
                ? demoGuard.reason
                : !sourceId
                  ? 'Save the source first, then test a feed query against the live source.'
                  : 'Runs the feed query against the live source via the bounded, read-only browse endpoint (max 5 sampled rows).'}
            </TooltipContent>
          </Tooltip>
        </div>
        {testMsg ? (
          // browse-endpoint message is authoritative → plain text only
          <p className={cn('text-xs', testMsg.ok ? 'text-success-text' : 'text-critical-text')}>
            {testMsg.text}
          </p>
        ) : null}
      </div>

      {/* row 6: schedule + field-mapping drawer */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idBase}-sched`} className="flex items-center gap-1.5">
            Poll schedule
            <HelpTip
              label="About the feed schedule"
              text="How often this feed is polled, in seconds. Leave blank to inherit the source-wide interval. A fast alerts feed and a slow events feed keep independent cursors so neither skips the other."
            />
          </Label>
          <Input
            id={`${idBase}-sched`}
            type="number"
            min={1}
            placeholder="inherit"
            value={row.pollInterval == null ? '' : String(row.pollInterval)}
            onChange={(e) =>
              onPatch({
                pollInterval: e.target.value === '' ? null : Math.max(1, Number(e.target.value) || 0) || null,
              })
            }
            className="w-32"
          />
        </div>
        <div className="pb-0.5">
          <FeedMappingDrawer row={row} label={label} onChange={onPatch} />
        </div>
      </div>

      {/* effective-config preview */}
      <div className="pt-0.5">
        <FeedPreviewChip row={row} />
      </div>
    </div>
  );
};

const IndexPatternsEditor: React.FC<{
  rows: FeedRow[];
  onChange: (rows: FeedRow[]) => void;
  sourceId?: string;
}> = ({ rows, onChange, sourceId }) => {
  const patchRow = (i: number, patch: Partial<FeedRow>) =>
    onChange(
      rows.map((r, idx) => {
        if (idx !== i) return r;
        const next = { ...r, ...patch };
        // Keep an id derived from the pattern when the operator hasn't set one and
        // the pattern changes — so feeds keep distinct, stable cursor keys.
        if ('pattern' in patch && (!r.id || r.id === slugPattern(r.pattern))) {
          next.id = slugPattern(next.pattern);
        }
        return next;
      }),
    );
  const addRow = () => onChange([...rows, emptyFeed()]);
  const removeRow = (i: number) =>
    onChange(rows.length > 1 ? rows.filter((_, idx) => idx !== i) : [emptyFeed()]);
  const moveRow = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Each <strong>feed</strong> is an index / data-view pattern this source reads, with a
        role: <span className="font-medium text-critical">Alerts</span> (every detection is
        auto-triaged), <span className="font-medium text-info">Events</span> (correlated, then
        allowlist-gated), or <span className="font-medium">Ignore</span> (dropped at ingest).
        More specific ignore feeds take precedence over broader feeds.
      </p>
      <div className="space-y-3">
        {rows.map((row, i) => (
          <FeedCard
            key={row.uid}
            row={row}
            index={i}
            count={rows.length}
            sourceId={sourceId}
            onPatch={(patch) => patchRow(i, patch)}
            onRemove={() => removeRow(i)}
            onMove={(dir) => moveRow(i, dir)}
          />
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus className="h-4 w-4" aria-hidden /> Add feed
      </Button>
    </div>
  );
};

/* ------------------------------------------------------------ setup help --- */

/** Renders a connector's `setup_help` guide as plain text (trusted; never markup). */
const SetupHelpGuide: React.FC<{ help: string; connectorName: string }> = ({
  help,
  connectorName,
}) => (
  <Accordion type="single" collapsible className="rounded-md border border-border bg-surface/60 px-4">
    <AccordionItem value="setup-help" className="border-b-0">
      <AccordionTrigger className="py-3">
        <span className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" aria-hidden />
          How to add {connectorName}
        </span>
      </AccordionTrigger>
      <AccordionContent>
        {/* `setup_help` is author-controlled (trusted) but rendered as plain,
            pre-wrapped text — never as live markup. */}
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {help}
        </p>
      </AccordionContent>
    </AccordionItem>
  </Accordion>
);

/* ----------------------------------------------------- field-mapping editor */

/** The canonical mapping keys + per-field help (F9). */
const FIELD_MAPPING_DEFS: Array<{
  key: keyof FieldMappingsExtra;
  label: string;
  placeholder: string;
  help: string;
}> = [
  {
    key: 'source_ip_field',
    label: 'Source IP field',
    placeholder: 'e.g. source.ip',
    help: 'The source-native field holding the source IP. Used as the primary correlation entity by default.',
  },
  {
    key: 'user_field',
    label: 'User field',
    placeholder: 'e.g. user.name',
    help: 'The field holding the acting user / account name.',
  },
  {
    key: 'host_field',
    label: 'Host field',
    placeholder: 'e.g. host.name',
    help: 'The field holding the hostname / asset the event concerns.',
  },
  {
    key: 'message_field',
    label: 'Message field',
    placeholder: 'e.g. message',
    help: 'The field shown as the human-readable message column when browsing logs and in chat.',
  },
  {
    key: 'severity_field',
    label: 'Severity field',
    placeholder: 'e.g. event.severity',
    help: 'The field holding the source severity. Drives the in-scope severity threshold.',
  },
  {
    key: 'rule_field',
    label: 'Rule field',
    placeholder: 'e.g. rule.id',
    help: 'The field holding the detection rule id / name that fired.',
  },
];

/* ---------------------------------------------------------- test callout --- */

interface TestResult {
  ok: boolean;
  message: string;
  sample?: number | null;
  mode?: string | null;
  cluster_monitor?: boolean | null;
}

const TestResultCallout: React.FC<{ result: TestResult }> = ({ result }) => {
  const readOnly = result.ok && result.mode === 'read_only';
  const title = !result.ok
    ? 'Connection failed'
    : readOnly
      ? 'Read-only key verified'
      : result.mode === 'full'
        ? 'Connection verified (full access)'
        : 'Connection succeeded';

  return (
    <Alert variant={result.ok ? 'default' : 'destructive'}>
      {result.ok ? (
        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
      ) : (
        <AlertTriangle className="h-4 w-4" aria-hidden />
      )}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {/* backend message is authoritative → rendered as plain text */}
        <p>
          {result.message}
          {typeof result.sample === 'number'
            ? ` — sampled ${result.sample} event${result.sample === 1 ? '' : 's'}.`
            : ''}
        </p>
        {readOnly ? (
          <p className="mt-2">
            The agent can read logs from this source. A <code>cluster:monitor</code> privilege
            is <strong>not</strong> required — a correctly-scoped read-only key is exactly what
            we want.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
};

/* ----------------------------------------------------------- section head -- */

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
    {children}
  </div>
);

/* --------------------------------------------------------------- editor ---- */

export interface SourceEditorProps {
  connectors: ConnectorManifest[];
  /** An existing source to edit (config pre-filled); omit to add a new one. */
  existing?: SourceInstance;
  /** Default to primary on first save (e.g. the wizard's first source). */
  defaultPrimary?: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}

export const SourceEditor: React.FC<SourceEditorProps> = ({
  connectors,
  existing,
  defaultPrimary,
  onSaved,
  onCancel,
}) => {
  const editing = Boolean(existing);
  const [manifest, setManifest] = React.useState<ConnectorManifest | null>(
    existing ? connectors.find((c) => c.source_type === existing.source_type) || null : null,
  );
  const [value, setValue] = React.useState<ConnectorFormValue>({
    config: (existing?.config as Record<string, unknown>) || {},
    secrets: {},
  });
  const [displayName, setDisplayName] = React.useState(existing?.display_name || '');
  const [enabled, setEnabled] = React.useState(existing?.enabled ?? true);
  const [isPrimary, setIsPrimary] = React.useState(existing?.is_primary ?? defaultPrimary ?? false);
  const canBePrimary = manifest?.ingest_modes?.includes('pull') ?? false;
  const [showValidation, setShowValidation] = React.useState(false);

  const [patterns, setPatterns] = React.useState<FeedRow[]>(() =>
    deriveIndexPatterns((existing?.config as Record<string, unknown>) || {}),
  );
  const [entityStrategy, setEntityStrategy] = React.useState<string>(
    ((existing?.config as Partial<SourceConfigExtras>)?.entity_strategy as string) || 'auto',
  );
  const [messageField, setMessageField] = React.useState<string>(
    ((existing?.config as Partial<SourceConfigExtras>)?.message_field as string) || '',
  );
  // Per-source Auto-Correlate (F6) — defaults TRUE so today's behaviour is identical.
  const [autoCorrelate, setAutoCorrelate] = React.useState<boolean>(
    (existing?.config as Partial<SourceConfigExtras>)?.auto_correlate !== false,
  );
  // The DECLARED ceiling of this source's native severity ladder. Held as TEXT so the
  // field has an honest empty state: blank means UNDECLARED (the 100 identity
  // projection), which is a different instruction to the backend than any number.
  const [severityScaleMax, setSeverityScaleMax] = React.useState<string>(
    existing?.severity_scale_max != null ? String(existing.severity_scale_max) : '',
  );
  // Per-source field-mapping overrides (F9).
  const [fieldMappings, setFieldMappings] = React.useState<FieldMappingsExtra>(
    () =>
      ((existing?.config as Partial<SourceConfigExtras>)?.field_mappings_extra as FieldMappingsExtra) ||
      {},
  );
  // "Paste a sample record" → analyze-sample (F9). The sample is never persisted.
  const [sampleText, setSampleText] = React.useState('');
  const [analyzing, setAnalyzing] = React.useState(false);
  const [analyzeError, setAnalyzeError] = React.useState<string | null>(null);
  const [analyzedFields, setAnalyzedFields] = React.useState<string[]>([]);
  // Which of the default case-evidence paths the pasted record carries — the answer
  // to "do MY alerts carry the fields that decide the case?". Every entry is one of
  // the backend's own constants matched against the sample, never a path echoed back
  // from the untrusted record.
  const [evidencePresent, setEvidencePresent] = React.useState<string[]>([]);

  const [testing, setTesting] = React.useState(false);
  // Test-connection runs a REAL connector against a live source — block it in demo.
  const demoGuard = useDemoGuard();
  const [testResult, setTestResult] = React.useState<TestResult | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (manifest && !displayName && !editing) setDisplayName(manifest.display_name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest]);

  const configuredSecrets = existing?.configured_secrets || [];

  const manifestHasMessageField = React.useMemo(
    () => allFields(manifest || ({} as ConnectorManifest)).some((f) => f.key === 'message_field'),
    [manifest],
  );

  const groups = React.useMemo(
    () => (manifest ? groupFields(allFields(manifest)) : []),
    [manifest],
  );

  const setConfig = (key: string, v: unknown) =>
    setValue((prev) => ({ ...prev, config: { ...prev.config, [key]: v } }));
  const setSecret = (key: string, v: string) =>
    setValue((prev) => ({ ...prev, secrets: { ...prev.secrets, [key]: v } }));

  const pickConnector = (m: ConnectorManifest) => {
    setManifest(m);
    setValue({ config: {}, secrets: {} });
    setPatterns(deriveIndexPatterns({}));
    setEntityStrategy('auto');
    setMessageField('');
    setAutoCorrelate(true);
    setFieldMappings({});
    setSampleText('');
    setAnalyzedFields([]);
    setAnalyzeError(null);
    setTestResult(null);
    setError(null);
    // Start the freshly-picked connector's form clean: seed its own default name and
    // clear any validation errors left over from a prior connector's failed Save.
    setDisplayName(m.display_name);
    setShowValidation(false);
  };

  const setMapping = (key: keyof FieldMappingsExtra, v: string) =>
    setFieldMappings((prev) => ({ ...prev, [key]: v }));

  const runAnalyzeSample = async () => {
    if (!existing?.id) {
      setAnalyzeError('Save the source first, then paste a sample to get suggestions.');
      return;
    }
    const raw = sampleText.trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setAnalyzeError('That is not valid JSON. Paste a single record as a JSON object.');
      return;
    }
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await api.sources.analyzeSample(existing.id, parsed);
      setAnalyzedFields(Array.isArray(res.fields) ? res.fields : []);
      setEvidencePresent(
        Array.isArray(res.suggested_evidence_fields) ? res.suggested_evidence_fields : [],
      );
      const sugg = res.suggested_mappings || {};
      setFieldMappings((prev) => {
        const next: FieldMappingsExtra = { ...prev };
        for (const def of FIELD_MAPPING_DEFS) {
          const v = sugg[def.key];
          // Only pre-fill fields the operator hasn't already set.
          if (typeof v === 'string' && v && !next[def.key]) next[def.key] = v;
        }
        return next;
      });
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : 'Could not analyze the sample.');
    } finally {
      setAnalyzing(false);
    }
  };

  const onTest = async () => {
    if (!manifest) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await api.testConnector({
        source_id: existing?.id ?? null,
        source_type: manifest.source_type,
        config: buildConfig(),
        secrets: value.secrets,
      });
      setTestResult({
        ok: res.ok,
        message: res.message || (res.ok ? 'OK' : 'Failed'),
        sample: res.sample_count,
        mode: res.mode ?? null,
        cluster_monitor: res.cluster_monitor ?? null,
      });
    } catch (e) {
      setError(e);
    } finally {
      setTesting(false);
    }
  };

  /** Fold the advanced-config editors back into the form's `config` before save. */
  const buildConfig = (): Record<string, unknown> => {
    // Drop blank-pattern rows, then serialise each feed to its wire entry.
    const cleanFeeds: IndexPattern[] = patterns
      .filter((p) => p.pattern.trim())
      .map((p) => feedToWire(p));

    // The legacy `data_view_pattern` fallback is the comma-join of NON-ignore
    // patterns (IGNORE feeds are dropped at ingest → never part of the read view).
    const readablePatterns = cleanFeeds
      .filter((p) => p.role !== 'ignore')
      .map((p) => p.pattern);
    const firstPattern = (readablePatterns[0] || cleanFeeds[0]?.pattern || '').trim();

    const cfg: Record<string, unknown> = { ...value.config };

    if (cleanFeeds.length) {
      cfg.index_patterns = cleanFeeds;
      cfg.data_view_pattern = (readablePatterns.length ? readablePatterns : [firstPattern]).join(
        ',',
      );
    } else {
      delete cfg.index_patterns;
    }

    const es = (entityStrategy || 'auto').trim();
    if (es && es !== 'auto') cfg.entity_strategy = es;
    else delete cfg.entity_strategy;

    const mf = messageField.trim();
    if (mf) cfg.message_field = mf;
    else if (!manifestHasMessageField) delete cfg.message_field;

    // Per-source Auto-Correlate (F6). Store only when OFF (default TRUE) so the
    // out-of-the-box config doc is byte-identical to today's.
    if (autoCorrelate) delete cfg.auto_correlate;
    else cfg.auto_correlate = false;

    // Per-source field-mapping overrides (F9): keep only non-empty entries.
    const fm: Record<string, string> = {};
    for (const def of FIELD_MAPPING_DEFS) {
      const v = (fieldMappings[def.key] || '').trim();
      if (v) fm[def.key] = v;
    }
    if (Object.keys(fm).length) cfg.field_mappings_extra = fm;
    else delete cfg.field_mappings_extra;

    return cfg;
  };

  const onSave = async () => {
    if (!manifest) return;
    const mergedValue: ConnectorFormValue = { ...value, config: buildConfig() };
    const missing = missingRequired(manifest, mergedValue, configuredSecrets);
    if (missing.length) {
      setShowValidation(true);
      setError(new Error(`Please complete required fields: ${missing.map((m) => m.label).join(', ')}`));
      return;
    }
    // Blank CLEARS the declaration (explicit null); a number DECLARES it. The backend
    // rejects <= 0 and non-finite with a 422, so catch it here for a readable message.
    const rawCeiling = severityScaleMax.trim();
    let ceiling: number | null = null;
    if (rawCeiling) {
      const parsed = Number(rawCeiling);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setShowValidation(true);
        setError(new Error('Severity ladder maximum must be a number greater than 0.'));
        return;
      }
      ceiling = parsed;
    }
    setSaving(true);
    setError(null);
    try {
      const id =
        existing?.id ||
        slugify(displayName || manifest.source_type) + '-' + Date.now().toString(36).slice(-4);
      await saveSource(manifest, mergedValue, {
        id,
        displayName: displayName || manifest.display_name,
        enabled,
        isPrimary: canBePrimary && isPrimary,
        ingestMode: existing?.ingest_mode ?? null,
        severityScaleMax: ceiling,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e : new Error(String(e)));
    } finally {
      setSaving(false);
    }
  };

  if (!connectors.length) {
    return (
      <LoadingState
        label="Loading source catalog"
        description="Fetching the connectors available to this deployment."
        layout="panel"
        shape="panel"
        className="min-h-[18rem]"
      />
    );
  }

  // --- connector picker step (add flow, before a connector is chosen) --- //
  if (!manifest) {
    return (
      <div className="space-y-5">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Choose the system you want the agent to read security events from.
        </p>
        <ConnectorPicker connectors={connectors} onSelect={pickConnector} />
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="font-semibold text-foreground">{manifest.display_name}</span>{' '}
          <span className="text-xs text-muted-foreground">({manifest.source_type})</span>
        </div>
        {!editing ? (
          <Button variant="ghost" size="sm" onClick={() => setManifest(null)}>
            <ArrowLeft className="h-4 w-4" aria-hidden /> Choose a different connector
          </Button>
        ) : null}
      </div>

      {/* connector-level "how to add this source" guide (F9) */}
      {manifest.setup_help ? (
        <SetupHelpGuide help={manifest.setup_help} connectorName={manifest.display_name} />
      ) : null}

      {/* identity */}
      <div className="space-y-1.5">
        <Label htmlFor="se-display">Display name</Label>
        <Input
          id="se-display"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={manifest.display_name}
        />
        <p className="text-xs text-muted-foreground">A friendly name shown across the console.</p>
      </div>

      <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-md border border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Switch id="se-enabled" checked={enabled} onCheckedChange={setEnabled} />
          <Label htmlFor="se-enabled" className="cursor-pointer">
            Enabled
          </Label>
        </div>
        <div className="flex items-center gap-2.5">
          <Switch
            id="se-primary"
            checked={canBePrimary && isPrimary}
            onCheckedChange={setIsPrimary}
            disabled={!canBePrimary}
          />
          <Label htmlFor="se-primary" className="cursor-pointer">
            {canBePrimary
              ? 'Primary (the agent reads from this)'
              : 'Primary query source (pull connectors only)'}
          </Label>
        </div>
        <div className="flex items-center gap-2.5">
          <Switch
            id="se-autocorrelate"
            checked={autoCorrelate}
            onCheckedChange={setAutoCorrelate}
          />
          <Label htmlFor="se-autocorrelate" className="cursor-pointer">
            Auto-Correlate
          </Label>
          <HelpTip
            label="About Auto-Correlate"
            text="When on (default), this source's correlated clusters are automatically forwarded to AI investigation. Turn it off to keep this source in manual triage only — events still correlate into clusters, but the agent won't investigate them automatically. You can also toggle this per index pattern below."
          />
        </div>
      </div>

      <Separator />

      {/* dynamic connector fields, grouped */}
      <div className="space-y-6">
        {groups.map(([group, fields]) => (
          <div key={group} className="space-y-3">
            <SectionTitle>{group}</SectionTitle>
            {fields.map((f) => (
              <FieldRow
                key={f.key}
                field={f}
                manifest={manifest}
                value={value}
                configuredSecrets={configuredSecrets}
                showValidation={showValidation}
                setConfig={setConfig}
                setSecret={setSecret}
              />
            ))}
          </div>
        ))}
      </div>

      <Separator />

      {/* advanced triage config */}
      <div className="space-y-3">
        <SectionTitle>Feeds</SectionTitle>
        <IndexPatternsEditor rows={patterns} onChange={setPatterns} sourceId={existing?.id} />
      </div>

      <div className="space-y-3">
        <SectionTitle>Correlation</SectionTitle>
        <div className="space-y-1.5">
          <Label htmlFor="se-entity">Entity strategy</Label>
          <Select value={entityStrategy} onValueChange={setEntityStrategy}>
            <SelectTrigger id="se-entity" className="sm:w-[22rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENTITY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.text}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            How a cluster's primary entity is chosen for correlation. Use this for sources that
            don't send a source IP (e.g. an audit log) so their events still form cases — pin
            Host, User or Rule.
          </p>
        </div>
      </div>

      {!manifestHasMessageField ? (
        <div className="space-y-3">
          <SectionTitle>Display</SectionTitle>
          <div className="space-y-1.5">
            <Label htmlFor="se-msg">Message field</Label>
            <Input
              id="se-msg"
              placeholder="e.g. message"
              value={messageField}
              onChange={(e) => setMessageField(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The field shown as the human-readable message column when browsing this source's
              logs and in chat (e.g. message, rule.description, event.original). Leave blank to
              auto-detect.
            </p>
          </div>
        </div>
      ) : null}

      {/* advanced — per-source field mapping (F9) */}
      <Accordion type="single" collapsible className="rounded-md border border-border">
        <AccordionItem value="field-mapping" className="border-b-0 px-4">
          <AccordionTrigger className="py-3">
            <span className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" aria-hidden />
              Advanced — field mapping &amp; severity scale
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Override how this source&apos;s native fields map onto the canonical entity /
              message / severity / rule columns. Leave a field blank to fall back to the global
              mapping in Settings.
            </p>

            {/* paste a sample record → suggested mappings */}
            <div className="space-y-2 rounded-md border border-border bg-surface/50 p-3">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="se-sample" className="text-xs">
                  Paste a sample record (optional)
                </Label>
                <HelpTip
                  label="About sample analysis"
                  text="Paste a single raw JSON record from this source. We analyze it on the server to suggest field mappings and never persist the sample. Available after the source is saved."
                />
              </div>
              <Textarea
                id="se-sample"
                placeholder='{"source": {"ip": "1.2.3.4"}, "user": {"name": "alice"}, "message": "…"}'
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                className="min-h-[6rem] font-mono text-xs"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void runAnalyzeSample()}
                  disabled={analyzing || !sampleText.trim()}
                >
                  {analyzing ? (
                    <LoadingGlyph size="sm" className="size-4" />
                  ) : (
                    <Sparkles className="h-4 w-4" aria-hidden />
                  )}
                  Suggest mappings
                </Button>
                {!existing?.id ? (
                  <span className="text-xs text-muted-foreground">
                    Save the source first to enable sample analysis.
                  </span>
                ) : null}
              </div>
              {analyzeError ? <p className="text-xs text-critical">{analyzeError}</p> : null}
              {analyzedFields.length ? (
                <p className="text-xs text-muted-foreground">
                  {/* field paths are UNTRUSTED — rendered as plain text. */}
                  Detected {analyzedFields.length} field
                  {analyzedFields.length === 1 ? '' : 's'}; suggestions pre-filled below where
                  empty.
                </p>
              ) : null}
              {analyzedFields.length ? (
                <p className="text-xs text-muted-foreground">
                  {evidencePresent.length ? (
                    <>
                      Carries {evidencePresent.length} case-evidence field
                      {evidencePresent.length === 1 ? '' : 's'} the agent reads:{' '}
                      {/* These are the backend's own constants, not sample-derived. */}
                      <span className="font-mono">{evidencePresent.join(', ')}</span>.
                    </>
                  ) : (
                    <>
                      This record carries none of the default case-evidence fields. If the
                      field that decides your rule is here under another name, add its path
                      under Settings &rsaquo; General &rsaquo; Case evidence fields, or set{' '}
                      <span className="font-mono">evidence_fields</span> on this source.
                    </>
                  )}
                </p>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {FIELD_MAPPING_DEFS.map((def) => {
                const fid = `se-fm-${def.key}`;
                return (
                  <div key={def.key} className="space-y-1.5">
                    <Label htmlFor={fid} className="flex items-center gap-1.5">
                      {def.label}
                      <HelpTip label={`About ${def.label}`} text={def.help} />
                    </Label>
                    <Input
                      id={fid}
                      placeholder={def.placeholder}
                      value={fieldMappings[def.key] || ''}
                      onChange={(e) => setMapping(def.key, e.target.value)}
                    />
                  </div>
                );
              })}
            </div>

            <div className="space-y-1.5 border-t border-border pt-4">
              <Label htmlFor="se-sev-scale" className="flex items-center gap-1.5">
                Severity ladder maximum
                <HelpTip
                  label="About the severity ladder maximum"
                  text="The highest value this source can put in its severity field. Every severity is projected onto 0-100 as min(100, max(0, raw / maximum * 100)) before it is banded."
                />
              </Label>
              <Input
                id="se-sev-scale"
                type="number"
                // No `min` attribute: the valid range is strictly ABOVE zero, which the
                // attribute cannot express, and `min={0}` would advertise 0 as allowed.
                // Validation on save is the single authority (and matches the backend's
                // `gt=0` boundary).
                step="any"
                inputMode="decimal"
                placeholder="100 (leave blank if this source rates severity 0-100)"
                value={severityScaleMax}
                onChange={(e) => setSeverityScaleMax(e.target.value)}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Declare this if the source does <strong>not</strong> rate severity on 0-100 —
                e.g. enter <code>10</code> for a 0-10 ladder or <code>16</code> for a 0-16 rule
                level. Severities are projected as{' '}
                <code>min(100, max(0, raw / maximum &times; 100))</code>. Leave blank to read
                the number as-is on 0-100; a narrow ladder left blank reads roughly ten times
                too low on the severity chip, in the Noise-Reduction funnel and against a
                feed&apos;s severity floor.
              </p>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {testResult ? <TestResultCallout result={testResult} /> : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>Could not save / test</AlertTitle>
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      ) : null}

      {/* actions */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              // Soft-disable the demo guard so the explaining tooltip stays reachable; keep
              // the real disabled only for the transient in-flight `testing` state.
              onClick={() => {
                if (!demoGuard.disabled) void onTest();
              }}
              disabled={testing}
              aria-disabled={demoGuard.disabled || undefined}
              className={cn(demoGuard.disabled && 'opacity-50')}
            >
              {testing ? (
                <LoadingGlyph size="sm" className="size-4" />
              ) : (
                <Beaker className="h-4 w-4" aria-hidden />
              )}
              Test connection
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {demoGuard.disabled
              ? demoGuard.reason
              : 'Tests this draft without saving it. Current configuration and newly typed secret values are sent only to the bounded connection-test endpoint.'}
          </TooltipContent>
        </Tooltip>
        <Button onClick={onSave} disabled={saving}>
          {saving ? (
            <LoadingGlyph size="sm" className="size-4" />
          ) : (
            <Save className="h-4 w-4" aria-hidden />
          )}
          {editing ? 'Save changes' : 'Add source'}
        </Button>
      </div>
    </div>
  );
};

export default SourceEditor;
