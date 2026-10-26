/**
 * The console grammar guard (Round 14, SPEC §4.9.2 and §4.9.3; operator choices C7, C8).
 *
 * Every page uses the Overview's grammar: the page header is the title, a help tip, its
 * controls and its actions; modules sit on the tinted panel; labels are sentence case;
 * shared primitives own refresh spinners, numbers, explanations and type sizes. This test
 * reads the source and fails when a file reintroduces what the grammar removed:
 *
 *   header-overline        `eyebrow=` or `breadcrumb=` in a page file
 *   header-removed-prop    a page's `<PageHeader>` passing `icon`, `description` (unless
 *                          `embedded`) or `variant="hero"` (`back=` is the one sanctioned
 *                          extra and is never flagged)
 *   uppercase-tracking     a class string with tracked capitals in a page file
 *   arbitrary-radius       an arbitrary `rounded-[...]` radius in a page file
 *   card-in-panel          a card (`<Card>`, `<StatCard>`, a `chrome="framed"` KpiTile)
 *                          inside a panel (`<Panel>`, `<ChartCard>`, `<KpiStrip>`): no
 *                          nested cards
 *   spinning-refresh       `<RefreshCw>` with `animate-spin` outside `RefreshButton`
 *   section-shell-rail     `<SectionShell rail>` (in-section anchor rails are gone)
 *   raw-number-input       `type="number"` outside `NumberField`
 *   info-alert             `<Alert variant="info">` in a page file (D26: a help tip, or a
 *                          `Callout` for a live condition)
 *   critical-icon-button   an icon button painted `text-critical` at rest outside a
 *                          dialog (red only on hover, focus and in the confirm dialog)
 *   tiny-text              an arbitrary text size below 11px (`text-[10px]`,
 *                          `text-[0.65rem]`, ...) outside the badge primitive
 *   prototype-leftover     a prototype preview folder or a prototype data attribute, in
 *                          any file under `src` (styles and data included)
 *
 * A "page file" is a routed page or rule screen (`soc/pages`, `soc/rules`), or any other
 * product file that renders a routed page header (a `<PageHeader>` that is not `embedded`).
 *
 * Existing violations are listed per package in `guard-allow/<WP>.json` (one file per
 * package, so page migrations running in parallel never edit the same file). Each entry is
 * the EXACT count for one rule in one file, so it works as a ratchet: a change that fixes
 * a violation lowers the entry in the same change (and deletes it at 0), and the test
 * fails until it does, so a fixed violation can never come back unnoticed. A package
 * empties its own file as it migrates its pages (SPEC §7.10). `backlog.json` lists files
 * no package owns, for the orchestrator to assign. Prototype leftovers can never be
 * allowed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');
const ALLOW_DIR = path.join(__dirname, 'guard-allow');
const SELF = 'soc/__tests__/console-grammar.guard.test.ts';

const GUARD_RULES = [
  'header-overline',
  'header-removed-prop',
  'uppercase-tracking',
  'arbitrary-radius',
  'card-in-panel',
  'spinning-refresh',
  'section-shell-rail',
  'raw-number-input',
  'info-alert',
  'critical-icon-button',
  'tiny-text',
  'prototype-leftover',
] as const;
type Rule = (typeof GUARD_RULES)[number];

/** Built by concatenation so this file never matches its own prototype check. */
const PROTOTYPE_ATTRIBUTE = ['data', 'u2', ''].join('-');
const hasPrototypeAttribute = (text: string) => text.includes(PROTOTYPE_ATTRIBUTE);
/** A prototype preview folder: `soc/preview/` or any `nav-preview/` segment. */
const isPrototypePath = (rel: string) => rel.startsWith('soc/preview/') || /(^|\/)nav-preview\//.test(rel);

