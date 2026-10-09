/**
 * Console-map contract (chat revamp SPEC §5.4, §3.5, §10.7).
 *
 * Chat answers "where do I change X?" with CONSOLE LINKS the server resolves from an
 * allowlist — never with a model-written URL. That allowlist is
 * `backend/app/knowledge/console_map.json`: every navigable console destination (page,
 * Settings section, Settings card), its breadcrumb, the grant it needs, and the topics
 * table behind "Ask about this" (KPI help and Settings section headers send a topic id,
 * never free text).
 *
 * The destinations live in TypeScript (`FEATURES`, `SETTINGS_SECTIONS_META`,
 * `SETTING_ANCHORS`), and regex-scraping TS from Python would be fragile, so this test
 * DERIVES the map from the real registries and requires the committed JSON to be
 * byte-identical. A renamed page, a moved section or a new card therefore fails here
 * until the map is regenerated:
 *
 *     npm run gen:console-map            # rewrites the JSON (write mode)
 *     python scripts/build_app_knowledge.py   # then refresh the corpus manifest
 *
 * The corpus manifest pins the console map's sha256, so the backend loader refuses a
 * map that was edited without regenerating the corpus (it fails closed). Line endings
 * are compared as LF, like the loader's hash, so a CRLF checkout does not read as stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { FEATURES, FEATURE_GROUPS, type FeatureNode, type NavPerm } from '@/soc/registry';
import { SETTINGS_REDIRECTS } from '@/soc/router';
import {
  SECTION_GROUP_ORDER,
  SECTION_META_BY_ID,
  SETTING_ANCHORS,
  SETTINGS_SECTIONS_META,
} from '@/soc/pages/settings/settings-sections-meta';

const MAP_PATH = path.resolve(process.cwd(), '..', 'backend', 'app', 'knowledge', 'console_map.json');

/** Write mode: `npm run gen:console-map` (vitest `--mode console-map-write`). */
const WRITE_MODE = import.meta.env.MODE === 'console-map-write';

/* ------------------------------------------------------------------ shapes -- */

type TargetKind = 'page' | 'settings' | 'settings_card';

interface ConsoleTarget {
  /** `page:<pageId>`, `settings:<sectionId>` or `settings:<sectionId>.<anchor>`. */
  id: string;
  kind: TargetKind;
  label: string;
  /** Breadcrumb as the console shows it, e.g. ["Settings", "Security & access", "Users"]. */
  crumb: string[];
  page: string;
  /** Validated NavOpts subset (`section`/`anchor` for Settings targets). */
  opts: Record<string, string>;
  /** The `resource:action` grant the destination needs, or null when ungated. */
  requires: string | null;
  blurb: string;
  keywords: string[];
  /** Preferences keys a Settings section owns ("where do I change chat_model?"). */
  owned_keys: string[];
}

interface Topic {
  id: string;
  kind: 'kpi' | 'settings';
  label: string;
  /** The fixed question chat asks for this topic (the page never sends free text). */
  question: string;
  /** Help Center refs `<path>#<anchor>` the answer should cite (checked by the corpus build). */
  docs: string[];
  /** The console target the answer should link, or null. */
  console: string | null;
}

interface ConsoleMap {
  schema: 1;
  generated_by: string;
  nav_groups: { id: string; label: string }[];
  settings_groups: { id: string; label: string }[];
  targets: ConsoleTarget[];
  topics: Topic[];
}

/* --------------------------------------------------------- curated overlays -- */

/**
 * Search keywords for PAGE targets. The registry carries none (Settings sections do),
 * and without them "connect a source" or "token spend" cannot find a page. Keys must be
 * real page ids; a stale key fails the test below.
 */
