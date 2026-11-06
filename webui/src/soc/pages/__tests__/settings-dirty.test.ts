/**
 * Round-3 Settings (Group 2) regression coverage:
 *   1. the per-section dirty map — only CHANGED editable top-level keys are reported,
 *      `sources`/`setup_complete` are never editable, the Save patch is minimal, and a
 *      section lights its "modified" dot only when it OWNS a changed key;
 *   2. the bounded ThemeTokens preview — operator appearance values are allow-listed +
 *      sanitised before they touch the DOM (layout tokens apply; semantic/unsafe/
 *      unknown tokens are dropped), and accent contrast follows the derived pair.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  changedKeys,
  changedPatch,
  changedValueCount,
  isDirty,
  sectionChangedKeys,
  sectionIsDirty,
  deepEqual,
  NON_EDITABLE_KEYS,
  SECTION_KEYS,
} from '../settings-dirty';
import {
  applyTokens,
  clearTokens,
  ALLOWED_TOKENS,
} from '../../theme-tokens';
import { accentContrastAdvisory, contrastRatio } from '../../components/branding.api';

/* ------------------------------------------------------ changed values ---- */

describe('changedValueCount (the save bar counts values, as the audit log does)', () => {
  const chat = {
    max_parallel: 12,
    tool_timeout_s: 45,
    model_call_timeout_s: 900,
    max_concurrent_turns_per_user: 12,
    max_concurrent_turns_global: 48,
    internal_domains: ['corp.example'],
  };

  it('counts five edited fields of one section as five changes, not one', () => {
    const saved = { chat_agent: chat, sources: [] };
    const draft = {
      chat_agent: {
        ...chat,
        max_parallel: 20,
        tool_timeout_s: 60,
        model_call_timeout_s: 1200,
        max_concurrent_turns_per_user: 20,
        max_concurrent_turns_global: 80,
      },
      sources: [],
    };
    expect(changedKeys(draft, saved).size).toBe(1);
    expect(changedValueCount(draft, saved)).toBe(5);
  });

  it('is zero for an identical draft and for a draft with no saved snapshot', () => {
    expect(changedValueCount({ chat_agent: chat }, { chat_agent: { ...chat } })).toBe(0);
    expect(changedValueCount({ chat_agent: chat }, null)).toBe(0);
  });

  it('adds the values changed under every top-level key', () => {
    const saved = { chat_agent: chat, severity_threshold: 3 };
    const draft = { chat_agent: { ...chat, tool_timeout_s: 60 }, severity_threshold: 5 };
    expect(changedValueCount(draft, saved)).toBe(2);
  });

  it('treats a plain list as one value and a list of named items item by item', () => {
    // A plain list (no id or name): one value, however many entries changed.
    expect(
      changedValueCount(
        { chat_agent: { ...chat, internal_domains: ['a.example', 'b.example'] } },
        { chat_agent: chat },
      ),
    ).toBe(1);
    // Items keyed by `id`: each changed field of each item counts, like `channels[pd].type`.
    const channels = [
      { id: 'pd', type: 'pagerduty', enabled: true },
      { id: 'mail', type: 'email', enabled: true },
    ];
    expect(
      changedValueCount(
        {
          notifications: {
            channels: [
              { id: 'pd', type: 'pagerduty', enabled: false },
              { id: 'mail', type: 'smtp', enabled: false },
            ],
          },
        },
        { notifications: { channels } },
      ),
    ).toBe(3);
  });

  it('counts a keyed list that starts empty through its items only', () => {
    const draft = { notifications: { channels: [{ id: 'pd', type: 'pagerduty' }] } };
    const saved = { notifications: { channels: [] } };
    // `channels[pd].id` and `channels[pd].type`, never an extra entry for the list itself.
    expect(changedValueCount(draft, saved)).toBe(2);
  });

  it('leaves out bookkeeping stamps but still counts a changed key at least once', () => {
    const saved = { branding: { org_name: 'Acme', updated_at: '2026-01-01' } };
    expect(
      changedValueCount({ branding: { org_name: 'Acme SOC', updated_at: '2026-02-02' } }, saved),
    ).toBe(1);
    // Only the stamp moved: the key still differs, so the bar never reads zero.
    expect(changedValueCount({ branding: { org_name: 'Acme', updated_at: '2026-02-02' } }, saved)).toBe(1);
  });

  it('never counts the non-editable keys', () => {
    expect(changedValueCount({ sources: [{ id: 'x' }], setup_complete: false }, { sources: [], setup_complete: true })).toBe(0);
  });
});