// ---------------------------------------------------------------------------------------
// Files

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const relative = (file: string) => path.relative(SRC, file).split(path.sep).join('/');
/** Every file under `src` (scripts, styles, data, docs): the prototype check reads them all. */
const EVERY_FILE = walk(SRC).map(relative).sort();
/** The TypeScript sources the grammar rules read. */
const ALL_FILES = EVERY_FILE.filter((rel) => /\.(ts|tsx)$/.test(rel) && !rel.endsWith('.d.ts'));
const isTest = (rel: string) =>
  rel.includes('/__tests__/') || /\.(test|spec)\.tsx?$/.test(rel) || rel.startsWith('test/');
/** Product source the grammar applies to. */
const PRODUCT_FILES = ALL_FILES.filter((rel) => !isTest(rel) && !rel.endsWith('.gen.ts'));

const sourceCache = new Map<string, string>();
const source = (rel: string): string => {
  let text = sourceCache.get(rel);
  if (text === undefined) {
    text = readFileSync(path.join(SRC, rel), 'utf8');
    sourceCache.set(rel, text);
  }
  return text;
};

// ---------------------------------------------------------------------------------------
// A small TypeScript/JSX lexer: comments blanked (strings kept), and every string literal.

interface Lexed {
  /** The source with every comment replaced by spaces (same length, so indices hold). */
  code: string;
  /** Every string and template literal body. */
  strings: string[];
}

/**
 * Characters after which a `/` starts a regular expression literal. `<` is not one: in
 * TSX `</` is a closing tag, and reading it as a regex swallowed the rest of the line
 * (and every class string on it).
 */
const REGEX_PREFIX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '>', '~', '^', '']);

function lex(text: string): Lexed {
  const out = text.split('');
  const strings: string[] = [];
  let i = 0;
  let lastSignificant = '';
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  const readQuoted = (quote: string): number => {
    let j = i + 1;
    while (j < text.length && text[j] !== quote && text[j] !== '\n') {
      j += text[j] === '\\' ? 2 : 1;
    }
    strings.push(text.slice(i + 1, j));
    return j + 1;
  };
  const readTemplate = (): number => {
    let j = i + 1;
    let start = j;
    const parts: string[] = [];
    while (j < text.length && text[j] !== '`') {
      if (text[j] === '\\') {
        j += 2;
      } else if (text[j] === '$' && text[j + 1] === '{') {
        parts.push(text.slice(start, j));
        let depth = 1;
        j += 2;
        while (j < text.length && depth > 0) {
          if (text[j] === '{') depth += 1;
          else if (text[j] === '}') depth -= 1;
          j += 1;
        }
        start = j;
      } else {
        j += 1;
      }
    }
    parts.push(text.slice(start, j));
    strings.push(parts.join(' '));
    return j + 1;
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = readQuoted(ch);
      lastSignificant = ch;
      continue;
    }
    if (ch === '`') {
      i = readTemplate();
      lastSignificant = '`';
      continue;
    }
    // `/>` closes a self-closing JSX tag (`{x} />`), never a regex.
    if (ch === '/' && next !== '>' && REGEX_PREFIX.has(lastSignificant)) {
      // A regular expression literal: skip it, classes included, so its quotes never
      // open a string.
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') j += 1;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      i = j + 1;
      lastSignificant = '/';
      continue;
    }
    if (!/\s/.test(ch)) lastSignificant = /[A-Za-z0-9_$)\]]/.test(ch) ? 'x' : ch;
    i += 1;
  }
  return { code: out.join(''), strings };
}

const lexCache = new Map<string, Lexed>();
const lexed = (rel: string): Lexed => {
  let value = lexCache.get(rel);
  if (!value) {
    value = lex(source(rel));
    lexCache.set(rel, value);
  }
  return value;
};

/**
 * The opening tag that starts at `start` (`<Name ...>`): its end index, whether it closes
 * itself, its raw attribute text, and the attributes with every `{...}` group emptied (so a
 * nested element's props never read as this tag's props).
 */
