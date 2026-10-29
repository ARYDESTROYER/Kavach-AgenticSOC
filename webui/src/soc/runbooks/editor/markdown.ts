/**
 * The runbook Markdown form in the browser (Round 14, SPEC §4.10.13): `exportRunbookMarkdown`
 * writes a definition exactly as the server's export does, and `parseRunbookMarkdown` reads
 * the native form back into a definition, so the editor's Source view and its outline are
 * one runbook ("Chips and front matter are the same fields; edit either").
 *
 * A faithful port of `parse_runbook_markdown`, `export_runbook_markdown` and
 * `normalise_definition` in `backend/app/engine/runbook_model.py`. The server stays the
 * authority: every save from the Source view sends the Markdown itself (the server
 * parses it), and live validation always asks `POST /api/runbooks/validate`. This parser
 * only lets the outline follow an edit before it is saved; a parity test reads the twelve
 * bundled runbooks and their server parses.
 *
 * Dependency-free on purpose: the format is a strict subset (front matter of scalars,
 * flow lists, block lists and one level of nested mapping; `##` phase headings; `###`
 * step headings with an attribute list; key lines; one fenced lookup block). Pure, no DOM.
 */
import type {
  AppliesWhen,
  DecisionOption,
  LookupTemplate,
  PhaseId,
  RunbookDefinition,
  RunbookEntityType,
  RunbookIssue,
  RunbookStep,
  RunbookVerdict,
  StepKind,
} from '@/lib/types-runbooks';
import type { SeverityLevel } from '@/lib/types-rules';

import {
  DEFAULT_LOOKUP_WINDOW,
  ENTITY_TYPES,
  LOOKUP_TOOLS,
  PHASE_LABEL,
  PHASE_ORDER,
  RUNBOOK_LIMITS,
  SEVERITY_LEVELS,
  STEP_KINDS,
  VERDICTS,
} from '../shared/labels';

// --------------------------------------------------------------------------- //
// Defaults and normalisation (the server's `normalise_definition`)
// --------------------------------------------------------------------------- //

export function emptyAppliesWhen(): AppliesWhen {
  return {
    rule_ids: [],
    mitre: [],
    entity_types: [],
    severity_at_least: null,
    sources: [],
    verdicts: [],
    statuses: [],
    any_tags: [],
    min_event_count: null,
    always: false,
  };
}

export function defaultLookup(tool: LookupTemplate['tool'] = 'log_stats'): LookupTemplate {
  return { tool, filter: {}, group_by: [], indicator: null, window: DEFAULT_LOOKUP_WINDOW, limit: 20, run: 'on_attach' };
}

export function blankStep(id: string, phase: PhaseId, kind: StepKind, title = ''): RunbookStep {
  return {
    id,
    phase,
    kind,
    title,
    instructions: '',
    focus: null,
    escalate_if: null,
    benign_if: null,
    required: true,
    evidence: 'none',
    owner_role: null,
    approval_role: null,
    target_minutes: null,
    lookup: kind === 'lookup' ? defaultLookup() : null,
    options: [],
    react: null,
    d3fend: null,
  };
}

const cleanLine = (value: unknown): string => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim());
const cleanOptional = (value: unknown): string | null => cleanLine(value) || null;
const cleanList = (values: readonly unknown[] | null | undefined, upper = false): string[] => {
  const out: string[] = [];
  for (const item of values ?? []) {
    const text = cleanLine(item);
    if (text) out.push(upper ? text.toUpperCase() : text);
  }
  return out;
};

/** Multi-line text: newlines normalised, leading and trailing blank lines dropped, trailing space trimmed. */
export function cleanBlock(value: unknown): string {
  if (typeof value !== 'string') return '';
  const lines = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n').trimEnd();
}

/**
 * The canonical form of a definition: one-line fields trimmed, empty optionals `null`,
 * empty list items dropped, technique ids upper case, instructions without leading and
 * trailing blank lines. Order and meaning are unchanged; applying it twice changes nothing.
 */
export function normaliseDefinition(defn: RunbookDefinition): RunbookDefinition {
  const aw = defn.applies_when;
  return {
    ...defn,
    id: cleanLine(defn.id),
    title: cleanLine(defn.title),
    summary: cleanLine(defn.summary),
    use_when: cleanBlock(defn.use_when).trim(),
    prerequisites: cleanBlock(defn.prerequisites).trim(),
    applies_when: {
      ...aw,
      rule_ids: cleanList(aw.rule_ids),
      mitre: cleanList(aw.mitre, true),
      entity_types: [...aw.entity_types],
      sources: cleanList(aw.sources),
      verdicts: [...aw.verdicts],
      statuses: cleanList(aw.statuses),
      any_tags: cleanList(aw.any_tags),
    },
    mitre: cleanList(defn.mitre, true),
    phases: [...defn.phases],
    steps: defn.steps.map((step) => ({
      ...step,
      id: cleanLine(step.id),
      title: cleanLine(step.title),
      instructions: cleanBlock(step.instructions),
      focus: cleanOptional(step.focus),
      escalate_if: cleanOptional(step.escalate_if),
      benign_if: cleanOptional(step.benign_if),
      owner_role: cleanOptional(step.owner_role),
      approval_role: cleanOptional(step.approval_role),
      lookup: step.lookup
        ? {
            ...step.lookup,
            filter: Object.fromEntries(Object.entries(step.lookup.filter ?? {}).map(([k, v]) => [cleanLine(k), cleanLine(v)])),
            group_by: cleanList(step.lookup.group_by),
            indicator: cleanOptional(step.lookup.indicator),
            window: cleanLine(step.lookup.window) || DEFAULT_LOOKUP_WINDOW,
          }
        : null,
      options: step.options.map((o) => ({
        ...o,
        id: cleanLine(o.id),
        label: cleanLine(o.label),
        marks_not_applicable: cleanList(o.marks_not_applicable),
      })),
      react: cleanOptional(step.react),
      d3fend: cleanOptional(step.d3fend),
    })),
    retrieval_queries: cleanList(defn.retrieval_queries),
    owner: cleanOptional(defn.owner),
    references: cleanList(defn.references),
  };
}