/* ------------------------------------------------------------ dirty map ---- */

describe('per-section dirty map', () => {
  const saved = {
    data_view_pattern: 'logs-*',
    severity_threshold: 5,
    risk_weights: { volume: 0.5, velocity: 0.3 },
    enrichment: { enabled: true, cache_ttl_seconds: 60 },
    sources: [{ id: 's1' }],
    setup_complete: true,
  };

  it('reports NO changed keys for an identical (deep-equal) draft', () => {
    const draft = JSON.parse(JSON.stringify(saved));
    expect(changedKeys(draft, saved).size).toBe(0);
    expect(isDirty(draft, saved)).toBe(false);
  });

  it('detects a scalar edit and includes only that key', () => {
    const draft = { ...saved, severity_threshold: 7 };
    const ch = changedKeys(draft, saved);
    expect(ch.has('severity_threshold')).toBe(true);
    expect(ch.size).toBe(1);
    expect(isDirty(draft, saved)).toBe(true);
  });

  it('detects a nested-object edit by structural (deep) comparison', () => {
    const draft = { ...saved, risk_weights: { volume: 0.6, velocity: 0.3 } };
    const ch = changedKeys(draft, saved);
    expect(ch.has('risk_weights')).toBe(true);
    expect(ch.has('enrichment')).toBe(false);
  });

  it('NEVER treats sources / setup_complete as editable, even when they differ', () => {
    const draft = { ...saved, sources: [{ id: 's2' }], setup_complete: false };
    const ch = changedKeys(draft, saved);
    expect(ch.has('sources')).toBe(false);
    expect(ch.has('setup_complete')).toBe(false);
    expect(ch.size).toBe(0);
    expect(NON_EDITABLE_KEYS.has('sources')).toBe(true);
    expect(NON_EDITABLE_KEYS.has('setup_complete')).toBe(true);
  });

  it('builds a MINIMAL save patch of only the changed keys (no whole-object dump)', () => {
    const draft = {
      ...saved,
      severity_threshold: 9,
      enrichment: { enabled: false, cache_ttl_seconds: 60 },
    };
    const patch = changedPatch(draft, saved);
    expect(Object.keys(patch).sort()).toEqual(['enrichment', 'severity_threshold']);
    expect(patch.severity_threshold).toBe(9);
    // The unchanged keys (and the non-editable ones) are absent from the patch.
    expect('data_view_pattern' in patch).toBe(false);
    expect('sources' in patch).toBe(false);
    expect('setup_complete' in patch).toBe(false);
  });

  it('drops a key changed to `undefined` from the patch (nothing to send)', () => {
    const draft = { ...saved, severity_threshold: undefined as unknown as number };
    const ch = changedKeys(draft, saved);
    expect(ch.has('severity_threshold')).toBe(true); // it IS a change…
    const patch = changedPatch(draft, saved);
    expect('severity_threshold' in patch).toBe(false); // …but not serialisable
  });

  it('lights a section dot only for the OWNING section', () => {
    const draft = { ...saved, severity_threshold: 7 }; // owned by `general`
    const ch = changedKeys(draft, saved);
    expect(sectionIsDirty('general', ch)).toBe(true);
    expect(sectionIsDirty('models', ch)).toBe(false);
    expect(sectionChangedKeys('general', ch)).toContain('severity_threshold');
    expect(sectionChangedKeys('models', ch)).toEqual([]);
  });

  it('tracks the live `auto_close` policy block on the detection section (Round-5 R1)', () => {
    // The auto-close editor writes `prefs.auto_close` (the field decide() reads). The
    // detection section must OWN that key so an edit lights the dot + rides the patch —
    // alongside the legacy `fp_auto_close` scalar (kept for the migrate path).
    expect(SECTION_KEYS.detection).toContain('auto_close');
    expect(SECTION_KEYS.detection).toContain('fp_auto_close');

    const savedAc = { ...saved, auto_close: { false_positive: { enabled: false } } };
    const draftAc = { ...saved, auto_close: { false_positive: { enabled: true } } };
    const ch = changedKeys(draftAc, savedAc);
    expect(ch.has('auto_close')).toBe(true);
    expect(sectionIsDirty('detection', ch)).toBe(true);
    expect(sectionChangedKeys('detection', ch)).toContain('auto_close');
    // Only that key rides the minimal PUT patch.
    const patch = changedPatch(draftAc, savedAc);
    expect(Object.keys(patch)).toEqual(['auto_close']);
  });

  it('lights BOTH sections that share an owned key (e.g. rag)', () => {
    const draft = { ...saved, rag: { enabled: false } };
    const savedWithRag = { ...saved, rag: { enabled: true } };
    const ch = changedKeys(draft, savedWithRag);
    expect(SECTION_KEYS.knowledge).toContain('rag');
    expect(SECTION_KEYS.advanced).toContain('rag');
    expect(sectionIsDirty('knowledge', ch)).toBe(true);
    expect(sectionIsDirty('advanced', ch)).toBe(true);
  });

  it('is null-safe (no draft / no saved → not dirty, empty patch)', () => {
    expect(changedKeys(null, saved).size).toBe(0);
    expect(changedKeys(saved, null).size).toBe(0);
    expect(changedPatch(null, saved)).toEqual({});
    expect(isDirty(null, null)).toBe(false);
  });

  it('deepEqual handles arrays + nested objects + order', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: { x: 1 } }, { a: { x: 2 } })).toBe(false);
  });
});