const PAGE_KEYWORDS: Record<string, string[]> = {
  overview: ['home', 'dashboard', 'posture', 'cyber defence center', 'kpi'],
  dashboard: ['home', 'posture', 'kpi', 'active risk', 'noise reduction'],
  dashboards: ['custom dashboard', 'widgets', 'layout'],
  standup: ['shift', 'handoff', 'daily summary', 'attention queue'],
  cases: ['triage', 'queue', 'alerts', 'incidents'],
  case_manager: ['split pane', 'queue', 'bulk', 'case detail'],
  campaigns: ['campaign', 'related cases', 'shared entity'],
  logs: ['log search', 'events', 'telemetry', 'unified logs'],
  chat: ['assistant', 'ask', 'question', 'conversation', 'reports'],
  investigate: ['entity', 'hunt', 'ip', 'host', 'user'],
  approvals: ['proposals', 'pending', 'approve', 'human in the loop'],
  intelligence: ['knowledge', 'runbooks', 'playbooks', 'memory'],
  knowledge: ['rag', 'corpus', 'documents', 'import'],
  runbooks: ['runbook', 'procedure', 'guidance'],
  memory: ['operator memory', 'facts', 'remember'],
  playbooks: ['playbook', 'response', 'procedure'],
  personas: ['agents', 'roster', 'personas'],
  metrics: ['analytics', 'posture', 'mttr', 'mtta', 'false positive rate', 'mitre coverage'],
  effectiveness: ['agent health', 'precedent', 'auto-close health', 'agent improvement'],
  cost: ['spend', 'tokens', 'budget', 'usage', 'ledger', 'price'],
  models: ['llm', 'model catalog', 'providers', 'pricing'],
  baseline: ['baseline', 'anomaly', 'silent source'],
  batchjobs: ['jobs', 'background jobs', 'export download', 'batch'],
  inbox: ['notifications', 'alerts', 'mentions'],
  sources: ['connectors', 'siem', 'edr', 'ingest', 'data source', 'connect', 'coverage'],
  audit: ['audit log', 'activity', 'who did what'],
  tuning: ['auto-tuning', 'threshold', 'false positives', 'rule tuning'],
  settings: ['preferences', 'configuration'],
  docs: ['help', 'documentation', 'help center', 'manual'],
};

/**
 * "Ask about this" KPI topics. Each id is the stable key a KPI HelpTip sends; the
 * question is the ONLY text that reaches chat for it; `docs` must resolve to anchors in
 * the KPI glossary (the corpus build fails otherwise).
 */
const GLOSSARY = 'analyst/kpi-glossary/';
const KPI_TOPICS: readonly Topic[] = [
  kpi('active_risk_index', 'Active Risk Index', 'What is the Active Risk Index and how is it calculated?', ['active-risk-index'], 'page:overview'),
  kpi('risk_score', 'Risk score', 'How is the deterministic risk score of a case calculated?', ['risk-score'], 'settings:detection.detection-risk'),
  kpi('total_cases', 'Total Cases', 'What does the Total Cases KPI count?', ['total-cases'], 'page:overview'),
  kpi('total_critical', 'Total Critical', 'What does the Total Critical KPI count?', ['total-critical'], 'page:overview'),
  kpi('open_cases', 'Open Cases', 'What does the Open Cases KPI count, and why is it not filtered by the time window?', ['open-cases'], 'page:cases'),
  kpi('false_positive_rate', 'False Positive Rate', 'How is the False Positive Rate calculated?', ['false-positive-rate'], 'page:metrics'),
  kpi('resolved_closed', 'Resolved / Closed', 'What does the Resolved / Closed KPI count?', ['resolved-closed'], 'page:overview'),
  kpi('auto_closed', 'Auto Closed', 'What does Auto Closed count, and how does it relate to Resolved / Closed?', ['auto-closed'], 'settings:detection.detection-autoclose'),
  kpi('human_vs_ai', 'Human vs AI', 'How does the Human vs AI card attribute closed cases?', ['human-vs-ai'], 'page:overview'),
  kpi('mttd', 'MTTD', 'What does MTTD measure and how is it calculated?', ['mttd'], 'page:overview'),
  kpi('respond', 'Respond', 'What does the Respond timing measure?', ['respond'], 'page:overview'),
  kpi('mtta', 'MTTA', 'What does MTTA measure and how is it calculated?', ['mtta'], 'page:metrics'),
  kpi('mttr', 'MTTR', 'What does MTTR measure and how is it calculated?', ['mttr'], 'page:metrics'),
  kpi('dwell', 'Dwell', 'What does the Dwell time measure?', ['dwell'], 'page:metrics'),
  kpi('noise_reduction', 'Noise Reduction', 'How should I read the Noise Reduction funnel and its stages?', ['noise-reduction-funnel'], 'page:overview'),
  kpi('llm_spend', 'LLM spend', 'How is AI model spend measured and limited?', ['llm-spend'], 'page:cost'),
];

function kpi(id: string, label: string, question: string, anchors: string[], consoleId: string): Topic {
  return { id: `kpi:${id}`, kind: 'kpi', label, question, docs: anchors.map((a) => `${GLOSSARY}#${a}`), console: consoleId };
}