// --------------------------------------------------------------------------- //
// Export (the server's `export_runbook_markdown`)
// --------------------------------------------------------------------------- //

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PLAIN_UNSAFE_START = '[]{}"\'&*!|>%@`#,?:-';
const YAML_SPECIAL_WORDS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~', '']);
const NUMBER_LIKE_RE = /^[-+]?(?:\d[\d_]*)(?:\.\d*)?(?:[eE][-+]?\d+)?$/;

function needsQuotes(value: string, inFlow = false): boolean {
  if (value !== value.trim() || !value) return true;
  if (YAML_SPECIAL_WORDS.has(value.toLowerCase()) || NUMBER_LIKE_RE.test(value)) return true;
  if (PLAIN_UNSAFE_START.includes(value[0]) && !value.startsWith('{{')) return true;
  if (value.startsWith('{{')) return true;
  if (value.includes(': ') || value.includes(' #') || value.endsWith(':')) return true;
  if (inFlow && /[,[\]{}"']/.test(value)) return true;
  return /[\n\r\t]/.test(value);
}

const yamlScalar = (value: string, inFlow = false): string => (needsQuotes(value, inFlow) ? JSON.stringify(value) : value);
const yamlFlow = (values: readonly string[]): string => `[${values.map((v) => yamlScalar(v, true)).join(', ')}]`;
const yamlKey = (key: string): string => (KEY_RE.test(key) && !needsQuotes(key) ? key : JSON.stringify(key));
const attrValue = (value: string): string => (!value || /[\s"{}=\\]/.test(value) ? JSON.stringify(value) : value);
const formatTarget = (minutes: number): string => (minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`);

function exportLookup(lookup: LookupTemplate): string[] {
  const out = ['```lookup', `tool: ${lookup.tool}`];
  const entries = Object.entries(lookup.filter ?? {});
  if (entries.length) {
    out.push('filter:');
    for (const [key, value] of entries) out.push(`  ${yamlKey(key)}: ${yamlScalar(value)}`);
  }
  if (lookup.group_by.length) out.push(`group_by: ${yamlFlow(lookup.group_by)}`);
  if (lookup.indicator) out.push(`indicator: ${yamlScalar(lookup.indicator)}`);
  out.push(`window: ${yamlScalar(lookup.window)}`);
  out.push(`limit: ${lookup.limit}`);
  out.push(`run: ${lookup.run}`);
  out.push('```');
  return out;
}

function exportStep(step: RunbookStep): string[] {
  const attrs = [`#${step.id}`, `kind=${step.kind}`];
  if (!step.required) attrs.push('optional');
  if (step.owner_role) attrs.push(`owner=${attrValue(step.owner_role)}`);
  if (step.approval_role) attrs.push(`approval=${attrValue(step.approval_role)}`);
  if (step.evidence !== 'none') attrs.push(`evidence=${step.evidence}`);
  if (step.target_minutes) attrs.push(`target=${formatTarget(step.target_minutes)}`);
  if (step.react) attrs.push(`react=${attrValue(step.react)}`);
  if (step.d3fend) attrs.push(`d3fend=${attrValue(step.d3fend)}`);
  const out = [`### ${step.title} {${attrs.join(' ')}}`];
  if (step.focus) out.push(`Focus: ${step.focus}`);
  if (step.escalate_if) out.push(`Escalate if: ${step.escalate_if}`);
  if (step.benign_if) out.push(`Benign if: ${step.benign_if}`);
  if (step.options.length) {
    out.push('Options:');
    for (const option of step.options) {
      let line = `- ${option.id}: ${option.label}`;
      if (option.marks_not_applicable.length) line += ` | skips: ${option.marks_not_applicable.join(', ')}`;
      out.push(line);
    }
  }
  if (step.lookup) {
    out.push('');
    out.push(...exportLookup(step.lookup));
  }
  if (step.instructions) {
    out.push('');
    out.push(step.instructions);
  }
  return out;
}

/**
 * The native Markdown of a definition, written from its normalised form. `version` goes
 * into the front matter when given (export writes the version it exported).
 */
export function exportRunbookMarkdown(input: RunbookDefinition, version?: number | null): string {
  const defn = normaliseDefinition(input);
  const fm = ['---', `id: ${yamlScalar(defn.id)}`, `title: ${yamlScalar(defn.title)}`, `summary: ${yamlScalar(defn.summary)}`];
  if (defn.use_when) fm.push(`use_when: ${yamlScalar(defn.use_when)}`);
  if (defn.prerequisites) fm.push(`prerequisites: ${yamlScalar(defn.prerequisites)}`);
  if (version != null) fm.push(`version: ${version}`);
  fm.push(`priority: ${defn.priority}`);
  if (defn.owner) fm.push(`owner: ${yamlScalar(defn.owner)}`);
  fm.push(`review_every_days: ${defn.review_every_days}`);
  if (defn.mitre.length) fm.push(`mitre: ${yamlFlow(defn.mitre)}`);
  const aw = defn.applies_when;
  const awLines: string[] = [];
  for (const key of ['rule_ids', 'mitre', 'entity_types'] as const) {
    const values = aw[key] as string[];
    if (values.length) awLines.push(`  ${key}: ${yamlFlow(values)}`);
  }
  if (aw.severity_at_least) awLines.push(`  severity_at_least: ${aw.severity_at_least}`);
  for (const key of ['sources', 'verdicts', 'statuses', 'any_tags'] as const) {
    const values = aw[key] as string[];
    if (values.length) awLines.push(`  ${key}: ${yamlFlow(values)}`);
  }
  if (aw.min_event_count != null) awLines.push(`  min_event_count: ${aw.min_event_count}`);
  if (aw.always) awLines.push('  always: true');
  if (awLines.length) {
    fm.push('applies_when:');
    fm.push(...awLines);
  }
  if (defn.retrieval_queries.length) {
    fm.push('retrieval_queries:');
    fm.push(...defn.retrieval_queries.map((q) => `  - ${yamlScalar(q)}`));
  }
  if (defn.references.length) {
    fm.push('references:');
    fm.push(...defn.references.map((r) => `  - ${yamlScalar(r)}`));
  }
  fm.push('---');
  const body: string[] = [];
  const order = Array.from(new Set<PhaseId>([...defn.phases, ...defn.steps.map((s) => s.phase)]));
  for (const phase of order) {
    body.push('', `## ${PHASE_LABEL[phase] ?? phase}`);
    for (const step of defn.steps.filter((s) => s.phase === phase)) {
      body.push('');
      body.push(...exportStep(step));
    }
  }
  return `${[...fm, ...body].join('\n').replace(/\n+$/, '')}\n`;
}

// --------------------------------------------------------------------------- //
// Parse (the server's `parse_runbook_markdown`)
// --------------------------------------------------------------------------- //

const ISSUE_PARSE = 'parse';
const ISSUE_UNKNOWN_KEY = 'unknown_key';
const ISSUE_SOURCE_SIZE = 'source_too_large';
const MAX_ISSUES = 200;

class YamlError extends Error {
  constructor(
    public readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

// eslint-disable-next-line no-control-regex -- the invisible characters the server's `_shown` drops
const UNSAFE_SHOWN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

function shown(text: unknown, limit = 60): string {
  const flat = String(text ?? '').replace(UNSAFE_SHOWN, '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3).trimEnd()}...`;
}

type YamlValue = string | string[] | YamlMap | null;
interface YamlMap {
  [key: string]: YamlValue;
}

function scalar(raw: string, line: number): string {
  const text = raw.trim();
  if (text.startsWith('"')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new YamlError(line, 'A quoted value is not closed or has an unknown escape.');
    }
    if (typeof value !== 'string') throw new YamlError(line, 'A quoted value is not text.');
    return value;
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) throw new YamlError(line, 'A quoted value is not closed.');
    const inner = text.slice(1, -1);
    if (inner.replace(/''/g, '').includes("'")) {
      throw new YamlError(line, "A single-quoted value has an unescaped quote; write '' for a quote.");
    }
    return inner.replace(/''/g, "'");
  }
  if (text.startsWith('{') && !text.startsWith('{{')) {
    throw new YamlError(line, 'Inline mappings are not supported; write one key per line.');
  }
  return text;
}

function splitFlow(inner: string, line: number): string[] {
  const items: string[] = [];
  let buf = '';
  let hasText = false;
  let quote: string | null = null;
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (quote) {
      buf += ch;
      if (quote === '"' && ch === '\\' && i + 1 < inner.length) {
        buf += inner[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && i + 1 < inner.length && inner[i + 1] === "'") {
          buf += "'";
          i += 2;
          continue;
        }
        quote = null;
      }
    } else if ((ch === '"' || ch === "'") && !hasText) {
      quote = ch;
      hasText = true;
      buf += ch;
    } else if (ch === ',') {
      items.push(buf);
      buf = '';
      hasText = false;
    } else if (ch === '[' || ch === ']') {
      throw new YamlError(line, 'Lists inside lists are not supported.');
    } else {
      buf += ch;
      if (!/\s/.test(ch)) hasText = true;
    }
    i += 1;
  }
  if (quote) throw new YamlError(line, 'A quoted list item is not closed.');
  items.push(buf);
  if (items.length === 1 && !items[0].trim()) return [];
  return items.map((item) => {
    if (!item.trim()) throw new YamlError(line, 'A list has an empty item.');
    return scalar(item, line);
  });
}

function value(raw: string, line: number): string | string[] {
  const text = raw.trim();
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new YamlError(line, "A list that opens with '[' must close with ']' on the same line.");
    return splitFlow(text.slice(1, -1), line);
  }
  return scalar(text, line);
}

function keyOf(raw: string, line: number): string {
  const text = raw.trim();
  if (text.startsWith('"') || text.startsWith("'")) return scalar(text, line);
  return text;
}

function partition(text: string, sep: string): [string, string, string] {
  const at = text.indexOf(sep);
  return at < 0 ? [text, '', ''] : [text.slice(0, at), sep, text.slice(at + sep.length)];
}

function splitKey(text: string): [string, string, string] {
  const stripped = text.trimStart();
  if (stripped[0] === '"' || stripped[0] === "'") {
    const quote = stripped[0];
    let end = stripped.indexOf(quote, 1);
    while (quote === '"' && end > 0 && stripped[end - 1] === '\\') end = stripped.indexOf(quote, end + 1);
    if (end > 0) {
      const [head, sep, rest] = partition(stripped.slice(end + 1), ':');
      if (!head.trim()) return [stripped.slice(0, end + 1), sep, rest];
    }
  }
  return partition(text, ':');
}

const indentOf = (line: string): number => line.length - line.replace(/^ +/, '').length;
const leadingWhitespace = (line: string): string => line.slice(0, line.length - line.trimStart().length);

function parseBlock(lines: string[], start: number, nested: boolean): YamlMap {
  const data: YamlMap = {};
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const number = start + i;
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i += 1;
      continue;
    }
    if (leadingWhitespace(line).includes('\t')) throw new YamlError(number, 'Indent with spaces, not tabs.');
    if (indentOf(line) > 0) throw new YamlError(number, 'This line is indented but has no key above it.');
    const [rawKey, sep, rest] = splitKey(line);
    const key = keyOf(rawKey, number);
    if (!sep || !key) throw new YamlError(number, "Each line must be 'key: value'.");
    if (!nested && !KEY_RE.test(key)) throw new YamlError(number, `'${shown(key, 40)}' is not a valid key.`);
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      throw new YamlError(number, `The key '${shown(key, 40)}' is listed twice.`);
    }
    if (rest.trim()) {
      data[key] = value(rest, number);
      i += 1;
      continue;
    }
    let j = i + 1;
    const block: string[] = [];
    while (j < n && (!lines[j].trim() || indentOf(lines[j]) > 0 || lines[j].startsWith('\t'))) {
      block.push(lines[j]);
      j += 1;
    }
    const content = block
      .map((b, k) => [k, b] as const)
      .filter(([, b]) => b.trim() && !b.trimStart().startsWith('#'));
    if (!content.length) {
      data[key] = null;
    } else if (content.every(([, b]) => b.trimStart().startsWith('- ') || b.trim() === '-')) {
      const items: string[] = [];
      for (const [k, b] of content) {
        const item = b.trim().slice(1).trim();
        if (!item) throw new YamlError(number + 1 + k, 'A list has an empty item.');
        const v = value(item, number + 1 + k);
        if (Array.isArray(v)) throw new YamlError(number + 1 + k, 'Lists inside lists are not supported.');
        items.push(v);
      }
      data[key] = items;
    } else {
      if (nested) throw new YamlError(number + 1 + content[0][0], 'Only one level of nesting is supported.');
      const base = indentOf(content[0][1]);
      const dedented: string[] = [];
      block.forEach((b, k) => {
        if (b.trim() && indentOf(b) < base) {
          throw new YamlError(number + 1 + k, 'The indentation of this line does not match the lines above.');
        }
        dedented.push(b.trim() ? b.slice(base) : '');
      });
      data[key] = parseBlock(dedented, number + 1, true);
    }
    i = j;
  }
  return data;
}