/* ------------------------------------------------- bounded token preview --- */

function freshRoot(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/**
 * Mirror the editor's bounded-token preview pipeline: layout tokens route through
 * `applyTokens`; semantic, unsafe, and unknown tokens are dropped. We assert the same
 * guarantees the editor relies on.
 */
describe('bounded ThemeTokens preview (#9/#10)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = freshRoot();
  });

  it('applies a layout token and ignores a semantic fill override compatibly', () => {
    const written = applyTokens({ '--radius': '0.5rem', '--critical': '0 80% 50%' }, root);
    expect(written).toEqual(['--radius']);
    expect(root.style.getPropertyValue('--radius')).toBe('0.5rem');
    expect(root.style.getPropertyValue('--critical')).toBe('');
    expect(ALLOWED_TOKENS.has('--critical')).toBe(false);
  });

  it('maps the display-font enum key to a vetted stack (and drops an arbitrary one)', () => {
    applyTokens({ '--font-display': 'inter' }, root);
    expect(root.style.getPropertyValue('--font-display')).toContain('Inter');
    // An arbitrary (non-allow-listed) font value is rejected.
    const root2 = freshRoot();
    const written = applyTokens({ '--font-display': 'Comic Sans, cursive' }, root2);
    expect(written).toEqual([]);
    expect(root2.style.getPropertyValue('--font-display')).toBe('');
  });

  it('DROPS an unsafe value (cannot inject CSS / break out of the declaration)', () => {
    const written = applyTokens(
      { '--critical': 'red; } body { display:none' as string },
      root,
    );
    expect(written).toEqual([]);
    expect(root.style.getPropertyValue('--critical')).toBe('');
  });

  it('DROPS a non-allow-listed token name entirely', () => {
    const written = applyTokens({ '--evil-token': '0 0% 0%' }, root);
    expect(written).toEqual([]);
  });

  it('clearTokens removes a previously-applied token (reset path)', () => {
    applyTokens({ '--radius': '0.5rem' }, root);
    expect(root.style.getPropertyValue('--radius')).toBe('0.5rem');
    clearTokens(['--radius'], root);
    expect(root.style.getPropertyValue('--radius')).toBe('');
  });
});

/* --------------------------------------------------- WCAG accent advisory -- */

describe('WCAG-AA accent contrast advisory', () => {
  it('returns null for a blank accent (built-in accent is pre-vetted)', () => {
    expect(accentContrastAdvisory('')).toBeNull();
  });

  it('returns null for a dark accent that clears the 4.5:1 bar', () => {
    // Near-black: white text contrast is ~21:1.
    expect(accentContrastAdvisory('#111827')).toBeNull();
  });

  it('accepts a light accent because runtime derives the stronger black foreground', () => {
    expect(accentContrastAdvisory('#fde047')).toBeNull();
    expect(contrastRatio('#000000', '#fde047')).toBeGreaterThan(4.5);
  });

  it('accepts a mid accent after selecting the stronger black/white pair', () => {
    expect(accentContrastAdvisory('#3b82f6')).toBeNull();
    expect(
      Math.max(
        contrastRatio('#ffffff', '#3b82f6') ?? 0,
        contrastRatio('#000000', '#3b82f6') ?? 0,
      ),
    ).toBeGreaterThan(4.5);
  });

  it('contrastRatio is symmetric and within [1, 21]', () => {
    const a = contrastRatio('#ffffff', '#000000');
    const b = contrastRatio('#000000', '#ffffff');
    expect(a).toBeCloseTo(21, 0);
    expect(a).toBeCloseTo(b ?? 0, 5);
    expect(contrastRatio('not-a-hex', '#000')).toBeNull();
  });
});