/* --------------------------------------------------------------- derivation -- */

const permText = (perm: NavPerm | undefined): string | null =>
  perm ? `${perm.resource}:${perm.action}` : null;

/** Drop consecutive duplicates ("Analytics › Analytics › Metrics" → "Analytics › Metrics"). */
function crumb(parts: string[]): string[] {
  return parts.filter((part, index) => part && part !== parts[index - 1]);
}

function pageTargets(): ConsoleTarget[] {
  const groupLabel = new Map(FEATURE_GROUPS.map((g) => [g.id, g.label]));
  const out = new Map<string, ConsoleTarget>();
  const add = (page: string, label: string, parts: string[], perm: NavPerm | undefined) => {
    // A retired standalone route (users/roles/…) lands inside Settings; its Settings
    // section target is the destination, so the redirect id is never a page target.
    if (Object.prototype.hasOwnProperty.call(SETTINGS_REDIRECTS, page)) return;
    if (out.has(page)) return;
    out.set(page, {
      id: `page:${page}`,
      kind: 'page',
      label,
      crumb: crumb(parts),
      page,
      opts: {},
      requires: permText(perm),
      blurb: '',
      keywords: PAGE_KEYWORDS[page] ?? [],
      owned_keys: [],
    });
  };
  const visible: FeatureNode[] = FEATURES.filter((f) => !f.hidden);
  for (const feature of visible) {
    const group = groupLabel.get(feature.group) ?? '';
    const childIds = new Set((feature.children ?? []).map((c) => c.id));
    // A host whose id is also one of its children is reached through that child.
    if (!childIds.has(feature.id)) add(feature.id, feature.label, [group, feature.label], feature.perm);
    for (const child of feature.children ?? []) {
      add(child.id, child.label, [group, feature.label, child.label], child.perm ?? feature.perm);
    }
  }
  return [...out.values()];
}

function settingsTargets(): ConsoleTarget[] {
  const groupLabel = new Map(SECTION_GROUP_ORDER.map((g) => [g.id, g.label]));
  const sections: ConsoleTarget[] = SETTINGS_SECTIONS_META.map((s) => ({
    id: `settings:${s.id}`,
    kind: 'settings',
    label: s.title,
    crumb: ['Settings', groupLabel.get(s.group) ?? s.group, s.title],
    page: 'settings',
    opts: { section: s.id },
    requires: permText(s.perm),
    blurb: s.blurb,
    keywords: [...(s.keywords ?? [])],
    owned_keys: [...(s.ownedKeys ?? [])],
  }));
  const cards: ConsoleTarget[] = SETTING_ANCHORS.map((a) => {
    const section = SECTION_META_BY_ID[a.section];
    return {
      id: `settings:${a.section}.${a.anchor}`,
      kind: 'settings_card',
      label: a.label,
      crumb: ['Settings', groupLabel.get(section.group) ?? section.group, section.title, a.label],
      page: 'settings',
      opts: { section: a.section, anchor: a.anchor },
      requires: permText(section.perm),
      blurb: '',
      keywords: [...a.keywords],
      owned_keys: [],
    };
  });
  return [...sections, ...cards];
}

function settingsTopics(): Topic[] {
  const groupLabel = new Map(SECTION_GROUP_ORDER.map((g) => [g.id, g.label]));
  return SETTINGS_SECTIONS_META.map((s) => ({
    id: `settings:${s.id}`,
    kind: 'settings',
    label: s.title,
    question: `What does Settings › ${groupLabel.get(s.group) ?? s.group} › ${s.title} control, and who can change it?`,
    docs: [],
    console: `settings:${s.id}`,
  }));
}

function buildConsoleMap(): ConsoleMap {
  return {
    schema: 1,
    generated_by: 'webui/src/soc/__tests__/console-map.contract.test.ts (npm run gen:console-map)',
    nav_groups: FEATURE_GROUPS.map((g) => ({ id: g.id, label: g.label })),
    settings_groups: SECTION_GROUP_ORDER.map((g) => ({ id: g.id, label: g.label })),
    targets: [...pageTargets(), ...settingsTargets()],
    topics: [...KPI_TOPICS, ...settingsTopics()],
  };
}

const serialise = (map: ConsoleMap): string => `${JSON.stringify(map, null, 2)}\n`;

/* -------------------------------------------------------------------- tests -- */