const parseYaml = (text: string, start = 1): YamlMap => parseBlock(text.split('\n'), start, false);

function splitFrontMatter(text: string): [string | null, string, number] {
  const normalized = text.replace(/^\ufeff+/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (!lines.length || lines[0].trimEnd() !== '---') return [null, normalized, 1];
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trimEnd() === '---') {
      return [lines.slice(1, index).join('\n'), lines.slice(index + 1).join('\n'), index + 2];
    }
  }
  return [null, normalized, 1];
}

class Collector {
  issues: RunbookIssue[] = [];
  fatal = false;
  more = false;
  add(path: string, code: string, message: string, fatal = false) {
    this.fatal = this.fatal || fatal;
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path, code, message });
    else this.more = true;
  }
  result(): RunbookIssue[] {
    return this.more
      ? [...this.issues, { path: '', code: 'more_issues', message: 'There are more problems; fix these first.' }]
      : [...this.issues];
  }
}

const isMap = (v: YamlValue): v is YamlMap => !!v && typeof v === 'object' && !Array.isArray(v);

function asList(v: YamlValue | undefined, path: string, what: string, sink: Collector): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map(String);
  if (isMap(v)) {
    sink.add(path, ISSUE_PARSE, `${what || path} must be a list such as [a, b], not a block of keys.`, true);
    return [];
  }
  return v.trim() ? [v] : [];
}