function openingTag(code: string, start: number) {
  let i = start + 1;
  while (i < code.length && /[\w.$]/.test(code[i])) i += 1;
  let depth = 0;
  let flat = '';
  const raw0 = i;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const close = ch;
      let j = i + 1;
      while (j < code.length && code[j] !== close) j += code[j] === '\\' ? 2 : 1;
      if (depth === 0) flat += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) flat += '{';
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) flat += '}';
    } else if (ch === '>' && depth === 0) {
      const selfClosing = code[i - 1] === '/';
      return { end: i + 1, selfClosing, raw: code.slice(raw0, i), flat };
    } else if (depth === 0) {
      flat += ch;
    }
    i += 1;
  }
  return { end: code.length, selfClosing: true, raw: code.slice(raw0), flat };
}

/** Every opening `<Name` tag (exact name) in the code, with its parsed attributes. */
function tags(code: string, name: string) {
  const found: Array<{ start: number } & ReturnType<typeof openingTag>> = [];
  const pattern = new RegExp(`<${name}(?![\\w.$])`, 'g');
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    found.push({ start: match.index, ...openingTag(code, match.index) });
  }
  return found;
}

/** The [start, end) spans of every `<Name ...>...</Name>` element (nesting aware). */
function elementSpans(code: string, name: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const tag of tags(code, name)) {
    if (tag.selfClosing) continue;
    const open = new RegExp(`<${name}(?![\\w.$])`, 'g');
    const close = new RegExp(`</${name}\\s*>`, 'g');
    let depth = 1;
    let cursor = tag.end;
    while (depth > 0) {
      open.lastIndex = cursor;
      close.lastIndex = cursor;
      const nextOpen = open.exec(code);
      const nextClose = close.exec(code);
      if (!nextClose) {
        cursor = code.length;
        break;
      }
      if (nextOpen && nextOpen.index < nextClose.index) {
        const inner = openingTag(code, nextOpen.index);
        if (!inner.selfClosing) depth += 1;
        cursor = inner.end;
      } else {
        depth -= 1;
        cursor = nextClose.index + nextClose[0].length;
      }
    }
    spans.push([tag.start, cursor]);
  }
  return spans;
}

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

/** A routed page header: a `<PageHeader>` that is not `embedded`. */
const isEmbeddedTag = (flat: string) => /(^|\s)embedded(?=[\s=/]|$)/.test(flat);
const rendersPageHeader = (rel: string) => tags(lexed(rel).code, 'PageHeader').some((tag) => !isEmbeddedTag(tag.flat));

/**
 * Page files: the page and rule screens, plus any other product file that renders a routed
 * page header (the Logs body, the report reader, the page layout helpers), so a page whose
 * header lives outside `soc/pages` is held to the same grammar.
 */
const PAGE_FILES = PRODUCT_FILES.filter(
  (rel) => rel.startsWith('soc/pages/') || rel.startsWith('soc/rules/') || (rel.endsWith('.tsx') && rendersPageHeader(rel)),
);

/** Arbitrary text sizes (`text-[10px]`, `text-[0.65rem]`, `text-[.6em]`) below the 11px floor. */
const TINY_TEXT = /\btext-\[(\d*\.?\d+)(px|rem|em)\]/g;
const TEXT_FLOOR_PX = 11;
function tinyTextCount(code: string): number {
  let n = 0;
  for (const match of code.matchAll(TINY_TEXT)) {
    const px = Number(match[1]) * (match[2] === 'px' ? 1 : 16);
    if (px < TEXT_FLOOR_PX) n += 1;
  }
  return n;
}

