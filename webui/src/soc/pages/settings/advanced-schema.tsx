/**
 * All settings: the schema-driven generic renderer (Round-5 Sett-C / G3 §4; Round 14
 * grouped panels, labels humanised with known acronyms).
 *
 * The backend ships a best-effort SCHEMA reflector at `GET /api/settings/schema` that
 * describes every `Preferences` field (type + default + enum choices + element models).
 * Historically it had ZERO consumers, so any engine knob NOT hand-coded into a curated
 * section was uneditable. This renderer wires that endpoint into a generic form so the
 * LONG TAIL of settings is editable-by-default (the structural fix for the "add config +
 * endpoint, forget the form" coupling failure).
 *
 * Contract & safety:
 *   - It writes through the SAME `{prefs, update}` buffer as every curated section, so
 *     Save still sends only the CHANGED top-level keys via the deep-merge `PUT /api/settings`
 *     (a sibling block is never wiped). It never full-doc-replaces.
 *   - It edits SCALARS (bool/int/number/string/enum) generically. Nested objects and
 *     collections (list/dict, incl. element-model rule collections) are DESCRIBED read-only
 *     with a pointer to their dedicated curated section, editing structured rule shapes
 *     generically is unsafe (#3-adjacent) and the curated editors own that.
 *   - Two knobs are SPECIAL-CASED (never generically editable): `demo` (managed only via
 *     the `/api/demo/*` endpoints, a settings PUT can't flip it) and `read_only_settings_mode`
 *     (a console can't self-lock through the generic form; unlock lives in Advanced › lock).
 *   - Every rendered label/description is operator-authored (trusted); no secret VALUE is
 *     ever shown, the schema carries defaults + field names only (#10).
 */
import * as React from 'react';
import { Info, Lock, Search } from 'lucide-react';

import { api } from '@/lib/api';
import type {
  Preferences,
  SettingsSchema,
  SettingsSchemaField,
  SettingsSchemaSection,
} from '@/lib/types';
import { humanizeToken } from '@/lib/format';

import { Input } from '@/ui/input';
import { LoadingState, StatusDot } from '@/design-system';
import { FilterBar } from '@/soc/components/FilterBar';
import { LoadError } from '@/soc/components/LoadError';
import { EmptyState } from '@/soc/components/EmptyState';

import {
  NumPref,
  SettingRow,
  SettingsGroup,
  SettingsSection,
  TextPref,
  type SecProps,
} from './primitives';

/** Top-level keys that get a dedicated curated section, hidden from the generic long tail
 * so the same knob isn't editable in two places (the curated editor is authoritative). */
const CURATED_SECTIONS: ReadonlySet<string> = new Set([
  // The generic renderer is the LONG TAIL, anything with a rich curated home is excluded.
  // (Kept intentionally small: only the blocks whose generic editing would be redundant or
  // unsafe. `general`/scalars still show so newly-added knobs surface by default.)
  'auto_close',
  'fp_auto_close',
  'notifications',
  'branding',
  'sso',
  'mfa',
  'rbac',
  'threshold_automation',
  'case_id_format',
  // `caps` (per-case caps + emergency kill switch) and `rag` (suppression) both have
  // dedicated curated editors in Advanced, so exclude them from the generic long tail to
  // keep a single authoritative editor per knob.
  'caps',
  'rag',
  // The Chat assistant section (`chat-agent.tsx`) edits every `chat_agent` knob.
  'chat_agent',
  // Round 14: Discounted inference (`batch`) and Runbooks (`runbooks`) have their own
  // sections now.
  'batch',
  'runbooks',
]);

/**
 * Words the generic labels spell in capitals (SE11): "Source ip field" reads "Source IP
 * field". Matched as whole words, case-insensitively.
 */
const ACRONYMS: Readonly<Record<string, string>> = {
  ai: 'AI',
  api: 'API',
  cidr: 'CIDR',
  csv: 'CSV',
  es: 'ES',
  http: 'HTTP',
  https: 'HTTPS',
  id: 'ID',
  ids: 'IDs',
  ioc: 'IOC',
  iocs: 'IOCs',
  ip: 'IP',
  ips: 'IPs',
  json: 'JSON',
  llm: 'LLM',
  mfa: 'MFA',
  mitre: 'MITRE',
  mttr: 'MTTR',
  ocsf: 'OCSF',
  oidc: 'OIDC',
  rag: 'RAG',
  rbac: 'RBAC',
  sla: 'SLA',
  sso: 'SSO',
  tls: 'TLS',
  ttl: 'TTL',
  uri: 'URI',
  url: 'URL',
  urls: 'URLs',
  utc: 'UTC',
};