function asInt(v: YamlValue | undefined, path: string, what: string, sink: Collector): number | null {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return null;
  if (typeof v !== 'string') {
    sink.add(path, ISSUE_PARSE, `${what} must be a whole number.`, true);
    return null;
  }
  const text = v.trim();
  if (!/^[-+]?\d{1,9}$/.test(text)) {
    sink.add(path, ISSUE_PARSE, `${what} must be a whole number, not '${shown(text, 20)}'.`, true);
    return null;
  }
  return Number.parseInt(text, 10);
}

function versionFrom(v: YamlValue | undefined, sink: Collector): number | null {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return null;
  const text = typeof v === 'string' ? v.trim() : '';
  if (/^\+?\d{1,9}$/.test(text) && Number.parseInt(text, 10) >= 1) return Number.parseInt(text, 10);
  sink.add('version', ISSUE_PARSE, 'version is not a whole number of 1 or more, so it is ignored.');
  return null;
}

function asBool(v: YamlValue | undefined, path: string, what: string, sink: Collector): boolean {
  const text = typeof v === 'string' ? v.trim().toLowerCase() : v;
  if (text === 'true') return true;
  if (text === 'false' || text === null || text === undefined || text === '') return false;
  sink.add(path, ISSUE_PARSE, `${what} must be true or false.`, true);
  return false;
}

