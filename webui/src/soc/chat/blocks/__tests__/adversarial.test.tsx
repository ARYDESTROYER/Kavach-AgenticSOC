/**
 * Hostile blocks end to end: raw wire input → `parseBlocks()` → `AnswerBlocks`. A model,
 * a log line or a tampered saved report controls every string here, so the rendered DOM
 * must hold only text nodes (G1), every href must come from a typed, validated ref or the
 * constructed ATT&CK pattern (G2), no block string may reach a style, class or DOM id
 * (G2), invisible/bidi characters are stripped (G7), non-finite numbers are "not
 * measured" rather than 0 (G3), oversized input is clamped and disclosed (G4, G8) and an
 * unknown block degrades to the quiet fallback without blanking the message (G9).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => () => undefined }));

import AnswerBlocks from '../AnswerBlocks';
import { parseBlocks } from '../schema';

const XSS = '<img src=x onerror=alert(1)><script>alert(2)</script>';
const STYLE = 'red;background:url(https://evil.example/beacon)';
const BIDI = 'adm‮in​⁦user';

function renderRaw(raw: unknown[]) {
  const { blocks, dropped } = parseBlocks(raw, { limit: 50 });
  const view = render(<AnswerBlocks blocks={blocks} messageId={'m"><x'} />);
  return { ...view, blocks, dropped };
}

const HOSTILE: unknown[] = [
  {
    id: '"><svg onload=alert(1)>',
    type: 'chart',
    kind: 'bar',
    title: XSS,
    caption: STYLE,
    provenance: 'source',
    artifact_kind: 'categories',
    allowed_views: ['bar', 'hbar', 'javascript:alert(1)'],
    untrusted: true,
    unit: 'count',
    x: { kind: 'category', values: [XSS, BIDI, STYLE] },
    series: [{ key: 's', label: XSS, semantic: STYLE, values: [Infinity, Number.NaN, 5] }],
    drill: [{ page: 'javascript:alert(1)' }, { page: 'cases', opts: { caseId: '../../etc/passwd?x=<y>' } }, { page: 'cases', opts: { evil: 1 } }],
  },
  {
    id: 'g',
    type: 'guide',
    provenance: 'code',
    artifact_kind: 'guide',
    steps: [{ text: XSS }],
    links: [
      { label: 'js', ref: { doc: 'javascript:alert(1)' } },
      { label: 'ext', ref: { doc: 'https://evil.example/docs/0.1/x' } },
      { label: 'proto', ref: { page: 'settings', opts: { section: 'x" onmouseover="alert(1)' } } },
      { label: 'ok', ref: { page: 'settings', opts: { section: 'sources' } } },
    ],
  },
  {
    id: 't',
    type: 'table',
    provenance: 'source',
    artifact_kind: 'table',
    columns: Array.from({ length: 20 }, (_, i) => ({ key: `c${i}`, label: i === 0 ? XSS : `col ${i}`, type: i === 0 ? 'case' : 'text', untrusted: true })),
    rows: Array.from({ length: 500 }, (_, r) => Array.from({ length: 20 }, (__, c) => (c === 0 ? 'javascript:alert(1)' : `${r}:${c} ${XSS}`))),
  },
  {
    id: 'm',
    type: 'mitre',
    provenance: 'code',
    artifact_kind: 'mitre',
    techniques: [{ id: 'T1059"/><script>' }, { id: 't1059.001', name: XSS }],
  },
  { id: 'u', type: 'iframe', src: 'https://evil.example', fallback_text: `Plain summary ${XSS}` },
  { id: 'c', type: 'citations', provenance: 'code', items: [{ n: 1, kind: 'log', label: XSS, ref: { page: 'logs' }, snippet: XSS }] },
];

describe('hostile blocks', () => {
  it('renders every string as text: no injected element, handler or script', () => {
    const { container } = renderRaw(HOSTILE);
    expect(container.querySelector('script, iframe, object, embed, img')).toBeNull();
    for (const el of Array.from(container.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.startsWith('on')).toBe(false);
      }
    }
    expect(screen.getAllByText(XSS, { exact: false }).length).toBeGreaterThan(0);
  });

  it('emits hrefs only from validated refs or the constructed ATT&CK pattern', () => {
    const { container } = renderRaw(HOSTILE);
    const hrefs = Array.from(container.querySelectorAll('[href]')).map((a) => a.getAttribute('href')!);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) {
      expect(h).toMatch(/^(#\/[a-z_]+(\?[A-Za-z0-9=&%._-]*)?|\/docs\/\d+\.\d+\/[a-z0-9/_-]+\/?|https:\/\/attack\.mitre\.org\/techniques\/T\d{4}\/(\d{3}\/)?)$/);
    }
    expect(hrefs).toContain('#/settings?s=sources');
    expect(hrefs).toContain('https://attack.mitre.org/techniques/T1059/001/');
    expect(hrefs.some((h) => h.includes('javascript') || h.includes('evil'))).toBe(false);
  });

  it('never lets a block string reach a style, class or DOM id', () => {
    const { container } = renderRaw(HOSTILE);
    for (const el of Array.from(container.querySelectorAll('*'))) {
      const style = el.getAttribute('style') ?? '';
      const cls = el.getAttribute('class') ?? '';
      const id = el.getAttribute('id') ?? '';
      for (const v of [style, cls, id]) {
        expect(v).not.toContain('evil');
        expect(v).not.toContain('<');
        expect(v).not.toContain('svg onload');
      }
    }
    // The message id is not a valid data value either, so it is dropped.
    expect(container.querySelector('[data-message-id]')).toBeNull();
  });

  it('strips bidi and zero-width characters from displayed labels (G7)', () => {
    const { container } = renderRaw(HOSTILE);
    expect(container.textContent).not.toMatch(/[‪-‮⁦-⁩​-‏]/);
    expect(container.textContent).toContain('adminuser');
  });

  it('treats non-finite numbers as not measured, never as 0 (G3)', () => {
    const { blocks, container } = renderRaw(HOSTILE);
    const chart = blocks[0];
    expect(chart.type === 'chart' && chart.series[0].values).toEqual([null, null, 5]);
    expect(container.querySelectorAll('[data-testid="chart-bar"] rect[data-state="unmeasured"]')).toHaveLength(2);
  });

  it('clamps oversized tables and discloses it (G4, G8)', () => {
    const { blocks } = renderRaw(HOSTILE);
    const table = blocks.find((b) => b.type === 'table');
    expect(table?.type === 'table' && table.columns.length).toBe(12);
    expect(table?.type === 'table' && table.rows.length).toBe(200);
    expect(screen.getAllByTestId('block-truncation').some((n) => n.textContent?.includes('200'))).toBe(true);
  });

  it('degrades an unknown block to the quiet fallback with its plain text (G9)', () => {
    const { dropped } = renderRaw(HOSTILE);
    expect(dropped.some((d) => d.reason === 'unknown_type')).toBe(true);
    const fb = screen.getAllByTestId('block-fallback').find((n) => n.textContent?.includes('Plain summary'));
    expect(fb).toBeDefined();
    // The rest of the message still rendered.
    expect(screen.getByTestId('block-guide')).toBeInTheDocument();
  });

  it('drops invalid refs (never renders them as links) and keeps log citations unlinked', () => {
    const { container, blocks } = renderRaw(HOSTILE);
    const guide = blocks.find((b) => b.type === 'guide');
    expect(guide?.type === 'guide' && guide.links.map((l) => l.label)).toEqual(['ok']);
    const chart = blocks[0];
    expect(chart.type === 'chart' && chart.drill).toBeUndefined();
    const cite = container.querySelector('[data-block-type="citations"] li');
    expect(cite?.querySelector('a')).toBeNull();
    expect(cite?.querySelector('pre')).not.toBeNull();
  });
});

describe('empty data blocks (D3)', () => {
  it('renders no empty shell for a block with no rows, points or items', () => {
    const empty = [
      { id: 'e1', type: 'table', provenance: 'source', artifact_kind: 'table', columns: [{ key: 'ip', label: 'IP' }], rows: [] },
      {
        id: 'e2',
        type: 'chart',
        kind: 'bar',
        unit: 'count',
        provenance: 'code',
        artifact_kind: 'categories',
        x: { kind: 'category', values: ['a', 'b'] },
        series: [{ key: 's', label: 'S', values: [null, Number.NaN] }],
      },
      { id: 'e3', type: 'timeline', provenance: 'source', artifact_kind: 'timeline', events: [] },
      { id: 'e4', type: 'case_list', provenance: 'source', artifact_kind: 'case_list', items: [] },
      { id: 'e5', type: 'mitre', provenance: 'source', artifact_kind: 'mitre', techniques: [] },
      { id: 'e6', type: 'markdown', provenance: 'ai', text: 'The search matched nothing in the last 24 hours.' },
    ];
    const { container, blocks, dropped } = renderRaw(empty);
    expect(blocks.map((b) => b.type)).toEqual(['markdown']);
    expect(dropped.map((d) => [d.type, d.reason])).toEqual([
      ['table', 'empty'],
      ['chart', 'empty'],
      ['timeline', 'empty'],
      ['case_list', 'empty'],
      ['mitre', 'empty'],
    ]);
    expect(screen.queryByText(/No values to show/)).toBeNull();
    expect(screen.queryByText(/No data points/)).toBeNull();
    // No fallback callout either: the prose carries it.
    expect(container.querySelectorAll('[data-block-type]')).toHaveLength(1);
    expect(screen.getByText('The search matched nothing in the last 24 hours.')).toBeInTheDocument();
  });
});