/** Elements that ARE a panel (a tinted module), and cards that must never sit inside one. */
const PANEL_ELEMENTS = ['Panel', 'ChartCard', 'KpiStrip'] as const;
function cardStarts(code: string): number[] {
  const plain = ['Card', 'StatCard'].flatMap((name) => tags(code, name).map((tag) => tag.start));
  const framed = tags(code, 'KpiTile')
    .filter((tag) => /(^|\s)chrome=(?:["']framed["']|\{\s*["']framed["']\s*\})/.test(tag.flat))
    .map((tag) => tag.start);
  return [...plain, ...framed];
}
function cardsInPanels(code: string): number {
  const spans = PANEL_ELEMENTS.flatMap((name) => elementSpans(code, name));
  // A card is counted once even where panels nest (a ChartCard inside a Panel).
  return cardStarts(code).filter((at) => spans.some(([from, to]) => at > from && at < to)).length;
}

// ---------------------------------------------------------------------------------------
// The rules: each returns the number of violations in one file.

const RESTING_CRITICAL = /(^|[\s'"`])text-critical(-text)?(?=[\s'"`]|$)/;

const CHECKS: Record<Exclude<Rule, 'prototype-leftover'>, { files: () => string[]; count: (rel: string) => number }> = {
  'header-overline': {
    files: () => PAGE_FILES,
    count: (rel) => count(lexed(rel).code, /\b(eyebrow|breadcrumb)=/g),
  },
  'header-removed-prop': {
    files: () => PAGE_FILES,
    count: (rel) =>
      tags(lexed(rel).code, 'PageHeader').reduce((sum, tag) => {
        const embedded = /(^|\s)embedded(?=[\s=/]|$)/.test(tag.flat);
        let n = 0;
        if (/(^|\s)icon=/.test(tag.flat)) n += 1;
        if (/(^|\s)variant=["']hero["']/.test(tag.flat)) n += 1;
        if (!embedded && /(^|\s)description=/.test(tag.flat)) n += 1;
        return sum + n;
      }, 0),
  },
  'uppercase-tracking': {
    files: () => PAGE_FILES,
    count: (rel) => lexed(rel).strings.filter((s) => /\buppercase\b/.test(s) && /\btracking-/.test(s)).length,
  },
  'arbitrary-radius': {
    files: () => PAGE_FILES,
    count: (rel) => count(lexed(rel).code, /\brounded(?:-[a-z]{1,2})?-\[/g),
  },
  'card-in-panel': {
    files: () => PRODUCT_FILES,
    count: (rel) => cardsInPanels(lexed(rel).code),
  },
  'spinning-refresh': {
    files: () => PRODUCT_FILES.filter((rel) => rel !== 'soc/components/RefreshButton.tsx'),
    count: (rel) => tags(lexed(rel).code, 'RefreshCw').filter((tag) => tag.raw.includes('animate-spin')).length,
  },
  'section-shell-rail': {
    files: () => PRODUCT_FILES,
    count: (rel) => tags(lexed(rel).code, 'SectionShell').filter((tag) => /(^|\s)rail(?=[\s=/]|$)/.test(tag.flat)).length,
  },
  'raw-number-input': {
    files: () => PRODUCT_FILES.filter((rel) => rel !== 'soc/components/NumberField.tsx'),
    count: (rel) => count(lexed(rel).code, /\btype=(?:["']number["']|\{\s*["']number["']\s*\})/g),
  },
  'info-alert': {
    files: () => PAGE_FILES,
    count: (rel) => tags(lexed(rel).code, 'Alert').filter((tag) => /(^|\s)variant=["']info["']/.test(tag.flat)).length,
  },
  'critical-icon-button': {
    files: () => PRODUCT_FILES.filter((rel) => !/Dialog[^/]*\.tsx$/.test(rel)),
    count: (rel) => {
      const { code } = lexed(rel);
      const dialogs = [...elementSpans(code, 'DialogContent'), ...elementSpans(code, 'AlertDialogContent')];
      const inDialog = (at: number) => dialogs.some(([from, to]) => at > from && at < to);
      const iconButtons = [
        ...tags(code, 'Button').filter((tag) => /(^|\s)size=["']icon["']/.test(tag.flat)),
        ...tags(code, 'IconButton'),
      ];
      return iconButtons.filter((tag) => !inDialog(tag.start) && RESTING_CRITICAL.test(tag.raw)).length;
    },
  },
  'tiny-text': {
    files: () => PRODUCT_FILES.filter((rel) => rel !== 'ui/badge.tsx'),
    count: (rel) => tinyTextCount(lexed(rel).code),
  },
};

// ---------------------------------------------------------------------------------------
// The allow-list: one file per package, each entry the exact count for one rule in one file.

/**
 * The packages that may hold an allow file: the web packages of SPEC §7.5 and §7.6, plus
 * `backlog`, the orchestrator's list of files no package owns (each entry waits to be
 * assigned to a package, SPEC §7.1).
 */
const KNOWN_PACKAGES = [
  'W1',
  'W2a',
  'W2b',
  'W3',
  'W4a',
  'W4b',
  'W4c',
  'W5',
  'W6a',
  'W6b',
  'W7a',
  'W7b',
  'W8a',
  'W8b',
  'W9a',
  'W9b',
  'backlog',
] as const;

interface AllowEntry {
  rule: Rule;
  file: string;
  max: number;
}
interface AllowFile {
  package: string;
  entries: AllowEntry[];
}

function readAllowFiles(): Array<AllowFile & { path: string }> {
  if (!existsSync(ALLOW_DIR)) return [];
  return readdirSync(ALLOW_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ path: name, ...(JSON.parse(readFileSync(path.join(ALLOW_DIR, name), 'utf8')) as AllowFile) }));
}

const ALLOW_FILES = readAllowFiles();
const ALLOWED = new Map<string, number>();
const OWNER = new Map<string, string>();
for (const file of ALLOW_FILES) {
  for (const entry of file.entries ?? []) {
    ALLOWED.set(`${entry.rule}|${entry.file}`, entry.max);
    OWNER.set(`${entry.rule}|${entry.file}`, file.path);
  }
}

// ---------------------------------------------------------------------------------------

describe('console grammar guard: the allow-list', () => {
  it('has one well-formed file per package, named after it', () => {
    expect(ALLOW_FILES.length).toBeGreaterThan(0);
    for (const file of ALLOW_FILES) {
      expect(file.path, `${file.path} names its package`).toBe(`${file.package}.json`);
      expect(KNOWN_PACKAGES, `${file.path}: ${file.package} is not a Round 14 web package`).toContain(file.package);
      expect(Array.isArray(file.entries), `${file.path} entries`).toBe(true);
      for (const entry of file.entries) {
        expect(GUARD_RULES, `${file.path}: unknown rule ${entry.rule}`).toContain(entry.rule);
        expect(entry.rule, `${file.path}: prototype leftovers are never allowed`).not.toBe('prototype-leftover');
        expect(ALL_FILES, `${file.path}: ${entry.file} does not exist`).toContain(entry.file);
        expect(Number.isInteger(entry.max) && entry.max > 0, `${file.path}: ${entry.file} max`).toBe(true);
      }
    }
  });

  it('never lists the same rule and file twice (each file has one owning package)', () => {
    const seen = new Map<string, string>();
    for (const file of ALLOW_FILES) {
      for (const entry of file.entries) {
        const key = `${entry.rule}|${entry.file}`;
        expect(seen.get(key), `${key} is listed by ${seen.get(key)} and ${file.package}`).toBeUndefined();
        seen.set(key, file.package);
      }
    }
  });
});

describe('console grammar guard: the rules', () => {
  it.each(Object.keys(CHECKS) as Array<keyof typeof CHECKS>)('%s: no file above its allowance', (rule) => {
    const over: string[] = [];
    for (const rel of CHECKS[rule].files()) {
      const found = CHECKS[rule].count(rel);
      const allowed = ALLOWED.get(`${rule}|${rel}`) ?? 0;
      if (found > allowed) over.push(`${rel}: ${found} found, ${allowed} allowed`);
    }
    expect(over, `${rule} violations (fix them; an allowance only ever goes down)`).toEqual([]);
  });

  it('every allowance is exact, so it only ever goes down (lower it in the same change)', () => {
    const stale: string[] = [];
    for (const [key, max] of ALLOWED) {
      const [rule, file] = key.split('|') as [Rule, string];
      if (rule === 'prototype-leftover') continue; // refused by the allow-list test above
      const check = CHECKS[rule];
      if (!check.files().includes(file)) {
        stale.push(`${key} in ${OWNER.get(key)}: the rule does not read this file (delete the entry)`);
        continue;
      }
      const found = check.count(file);
      if (found !== max) {
        stale.push(
          found < max
            ? `lower ${key} in ${OWNER.get(key)} to ${found}${found === 0 ? ' (delete the entry at 0)' : ''}`
            : `${key} in ${OWNER.get(key)}: ${found} found, ${max} allowed`,
        );
      }
    }
    expect(stale).toEqual([]);
  });

  it('prototype-leftover: no preview folder and no prototype data attribute in any file', () => {
    // Every file under src, not only scripts: a prototype left its selectors in CSS.
    expect(EVERY_FILE.length).toBeGreaterThan(ALL_FILES.length);
    expect(EVERY_FILE.some((rel) => rel.endsWith('.css'))).toBe(true);
    expect(EVERY_FILE.filter(isPrototypePath)).toEqual([]);
    expect(existsSync(path.join(SRC, 'soc', 'preview'))).toBe(false);
    const attributes = EVERY_FILE.filter((rel) => rel !== SELF && hasPrototypeAttribute(source(rel)));
    expect(attributes).toEqual([]);
  });
});

describe('console grammar guard: the detectors themselves', () => {
  it('reads PageHeader props at the top level only and lets back= and embedded descriptions through', () => {
    const code = lex(
      [
        '<PageHeader title="A" icon={Gauge} meta={<KpiTile icon={X} description="nested" />} />',
        '<PageHeader title="B" variant="hero" description="x" />',
        '<PageHeader embedded title="C" description="ok" back={{ label: "All", href: "#/d" }} />',
      ].join('\n'),
    ).code;
    const found = tags(code, 'PageHeader').map((tag) => tag.flat);
    expect(found).toHaveLength(3);
    expect(/(^|\s)icon=/.test(found[0])).toBe(true);
    expect(/(^|\s)description=/.test(found[0])).toBe(false);
    expect(/(^|\s)variant=["']hero["']/.test(found[1])).toBe(true);
    expect(/(^|\s)embedded/.test(found[2])).toBe(true);
    expect(found[2]).not.toMatch(/(^|\s)icon=/);
  });

  it('ignores comments, finds class strings, and skips regular expressions with quotes', () => {
    const { code, strings } = lex(
      [
        "// text-[10px] in a comment, it's fine",
        "const re = /['\"]/;",
        "const cls = 'text-xs font-semibold uppercase tracking-wider';",
        '/* rounded-[3px] */ const r = `rounded-md ${x}`;',
      ].join('\n'),
    );
    expect(tinyTextCount(code)).toBe(0);
    expect(count(code, /\brounded(?:-[a-z]{1,2})?-\[/g)).toBe(0);
    expect(strings.filter((s) => /\buppercase\b/.test(s) && /\btracking-/.test(s))).toHaveLength(1);
  });

  it('finds a Card nested inside a Panel, not beside it', () => {
    const code = lex('<Panel title="x"><div><Card>a</Card></div></Panel><Card>b</Card><Panel />').code;
    const spans = elementSpans(code, 'Panel');
    expect(spans).toHaveLength(1);
    expect(count(code.slice(spans[0][0], spans[0][1]), /<Card(?![\w.$])/g)).toBe(1);
    expect(cardsInPanels(code)).toBe(1);
  });

  it('treats ChartCard and KpiStrip as panels, and StatCard and a framed KpiTile as cards', () => {
    expect(cardsInPanels(lex('<ChartCard title="x"><Card>a</Card></ChartCard>').code)).toBe(1);
    expect(cardsInPanels(lex('<ChartCard title="x"><StatCard label="a" value="1" /></ChartCard>').code)).toBe(1);
    expect(cardsInPanels(lex('<KpiStrip label="s"><KpiTile label="a" value="1" chrome="framed" /></KpiStrip>').code)).toBe(1);
    // A strip tile is the panel's own grammar, not a card.
    expect(cardsInPanels(lex('<KpiStrip label="s"><KpiTile label="a" value="1" /></KpiStrip>').code)).toBe(0);
    // Counted once where panels nest, and never beside a panel.
    expect(cardsInPanels(lex('<Panel><ChartCard title="x"><Card>a</Card></ChartCard></Panel>').code)).toBe(1);
    expect(cardsInPanels(lex('<ChartCard title="x">a</ChartCard><StatCard label="b" value="2" />').code)).toBe(0);
  });

  it('flags every arbitrary text size below 11px, in px, rem or em', () => {
    expect(tinyTextCount("'text-[10px] text-[9px]'")).toBe(2);
    expect(tinyTextCount("'text-[0.65rem]'")).toBe(1);
    expect(tinyTextCount("'text-[0.6rem] text-[.6em]'")).toBe(2);
    // 11px is the floor, not below it.
    expect(tinyTextCount("'text-[11px] text-[0.6875rem] text-[0.75rem] text-[13px]'")).toBe(0);
  });

  it('reads class strings after a JSX closing tag or a self-closing tag on the same line', () => {
    const tracked = (line: string) => lex(line).strings.filter((s) => /\buppercase\b/.test(s) && /\btracking-/.test(s)).length;
    expect(tracked('<b>x</b> <span className="uppercase tracking-wide">y</span>')).toBe(1);
    expect(tracked('<Foo a={b} /><span className="text-xs uppercase tracking-wide">x</span>')).toBe(1);
    expect(tracked("return <div>{x}</div>; const c = 'uppercase tracking-wider';")).toBe(1);
    expect(tracked('<a href="https://example.com">x</a> <i className="uppercase tracking-wide" />')).toBe(1);
    // A real regular expression is still skipped, quotes and all.
    expect(lex("const re = /['\"]/; const s = 'ok';").strings).toEqual(['ok']);
  });

  it('finds a prototype attribute in a stylesheet and a preview folder anywhere', () => {
    expect(hasPrototypeAttribute(`[${PROTOTYPE_ATTRIBUTE}x] { color: red; }`)).toBe(true);
    expect(hasPrototypeAttribute('[data-state="open"] {}')).toBe(false);
    expect(isPrototypePath('soc/preview/u2/U2Surface.tsx')).toBe(true);
    expect(isPrototypePath('soc/components/nav-preview/Rail.css')).toBe(true);
    expect(isPrototypePath('nav-preview/x.json')).toBe(true);
    expect(isPrototypePath('soc/components/PreviewPanel.tsx')).toBe(false);
  });

  it('holds a routed page header outside soc/pages to the page rules, but not an embedded one', () => {
    expect(PAGE_FILES).toContain('soc/components/UnifiedLogsSheet.tsx');
    expect(PAGE_FILES).toContain('soc/chat/report/ReportsLibrary.tsx');
    expect(isEmbeddedTag(' embedded title="x"')).toBe(true);
    expect(isEmbeddedTag(' title="x" embedded={true}')).toBe(true);
    expect(isEmbeddedTag(' title="embedded"')).toBe(false);
  });

  it('flags a resting red icon button but not a hover-only one', () => {
    expect(RESTING_CRITICAL.test(' className="h-8 w-8 text-critical"')).toBe(true);
    expect(RESTING_CRITICAL.test(' className="h-8 w-8 hover:text-critical"')).toBe(false);
    expect(RESTING_CRITICAL.test(" className={cn('text-critical-text', x)}")).toBe(true);
  });
});