function asText(v: YamlValue | undefined, path: string, what: string, sink: Collector): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') {
    sink.add(path, ISSUE_PARSE, `${what} must be text, not a list.`, true);
    return '';
  }
  return v;
}

function closed<T extends string>(values: string[], allowed: readonly T[], path: string, what: string, sink: Collector): T[] {
  const out: T[] = [];
  for (const v of values) {
    if ((allowed as readonly string[]).includes(v)) out.push(v as T);
    else sink.add(path, ISSUE_PARSE, `${what} '${shown(v, 30)}' is not one of ${allowed.join(', ')}.`, true);
  }
  return out;
}

const FRONT_MATTER_KEYS = [
  'id', 'title', 'summary', 'use_when', 'prerequisites', 'version', 'priority', 'owner',
  'review_every_days', 'mitre', 'applies_when', 'retrieval_queries', 'references',
];
const APPLIES_WHEN_KEYS = [
  'rule_ids', 'mitre', 'entity_types', 'severity_at_least', 'sources', 'verdicts', 'statuses',
  'any_tags', 'min_event_count', 'always',
];
const LOOKUP_KEYS = ['tool', 'filter', 'group_by', 'indicator', 'window', 'limit', 'run'];
const STEP_ATTRIBUTES = ['kind', 'optional', 'owner', 'approval', 'evidence', 'target', 'react', 'd3fend'];
const STEP_KEY_LINES = ['Focus', 'Escalate if', 'Benign if', 'Options'] as const;
const PHASE_BY_LABEL: Readonly<Record<string, PhaseId>> = (() => {
  const map: Record<string, PhaseId> = {};
  for (const p of PHASE_ORDER) {
    map[p] = p;
    map[PHASE_LABEL[p].toLowerCase()] = p;
  }
  map.close = 'close';
  return map;
})();

function appliesWhenFrom(raw: YamlValue | undefined, sink: Collector): Partial<AppliesWhen> {
  if (raw === null || raw === undefined) return {};
  if (!isMap(raw)) {
    sink.add('applies_when', ISSUE_PARSE, "applies_when must be a block of 'key: value' lines.", true);
    return {};
  }
  const out: Partial<AppliesWhen> = {};
  for (const [key, v] of Object.entries(raw)) {
    const path = `applies_when.${key}`;
    if (!APPLIES_WHEN_KEYS.includes(key)) {
      sink.add(path, ISSUE_UNKNOWN_KEY, `applies_when has the unknown key '${shown(key, 40)}'. Known keys: ${APPLIES_WHEN_KEYS.join(', ')}.`);
      continue;
    }
    if (key === 'entity_types') {
      out.entity_types = closed<RunbookEntityType>(asList(v, path, key, sink), ENTITY_TYPES, path, 'The entity type', sink);
    } else if (key === 'verdicts') {
      out.verdicts = closed<RunbookVerdict>(asList(v, path, key, sink), VERDICTS, path, 'The verdict', sink);
    } else if (key === 'severity_at_least') {
      const text = asText(v, path, 'severity_at_least', sink).trim();
      if (text) out.severity_at_least = closed<SeverityLevel>([text], SEVERITY_LEVELS, path, 'The severity', sink)[0] ?? null;
    } else if (key === 'min_event_count') {
      const number = asInt(v, path, 'min_event_count', sink);
      if (number !== null) {
        if (number < 1 || number > 1_000_000) sink.add(path, ISSUE_PARSE, 'min_event_count must be between 1 and 1,000,000.', true);
        else out.min_event_count = number;
      }
    } else if (key === 'always') {
      out.always = asBool(v, path, 'always', sink);
    } else {
      (out as Record<string, unknown>)[key] = asList(v, path, key, sink);
    }
  }
  return out;
}