/** A schema field or block name as a sentence-case label with known acronyms in capitals. */
export function schemaLabel(name: string): string {
  return humanizeToken(name)
    .split(' ')
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word)
    .join(' ');
}

/**
 * A backend section title in sentence case (SPEC §3.1, §4.9.1): the schema sends Title
 * Case ("Risk Weights", "Cross-Source Correlation", "SLA Policy") and falls back to
 * `str.title()` for any key it has no name for. Every word after the first is lower-cased
 * (hyphenated parts too), except a known acronym (`ACRONYMS`) or a word already written
 * in capitals, so "SLA Policy" reads "SLA policy" and "Case ID Format" reads "Case ID
 * format". `midSentence` lower-cases the first word as well (for "Enable threshold
 * tuning"), still keeping an acronym ("Enable SLA policy").
 */
export function sentenceTitle(title: string, { midSentence = false }: { midSentence?: boolean } = {}): string {
  const fix = (part: string, first: boolean): string => {
    if (!part) return part;
    const known = ACRONYMS[part.toLowerCase()];
    if (known) return known;
    // A word already in capitals (two letters or more) is an acronym the map may not list.
    if (part.length > 1 && /^[A-Z0-9]+s?$/.test(part) && /[A-Z]/.test(part)) return part;
    const lower = part.toLowerCase();
    return first ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  };
  return title
    .trim()
    .split(/\s+/)
    .map((word, wi) =>
      word
        .split('-')
        .map((part, pi) => fix(part, !midSentence && wi === 0 && pi === 0))
        .join('-'),
    )
    .join(' ');
}

/**
 * Top-level SCALAR field names that have a dedicated curated editor and so must NOT
 * double-show in the synthetic `general` group (CURATED_SECTIONS only excludes whole
 * sections, not individual general-group scalars).
 */
const CURATED_FIELDS: ReadonlySet<string> = new Set(['background_scan_enabled']);

/** Field names that are NEVER generically editable (special-cased, managed elsewhere). */
const SPECIAL_CASE_KEYS: ReadonlySet<string> = new Set(['demo', 'read_only_settings_mode']);

/**
 * Section keys that are entirely READ-ONLY here (managed by a dedicated endpoint, not the
 * settings PUT path). `demo` is a nested-model SECTION whose sub-fields (`mode`/`seed`/…)
 * are managed ONLY via `/api/demo/*`, the settings PUT preserves the live demo block, so
 * editing them here would be silently discarded. It renders one explanatory note instead.
 */
const READ_ONLY_SECTIONS: ReadonlySet<string> = new Set(['demo']);

/**
 * Default-OFF engine features (Round-4 blocks) that get the DISCLOSURE TREATMENT: a
 * prominent head-of-section enable toggle, with the rest of the block's controls disclosed
 * only once enabled. (`RESEARCH_SETTINGS_IA §3.4`, two tiers only.)
 */
const ENGINE_FEATURE_KEYS: ReadonlySet<string> = new Set([
  'threshold_tuning',
  'batch',
  'baseline',
  'campaign',
  'event_detection',
]);

/** A scalar type this generic form can edit inline. */
function isEditableScalar(f: SettingsSchemaField): boolean {
  return (
    (f.type === 'boolean' ||
      f.type === 'integer' ||
      f.type === 'number' ||
      f.type === 'string' ||
      f.type === 'enum') &&
    !SPECIAL_CASE_KEYS.has(f.name)
  );
}

/** True when a field is a nested object / collection (described, not edited here). */
function isStructured(f: SettingsSchemaField): boolean {
  return f.type === 'object' || f.type === 'array' || f.type === 'union' || Boolean(f.element);
}

/* -------------------------------------------------------- generic controls -- */