// Mirrors of the backend wire patterns (models.ConsoleLink, blocks.NavRefOpts): a target
// the server could not turn into a ConsoleLink would be silently dropped there.
const LINK_ID = /^[a-z0-9_]{1,40}:[a-z0-9_.-]{1,80}$/;
const GRANT = /^[a-z_]{1,40}:[a-z_]{1,40}$/;
const PAGE = /^[a-z][a-z_]{0,39}$/;
const ROUTE_TOKEN = /^[A-Za-z0-9_.:@ -]{1,128}$/;

describe('console map contract (SPEC §5.4)', () => {
  const expected = buildConsoleMap();

  it('the committed console_map.json is byte-identical to the registry derivation', () => {
    const text = serialise(expected);
    if (WRITE_MODE) writeFileSync(MAP_PATH, text, 'utf8');
    let committed = '';
    try {
      committed = readFileSync(MAP_PATH, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      committed = '';
    }
    expect(
      committed === text,
      'backend/app/knowledge/console_map.json is stale: run `npm run gen:console-map`, then ' +
        '`python scripts/build_app_knowledge.py` to refresh the corpus manifest',
    ).toBe(true);
  });

  it('every target is a valid ConsoleLink on the wire', () => {
    const ids = expected.targets.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const target of expected.targets) {
      expect(LINK_ID.test(target.id), target.id).toBe(true);
      expect(PAGE.test(target.page), target.id).toBe(true);
      expect(target.label.length > 0 && target.label.length <= 80, target.id).toBe(true);
      if (target.requires !== null) expect(GRANT.test(target.requires), target.id).toBe(true);
      for (const value of Object.values(target.opts)) {
        expect(ROUTE_TOKEN.test(value), `${target.id} opts`).toBe(true);
      }
    }
  });

  it('settings targets mirror the section registry (perm, owned keys, cards)', () => {
    const byId = new Map(expected.targets.map((t) => [t.id, t]));
    for (const section of SETTINGS_SECTIONS_META) {
      const target = byId.get(`settings:${section.id}`);
      expect(target?.requires ?? null).toBe(permText(section.perm));
      expect(target?.owned_keys).toEqual([...(section.ownedKeys ?? [])]);
    }
    for (const anchor of SETTING_ANCHORS) {
      expect(byId.get(`settings:${anchor.section}.${anchor.anchor}`)?.opts).toEqual({
        section: anchor.section,
        anchor: anchor.anchor,
      });
    }
    // "Where do I change the chat model?" resolves through ownedKeys.
    expect(byId.get('settings:models')?.owned_keys).toContain('chat_model');
    expect(byId.get('settings:admin_users')?.crumb).toEqual(['Settings', 'Security & access', 'Users']);
  });

  it('page targets cover every visible feature and never a Settings redirect', () => {
    const pages = new Set(expected.targets.filter((t) => t.kind === 'page').map((t) => t.page));
    for (const feature of FEATURES.filter((f) => !f.hidden)) {
      for (const id of [feature.id, ...(feature.children ?? []).map((c) => c.id)]) {
        if (Object.prototype.hasOwnProperty.call(SETTINGS_REDIRECTS, id)) {
          expect(pages.has(id), id).toBe(false);
        } else {
          expect(pages.has(id), id).toBe(true);
        }
      }
    }
    expect(expected.targets.find((t) => t.id === 'page:chat')?.crumb).toEqual(['Triage', 'Workspace', 'Chat']);
  });

  it('curated overlays reference real ids', () => {
    const pages = new Set(expected.targets.filter((t) => t.kind === 'page').map((t) => t.page));
    expect(Object.keys(PAGE_KEYWORDS).filter((id) => !pages.has(id))).toEqual([]);
    const targetIds = new Set(expected.targets.map((t) => t.id));
    const topicIds = expected.topics.map((t) => t.id);
    expect(new Set(topicIds).size).toBe(topicIds.length);
    for (const topic of expected.topics) {
      expect(LINK_ID.test(topic.id), topic.id).toBe(true);
      if (topic.console !== null) expect(targetIds.has(topic.console), topic.id).toBe(true);
      expect(topic.question.length > 0 && topic.question.length <= 200, topic.id).toBe(true);
      for (const doc of topic.docs) expect(/^[a-z0-9/_-]+\/#[a-z0-9_-]+$/.test(doc), doc).toBe(true);
    }
  });
});