function lookupFrom(text: string, path: string, owner: string, start: number, sink: Collector): LookupTemplate | null {
  let raw: YamlMap;
  try {
    raw = parseYaml(text, start);
  } catch (err) {
    const e = err as YamlError;
    sink.add(path, ISSUE_PARSE, `${owner} lookup, line ${e.line}: ${e.message}`, true);
    return null;
  }
  const data: Omit<Partial<LookupTemplate>, 'tool'> & { tool?: string } = {};
  for (const [key, v] of Object.entries(raw)) {
    const kpath = `${path}.${key}`;
    if (!LOOKUP_KEYS.includes(key)) {
      sink.add(kpath, ISSUE_UNKNOWN_KEY, `${owner} lookup has the unknown key '${shown(key, 40)}'. Known keys: ${LOOKUP_KEYS.join(', ')}.`);
      continue;
    }
    if (key === 'tool') {
      const tool = asText(v, kpath, `${owner} lookup tool`, sink).trim();
      if (!(LOOKUP_TOOLS as readonly string[]).includes(tool)) {
        sink.add(kpath, ISSUE_PARSE, `${owner} lookup tool '${shown(tool, 30)}' is not one of ${LOOKUP_TOOLS.join(', ')}.`, true);
      }
      data.tool = tool;
    } else if (key === 'filter') {
      if (v === null) data.filter = {};
      else if (!isMap(v)) sink.add(kpath, ISSUE_PARSE, `${owner} lookup filter must be a block of 'field: value' lines.`, true);
      else {
        const flt: Record<string, string> = {};
        for (const [fkey, fvalue] of Object.entries(v)) {
          if (Array.isArray(fvalue) || isMap(fvalue)) {
            sink.add(`${kpath}.${fkey}`, ISSUE_PARSE, `${owner} lookup filter on ${shown(fkey, 40)} must be one value.`, true);
            continue;
          }
          flt[fkey] = fvalue == null ? '' : String(fvalue);
        }
        data.filter = flt;
      }
    } else if (key === 'group_by') {
      data.group_by = asList(v, kpath, `${owner} lookup group_by`, sink);
    } else if (key === 'indicator' || key === 'window' || key === 'run') {
      const textValue = asText(v, kpath, `${owner} lookup ${key}`, sink).trim();
      if (key === 'run' && textValue !== 'on_attach' && textValue !== 'on_demand') {
        sink.add(kpath, ISSUE_PARSE, `${owner} lookup run must be on_attach or on_demand.`, true);
      }
      if (textValue || key !== 'indicator') (data as Record<string, unknown>)[key] = textValue;
    } else if (key === 'limit') {
      const number = asInt(v, kpath, `${owner} lookup limit`, sink);
      if (number !== null) {
        if (number < 1 || number > RUNBOOK_LIMITS.limitMax) sink.add(kpath, ISSUE_PARSE, `${owner} lookup limit must be between 1 and 50.`, true);
        else data.limit = number;
      }
    }
  }
  if (data.tool === undefined) {
    sink.add(`${path}.tool`, ISSUE_PARSE, `${owner} lookup needs a tool.`, true);
    return null;
  }
  if (sink.fatal) return null;
  return { ...defaultLookup(data.tool as LookupTemplate['tool']), ...data } as LookupTemplate;
}

function splitHeading(heading: string): [string, string | null] {
  const text = heading.trimEnd();
  if (!text.endsWith('}')) return [text.trim(), null];
  const start = text.lastIndexOf('{');
  if (start < 0 || text.slice(start + 1, -1).includes('}')) return [text.trim(), null];
  return [text.slice(0, start).trim(), text.slice(start + 1, -1)];
}

function keyLine(line: string): [(typeof STEP_KEY_LINES)[number], string] | null {
  const text = line.replace(/^[ \t]+/, '');
  for (const key of STEP_KEY_LINES) {
    if (text.slice(0, key.length + 1).toLowerCase() === `${key.toLowerCase()}:`) {
      const rest = text.slice(key.length + 1);
      if (rest && rest[0] !== ' ' && rest[0] !== '\t') return null;
      return [key, rest.trim()];
    }
  }
  return null;
}

/** The key line the first non-blank line of `text` would be read as, or `null`. */
export function leadingKeyLine(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.trim()) {
      const found = keyLine(line);
      return found ? found[0] : null;
    }
  }
  return null;
}