/** One editable scalar as a Settings row: a switch, a select, a number or a text field. */
function ScalarRow({
  field,
  value,
  onChange,
}: {
  field: SettingsSchemaField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = schemaLabel(field.name);
  if (field.type === 'boolean') {
    return (
      <SettingRow
        variant="switch"
        label={label}
        help={field.description || undefined}
        checked={Boolean(value)}
        onCheckedChange={(v) => onChange(v)}
      />
    );
  }
  if (field.type === 'enum' && field.choices) {
    return (
      <SettingRow
        variant="select"
        label={label}
        help={field.description || undefined}
        value={value == null ? '' : String(value)}
        placeholder="Choose a value"
        options={field.choices.map((c) => ({ value: c, label: c }))}
        onValueChange={(v) => onChange(v)}
      />
    );
  }
  if (field.type === 'integer' || field.type === 'number') {
    return (
      <SettingRow variant="field" controlWidth="9rem">
        <NumPref
          label={label}
          help={field.description || undefined}
          value={typeof value === 'number' ? value : undefined}
          // The bounds the backend actually declares, so a generic control cannot offer
          // a value the settings PUT will reject with a 422. Omitted when the field
          // declares none, never invented here.
          min={field.minimum ?? undefined}
          max={field.maximum ?? undefined}
          step={field.type === 'integer' ? 1 : undefined}
          onChange={(v) => onChange(field.type === 'integer' ? Math.round(v) : v)}
        />
      </SettingRow>
    );
  }
  // Addresses and patterns (a repository URL, an index pattern) are long by nature: they
  // take the full row under their label instead of scrolling inside a 16rem field.
  const long = LONG_TEXT_FIELD.test(field.name);
  return (
    <SettingRow variant="field" wide={long} mono={long} controlWidth={long ? undefined : '16rem'}>
      <TextPref
        label={label}
        help={field.description || undefined}
        value={value == null ? '' : String(value)}
        onChange={(v) => onChange(v)}
      />
    </SettingRow>
  );
}

/** Text fields that hold an address, a path or a pattern (shown wide, in mono). */
const LONG_TEXT_FIELD = /(url|uri|repo|repository|endpoint|host|address|path|pattern|template)/i;

/** A read-only row for a structured (object or collection) field. */
function StructuredFieldRow({ field }: { field: SettingsSchemaField }) {
  const elem = field.element;
  return (
    <SettingRow
      variant="status"
      label={schemaLabel(field.name)}
      help={
        field.description
          ? field.description
          : elem
            ? `A ${elem.container} of ${schemaLabel(elem.model)} entries. Edit it in its own section.`
            : 'A structured setting. Edit it in its own section.'
      }
      status={<StatusDot>{elem ? `${elem.container} of ${schemaLabel(elem.model)}` : 'Structured'}</StatusDot>}
    />
  );
}

/** A knob managed elsewhere, shown locked. */
function ManagedRow({ name }: { name: string }) {
  return (
    <SettingRow
      variant="status"
      label={schemaLabel(name)}
      help={
        name === 'demo'
          ? 'Demo mode is managed in Organization, Experimental & Demo (and the /api/demo endpoints). A settings save can never change it.'
          : 'The settings lock is managed in Organization, Advanced, Settings lock. It cannot be turned on from this list.'
      }
      status={
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Managed elsewhere
        </span>
      }
    />
  );
}

/* --------------------------------------------------------------- section --- */

/**
 * Given a schema section, split its fields into editable scalars and structured notes
 * and render one group. Special-cased keys render a locked row.
 */
function SchemaSectionGroup({
  section,
  prefs,
  update,
}: {
  section: SettingsSchemaSection;
  prefs: Preferences;
  update: (p: Partial<Preferences>) => void;
}) {
  const prefsRec = prefs as unknown as Record<string, unknown>;
  const title = sentenceTitle(section.title || schemaLabel(section.key));

  // A whole read-only SECTION (e.g. `demo`) is managed by a dedicated endpoint: one
  // locked row, never editable controls (a settings PUT can't change it).
  if (READ_ONLY_SECTIONS.has(section.key)) {
    return (
      <SettingsGroup id={`schema-${section.key}`} title={title}>
        <ManagedRow name={section.key} />
      </SettingsGroup>
    );
  }

  // For a `group` (scalar top-level) section, each field IS a top-level pref key. For an
  // `object` (nested-model) section, the whole block is one top-level key; we edit its
  // sub-fields and PATCH the merged block back (deep-merge-safe: only that block changes).
  const isGroup = section.kind === 'group';
  const blockValue = isGroup ? undefined : (prefsRec[section.key] as Record<string, unknown> | undefined);

  // Plain closures (NOT hooks) so the read-only-section early return above can stay above
  // them without violating Rules-of-Hooks; they capture the current block value each render.
  const setTopLevel = (key: string, v: unknown) => update({ [key]: v } as Partial<Preferences>);
  const setNested = (fieldName: string, v: unknown) =>
    update({
      [section.key]: { ...(blockValue ?? {}), [fieldName]: v },
    } as Partial<Preferences>);

  // Disclosure tier: a default-OFF engine feature (object block with an `enabled` bool)
  // gets a head-of-group enable switch; the rest of its controls show only once on.
  const enabledField = !isGroup ? section.fields.find((f) => f.name === 'enabled' && f.type === 'boolean') : undefined;
  const isEngineFeature = !isGroup && ENGINE_FEATURE_KEYS.has(section.key) && Boolean(enabledField);
  const featureOn = isEngineFeature ? Boolean(blockValue?.enabled) : true;

  // The `enabled` field is rendered as the head switch, not as a body control.
  const bodyFields = isEngineFeature ? section.fields.filter((f) => f.name !== 'enabled') : section.fields;

  const editable = bodyFields.filter(isEditableScalar);
  const structured = bodyFields.filter((f) => !isEditableScalar(f) && isStructured(f));
  const special = bodyFields.filter((f) => SPECIAL_CASE_KEYS.has(f.name));

  // Nothing worth showing? Still render the notes so the operator sees the knob exists.
  // Engine features always render (the switch).
  const anything = editable.length + structured.length + special.length > 0;
  if (!anything && !isEngineFeature) return null;

  return (
    <SettingsGroup
      id={`schema-${section.key}`}
      title={title}
      caption={
        isEngineFeature
          ? 'Off by default. Turn it on to show its settings.'
          : isGroup
            ? 'Top-level preferences that have no section of their own yet.'
            : undefined
      }
    >
      {isEngineFeature ? (
        <SettingRow
          variant="switch"
          label={`Enable ${sentenceTitle(title, { midSentence: true })}`}
          checked={featureOn}
          onCheckedChange={(v) => setNested('enabled', v)}
        />
      ) : null}

      {!isEngineFeature || featureOn
        ? editable.map((f) => {
            const cur = isGroup ? prefsRec[f.name] : blockValue?.[f.name];
            const setter = isGroup
              ? (v: unknown) => setTopLevel(f.name, v)
              : (v: unknown) => setNested(f.name, v);
            return <ScalarRow key={f.name} field={f} value={cur} onChange={setter} />;
          })
        : null}

      {special.map((f) => (
        <ManagedRow key={f.name} name={f.name} />
      ))}

      {!isEngineFeature || featureOn
        ? structured.map((f) => <StructuredFieldRow key={f.name} field={f} />)
        : null}
    </SettingsGroup>
  );
}

/* ------------------------------------------------------------- the section - */

/**
 * The "All settings" section body. Fetches the schema once, renders a group per schema
 * section (curated blocks with their own home are hidden), and edits scalar knobs
 * through the shared `{prefs, update}` buffer. A search box filters to the matching fields.
 */
export function AdvancedSchemaSection({ prefs, update }: SecProps) {
  const [schema, setSchema] = React.useState<SettingsSchema | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getSettingsSchema();
      setSchema(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the settings schema.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Sections to show: drop curated-home blocks; keep the synthetic `general` group + the
  // long tail. Filter fields by the query (label / name / description).
  const term = q.trim().toLowerCase();
  const sections = React.useMemo(() => {
    if (!schema) return [];
    const matchField = (f: SettingsSchemaField) =>
      !term ||
      [f.name, schemaLabel(f.name), f.description ?? '', ...(f.choices ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(term);
    return schema.sections
      .filter((s) => !CURATED_SECTIONS.has(s.key))
      // Drop scalars that already have a curated editor (e.g. background_scan_enabled)
      // so a general-group knob isn't editable in two places.
      .map((s) => {
        let fields = s.fields.filter((f) => !CURATED_FIELDS.has(f.name) && matchField(f));
        // For a default-OFF engine feature, keep its `enabled` switch whenever the
        // section is shown (some OTHER field matched) even if the query didn't match
        // `enabled`. Otherwise the filtered-out switch made `isEngineFeature` flip false:
        // the block's gated fields rendered as editable and the head switch vanished
        // while searching.
        if (
          ENGINE_FEATURE_KEYS.has(s.key) &&
          fields.length > 0 &&
          !fields.some((f) => f.name === 'enabled')
        ) {
          const enabledField = s.fields.find((f) => f.name === 'enabled' && f.type === 'boolean');
          if (enabledField) fields = [enabledField, ...fields];
        }
        return { ...s, fields };
      })
      .filter((s) => s.fields.length > 0);
  }, [schema, term]);

  return (
    <SettingsSection title="All settings">
      <FilterBar aria-label="All settings filter">
        <div className="relative w-full sm:w-80">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter all settings"
            aria-label="Filter all settings"
            className="h-9 pl-8"
          />
        </div>
      </FilterBar>

      {loading ? (
        <LoadingState
          label="Loading settings schema"
          description="Reading the editable preference contract from the backend."
          layout="panel"
          shape="panel"
        />
      ) : error ? (
        <LoadError
          error={error}
          title="Could not load the settings schema"
          onRetry={() => void load()}
        />
      ) : sections.length === 0 ? (
        <EmptyState
          icon={Info}
          compact
          title={term ? 'No matching settings' : 'No additional settings'}
          description={
            term
              ? `No settings match “${q}”.`
              : 'Every engine preference already has a section of its own.'
          }
        />
      ) : (
        sections.map((s) => <SchemaSectionGroup key={s.key} section={s} prefs={prefs} update={update} />)
      )}
    </SettingsSection>
  );
}

export default AdvancedSchemaSection;