function optionLine(line: string): DecisionOption | null {
  const body = line.slice(2).trimStart();
  const [optionId, sep, restRaw] = partition(body, ':');
  if (!sep || !optionId || /\s/.test(optionId)) return null;
  let rest = restRaw;
  let skips: string[] = [];
  const m = /\|[ \t]*skips:/.exec(rest);
  if (m) {
    skips = rest
      .slice(m.index + m[0].length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    rest = rest.slice(0, m.index);
  }
  return { id: optionId, label: rest.trim(), marks_not_applicable: skips };
}

function attributes(raw: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  let quote = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && i + 1 < raw.length) {
        buf += raw[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') quote = false;
    } else if (ch === '"') {
      quote = true;
      buf += ch;
    } else if (/\s/.test(ch)) {
      if (buf) {
        tokens.push(buf);
        buf = '';
      }
    } else {
      buf += ch;
    }
    i += 1;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function parseStep(
  heading: string,
  body: string[],
  phase: PhaseId,
  index: number,
  start: number,
  sink: Collector,
): RunbookStep {
  const path = `steps[${index}]`;
  const [title, rawAttrs] = splitHeading(heading);
  const attrs = rawAttrs !== null ? attributes(rawAttrs) : [];
  const owner = title ? `Step '${shown(title)}'` : `Step ${index + 1}`;
  const step = blankStep('', phase, 'check', title) as RunbookStep & { kind?: StepKind };
  let hasId = false;
  let hasKind = false;
  for (const token of attrs) {
    if (token.startsWith('#')) {
      if (hasId) sink.add(`${path}.id`, ISSUE_PARSE, `${owner} has two ids.`, true);
      step.id = token.slice(1);
      hasId = true;
      continue;
    }
    if (token === 'optional') {
      step.required = false;
      continue;
    }
    let [key, sep, val] = partition(token, '=');
    if (sep && val.startsWith('"')) {
      try {
        val = JSON.parse(val) as string;
      } catch {
        sink.add(`${path}.${key}`, ISSUE_PARSE, `${owner} has a quoted ${key} that is not closed.`, true);
        continue;
      }
    }
    if (!sep || !STEP_ATTRIBUTES.includes(key) || key === 'optional') {
      sink.add(
        `${path}.attributes`,
        ISSUE_UNKNOWN_KEY,
        `${owner} has the unknown attribute '${shown(token, 30)}'. Known attributes: #id, kind=, optional, owner=, approval=, evidence=, target=, react=, d3fend=.`,
      );
      continue;
    }
    if (key === 'kind') {
      if (!(STEP_KINDS as readonly string[]).includes(val)) {
        sink.add(`${path}.kind`, ISSUE_PARSE, `${owner} kind '${shown(val, 20)}' is not one of ${STEP_KINDS.join(', ')}.`, true);
      }
      step.kind = val as StepKind;
      hasKind = true;
    } else if (key === 'owner') step.owner_role = val;
    else if (key === 'approval') step.approval_role = val;
    else if (key === 'evidence') {
      if (val !== 'none' && val !== 'note' && val !== 'note_or_attachment') {
        sink.add(`${path}.evidence`, ISSUE_PARSE, `${owner} evidence must be note or note_or_attachment.`, true);
      }
      step.evidence = val as RunbookStep['evidence'];
    } else if (key === 'target') {
      const tm = /^(\d{1,5})(m|h)$/.exec(val);
      const minutes = tm ? Number.parseInt(tm[1], 10) * (tm[2] === 'h' ? 60 : 1) : 0;
      if (!tm || minutes < 1 || minutes > 10_080) {
        sink.add(`${path}.target`, ISSUE_PARSE, `${owner} target must be minutes or hours such as 30m or 4h, at most 168h.`, true);
      } else step.target_minutes = minutes;
    } else if (key === 'react') step.react = val;
    else if (key === 'd3fend') step.d3fend = val;
  }
  if (rawAttrs === null) {
    sink.add(`${path}.id`, ISSUE_PARSE, `${owner} needs an id and a kind: end its heading with {#an-id kind=check}.`, true);
  } else if (!hasId || !step.id.trim()) {
    sink.add(`${path}.id`, ISSUE_PARSE, `${owner} needs an id: add #an-id inside the braces.`, true);
  } else if (!hasKind) {
    sink.add(`${path}.kind`, ISSUE_PARSE, `${owner} needs a kind: add kind=check (or lookup, decision, action, record) inside the braces.`, true);
  }
  step.lookup = null;

  let i = 0;
  const nBody = body.length;
  const seen = new Set<string>();
  for (;;) {
    let k = i;
    while (k < nBody && !body[k].trim()) k += 1;
    const km = k < nBody ? keyLine(body[k]) : null;
    if (!km) break;
    i = k;
    const [name, val] = km;
    if (seen.has(name)) sink.add(path, ISSUE_PARSE, `${owner} has the line '${name}:' twice.`, true);
    seen.add(name);
    if (name === 'Options') {
      if (val) sink.add(`${path}.options`, ISSUE_PARSE, `${owner} lists options on the lines after 'Options:', one per line.`, true);
      const options: DecisionOption[] = [];
      i += 1;
      let kk = i;
      while (kk < nBody && !body[kk].trim()) kk += 1;
      if (kk < nBody && body[kk].replace(/^[ \t]+/, '').startsWith('- ')) i = kk;
      while (i < nBody && body[i].replace(/^[ \t]+/, '').startsWith('- ')) {
        const option = optionLine(body[i].replace(/^[ \t]+/, ''));
        if (!option) {
          sink.add(`${path}.options`, ISSUE_PARSE, `${owner} option line ${start + i} must be '- id: label' with an optional '| skips: step-id, step-id'.`, true);
        } else options.push(option);
        i += 1;
      }
      step.options = options;
      continue;
    }
    const field = name === 'Focus' ? 'focus' : name === 'Escalate if' ? 'escalate_if' : 'benign_if';
    if (val) step[field] = val;
    i += 1;
  }

  const rest = body.slice(i);
  const instructions: string[] = [];
  let lookupText: string[] | null = null;
  let lookupStart = 0;
  let j = 0;
  while (j < rest.length) {
    const line = rest[j];
    const trimmed = line.trim();
    if (trimmed === '```lookup' || trimmed === '~~~lookup') {
      const fence = trimmed.slice(0, 3);
      if (lookupText !== null) sink.add(`${path}.lookup`, ISSUE_PARSE, `${owner} has two lookup blocks.`, true);
      const block: string[] = [];
      let k = j + 1;
      while (k < rest.length && rest[k].trim() !== fence) {
        block.push(rest[k]);
        k += 1;
      }
      if (k >= rest.length) sink.add(`${path}.lookup`, ISSUE_PARSE, `${owner} lookup block is not closed with ${fence}.`, true);
      lookupText = block;
      lookupStart = start + i + j + 1;
      j = k + 1;
      continue;
    }
    instructions.push(line);
    j += 1;
  }
  if (lookupText !== null) {
    const lookup = lookupFrom(lookupText.join('\n'), `${path}.lookup`, owner, lookupStart, sink);
    if (lookup) step.lookup = lookup;
  }
  step.instructions = cleanBlock(instructions.join('\n'));
  return step;
}

export interface ParsedRunbook {
  /** `null` when the source cannot be turned into a definition. */
  definition: RunbookDefinition | null;
  /** The front matter's `version` (metadata outside the definition). */
  version: number | null;
  /** Every problem the parser found; content rules are the server's. */
  issues: RunbookIssue[];
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Parse the native Markdown form into a definition. Never throws. */
export function parseRunbookMarkdown(text: string): ParsedRunbook {
  const sink = new Collector();
  const source = String(text ?? '');
  const size = utf8Bytes(source);
  if (size > RUNBOOK_LIMITS.sourceBytes) {
    return {
      definition: null,
      version: null,
      issues: [
        {
          path: 'source',
          code: ISSUE_SOURCE_SIZE,
          message: `The Markdown source is ${size.toLocaleString()} bytes; the limit is ${RUNBOOK_LIMITS.sourceBytes.toLocaleString()}.`,
        },
      ],
    };
  }
  const [rawMeta, body, bodyStart] = splitFrontMatter(source);
  if (rawMeta === null) {
    sink.add('source', ISSUE_PARSE, "The source must start with front matter: a line '---', the header keys, then '---'.", true);
    return { definition: null, version: null, issues: sink.result() };
  }
  let meta: YamlMap;
  try {
    meta = parseYaml(rawMeta, 2);
  } catch (err) {
    const e = err as YamlError;
    sink.add('source', ISSUE_PARSE, `Front matter, line ${e.line}: ${e.message}`, true);
    return { definition: null, version: null, issues: sink.result() };
  }

  const defn: RunbookDefinition = {
    id: '',
    title: '',
    summary: '',
    use_when: '',
    prerequisites: '',
    applies_when: emptyAppliesWhen(),
    priority: 50,
    mitre: [],
    phases: [],
    steps: [],
    retrieval_queries: [],
    owner: null,
    review_every_days: RUNBOOK_LIMITS.reviewDefault,
    references: [],
  };
  let version: number | null = null;
  for (const [key, v] of Object.entries(meta)) {
    if (!FRONT_MATTER_KEYS.includes(key)) {
      sink.add(key, ISSUE_UNKNOWN_KEY, `The front matter has the unknown key '${shown(key, 40)}'. Known keys: ${FRONT_MATTER_KEYS.join(', ')}.`);
      continue;
    }
    if (key === 'id' || key === 'title' || key === 'summary' || key === 'use_when' || key === 'prerequisites') {
      defn[key] = asText(v, key, key, sink).trim();
    } else if (key === 'owner') {
      defn.owner = asText(v, key, key, sink).trim() || null;
    } else if (key === 'version') {
      version = versionFrom(v, sink);
    } else if (key === 'priority' || key === 'review_every_days') {
      const number = asInt(v, key, key, sink);
      if (number !== null) {
        const [low, high] = key === 'priority' ? [0, 100] : [RUNBOOK_LIMITS.reviewMin, RUNBOOK_LIMITS.reviewMax];
        if (number < low || number > high) sink.add(key, ISSUE_PARSE, `${key} must be between ${low} and ${high}.`, true);
        else defn[key] = number;
      }
    } else if (key === 'applies_when') {
      defn.applies_when = { ...emptyAppliesWhen(), ...appliesWhenFrom(v, sink) };
    } else if (key === 'mitre' || key === 'retrieval_queries' || key === 'references') {
      defn[key] = asList(v, key, key, sink);
    }
  }
  if (!defn.id) sink.add('id', ISSUE_PARSE, 'The front matter needs an id.', true);

  const phases: PhaseId[] = [];
  const steps: RunbookStep[] = [];
  const lines = body.split('\n');
  let currentPhase: PhaseId | null = null;
  let stepHeading: string | null = null;
  let stepLines: string[] = [];
  let stepStart = 0;
  let fence: string | null = null;
  const flush = () => {
    if (stepHeading !== null && currentPhase !== null) {
      steps.push(parseStep(stepHeading, stepLines, currentPhase, steps.length, stepStart, sink));
    }
    stepHeading = null;
    stepLines = [];
  };
  lines.forEach((line, offset) => {
    const number = bodyStart + offset;
    if (fence !== null) {
      const t = line.trim();
      if (t === fence || (t.startsWith(fence) && !t.slice(3).trim())) fence = null;
      stepLines.push(line);
      return;
    }
    const fm = /^\s{0,3}(```|~~~)/.exec(line);
    if (fm && stepHeading !== null) {
      fence = fm[1];
      stepLines.push(line);
      return;
    }
    if (line.startsWith('## ') || line.trimEnd() === '##') {
      flush();
      const label = line.slice(2).trim().toLowerCase();
      const phase = PHASE_BY_LABEL[label];
      if (!phase) {
        sink.add('phases', ISSUE_PARSE, `Line ${number}: '${shown(line.slice(2).trim(), 40)}' is not a phase. Use ${PHASE_ORDER.map((p) => PHASE_LABEL[p]).join(', ')}.`, true);
        currentPhase = null;
        return;
      }
      if (phases.includes(phase)) {
        sink.add('phases', ISSUE_PARSE, `Line ${number}: the phase ${PHASE_LABEL[phase]} appears twice. Keep its steps under one heading.`, true);
      }
      phases.push(phase);
      currentPhase = phase;
      return;
    }
    if (line.startsWith('### ')) {
      flush();
      if (currentPhase === null) {
        sink.add('steps', ISSUE_PARSE, `Line ${number}: a step must be under a phase heading such as '## Triage'.`, true);
        return;
      }
      stepHeading = line.slice(4).trim();
      stepStart = number + 1;
      return;
    }
    if (stepHeading !== null) {
      stepLines.push(line);
    } else if (line.trim()) {
      sink.add(
        'source',
        ISSUE_PARSE,
        line.startsWith('# ')
          ? `Line ${number}: a top-level '#' heading is not part of the format. Remove it.`
          : `Line ${number}: text outside a step is not kept. Put it in a step's instructions or remove it.`,
        true,
      );
    }
  });
  flush();
  defn.phases = phases;
  defn.steps = steps;
  if (sink.fatal) return { definition: null, version, issues: sink.result() };
  return { definition: defn, version, issues: sink.result() };
}
