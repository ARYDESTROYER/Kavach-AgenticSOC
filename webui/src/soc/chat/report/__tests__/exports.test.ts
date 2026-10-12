/**
 * Report exports (chat revamp SPEC §9.3, BLOCKS.md §7 + amendments 8 and 9): Markdown and
 * HTML are deterministic string serialisers over the same document nodes; HTML carries
 * the exact CSP and no script, image or external link from data; IOCs are defanged by
 * default (never in JSON or CSV); CSV defuses formulas in string cells only.
 */
import { describe, expect, it } from 'vitest';

import { buildConversationDoc, buildReportDoc, sourceTurnsFromConversation } from '../model';
import { markdownFromAst, mdCode, mdText, reportToMarkdown } from '../export/markdown';
import { REPORT_CSP, REPORT_CSS, esc, htmlFromAst, reportToHtml } from '../export/html';
import { blockToCsv, reportTablesCsv } from '../export/csv';
import { reportToJson } from '../export/json';
import { conversationToHtml, conversationToMarkdown } from '../export/conversation';
import { attackUrl, documentNodes } from '../export/walker';
import { parseChatMarkdown } from '../../ChatMarkdown';
import { parseBlock } from '../../blocks/schema';
import { NOW, calendarChartRaw, calendarReport, rawBlock, sampleConversation, sampleReport } from './fixtures';
import { LIMITS } from '../../blocks/schema';

const LIMITS_TITLE = LIMITS.title;

const build = (defangTurns = true) =>
  buildReportDoc(sampleReport(), {
    author: 'ana',
    appVersion: '0.1.13',
    generatedAt: NOW.toISOString(),
    sourceTurns: defangTurns ? sourceTurnsFromConversation(sampleConversation()) : null,
  });

describe('Markdown export', () => {
  it('is deterministic for the same inputs', () => {
    expect(reportToMarkdown(build())).toBe(reportToMarkdown(build()));
  });

  it('carries the header, AI notice, items with notes, methodology and appendix', () => {
    const md = reportToMarkdown(build());
    expect(md.startsWith('# Brute force on vpn-gw-2\n')).toBe(true);
    expect(md).toContain('_Generated 2026-10-08 14:05 UTC · Author: ana · Agentic SOC v0.1.13 · Template: Investigation_');
    expect(md).toContain('> **AI-written summary:** AI-generated; verify before acting.');
    expect(md).toContain('> **Out of date:**');
    expect(md).toContain('## Findings');
    expect(md).toContain('### 1. Who is failing logins against vpn-gw-2?');
    expect(md).toContain('> **Analyst note:** Escalate to the network team.\\\n> Check the VPN logs.');
    expect(md).toContain('## Methodology & limitations');
    expect(md).toContain('## Appendix: queries');
    expect(md).toContain('```esql');
  });

  it('defangs IOCs by default and keeps them raw when the toggle is off', () => {
    const on = reportToMarkdown(build());
    expect(on).toContain('`203[.]0[.]113[.]10`');
    expect(on).toContain('hxxp://evil\\[.\\]example/x');
    expect(on).not.toMatch(/https?:\/\/evil/);
    const off = reportToMarkdown(build(), { defang: false });
    expect(off).toContain('`203.0.113.10`');
    // A model-written external URL is a code span, never a live link.
    expect(off).toContain('`http://evil.example/x`');
    expect(off).not.toMatch(/\]\(http:\/\/evil/);
  });

  it('never turns model text into an image, a link or raw HTML', () => {
    const md = reportToMarkdown(build(), { defang: false });
    expect(md).not.toContain('![img](');
    expect(md).toContain('\\!\\[img\\]');
    expect(md).not.toContain('<script>');
    expect(md).toContain('&lt;script&gt;');
    // The Help Center link is text plus its path (a relative path does not resolve offline).
    expect(md).toContain('docs (Help Center `/docs/0.1/analyst/chat/`)');
    // The only link: an ATT&CK page constructed from a validated id.
    const links = md.match(/\]\((https?:[^)]*)\)/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toMatch(/^\]\(https:\/\/attack\.mitre\.org\/techniques\/T\d{4}\/(\d{3}\/)?\)$/);
  });

  it('puts untrusted cells in fence-safe code spans and escapes table pipes', () => {
    expect(mdCode('a`b')).toBe('``a`b``');
    expect(mdCode('`x`')).toBe('`` `x` ``');
    expect(mdCode('a|b', true)).toBe('`a\\|b`');
    expect(mdText('[x](y) | <b> & *z*')).toBe('\\[x\\](y) \\| &lt;b&gt; & \\*z\\*');
    const md = reportToMarkdown(build());
    expect(md).toContain('`=HYPERLINK("hxxp://evil[.]example","click")`');
  });

  it('nests answer headings by rank, never skipping a level', () => {
    const blocks = parseChatMarkdown('#### Deep start\n\ntext\n\n###### deeper\n\n## shallow');
    const md = markdownFromAst(blocks, 4);
    expect(md).toContain('#### Deep start');
    expect(md).toContain('##### deeper');
    expect(md).toContain('#### shallow');
    expect(md).not.toContain('######');
  });
});

describe('KPI tables carry the tile\'s change', () => {
  it('adds a Change column only when a figure has a delta, in the tile\'s words', () => {
    const md = reportToMarkdown(build(), { defang: false });
    expect(md).toContain('| Metric | Value | Change | Context |');
    expect(md).toMatch(/\| Alerts ingested \| 12,840 \| \+1,960 vs prev 24h \|/);
    const brief = reportToMarkdown(
      buildReportDoc(sampleReport({ items: [{ ...sampleReport().items[1], block: rawBlock('shift-brief') }], summary: null }), { generatedAt: NOW.toISOString() }),
      { defang: false },
    );
    // The Brief's KPI group has no deltas: no empty Change column.
    expect(brief).toContain('| Metric | Value | Context |');
    expect(brief).not.toContain('| Change |');
  });
});

describe('Markdown escaping is safe but not noisy (R14)', () => {
  it('keeps a plain ampersand and parentheses readable', () => {
    expect(mdText('Network & Linux')).toBe('Network & Linux');
    expect(mdText('(unassigned)')).toBe('(unassigned)');
    expect(mdText('Lookups (2 calls)')).toBe('Lookups (2 calls)');
  });

  it('still escapes what could become markup, a link, an image or an entity', () => {
    expect(mdText('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mdText('[x](javascript:alert(1))')).toBe('\\[x\\](javascript:alert(1))');
    expect(mdText('![img](http://e/p.png)')).toBe('\\!\\[img\\](http://e/p.png)');
    expect(mdText('wow!')).toBe('wow!');
    // An ampersand that would start a character reference stays literal text.
    // (`#` is already escaped, so `&\\#60;` can no longer read as a numeric reference.)
    expect(mdText('&amp; &#60; &lt;')).toBe('&amp;amp; &\\#60; &amp;lt;');
    expect(mdText('*a* _b_ `c` | ~d~ #e')).toBe('\\*a\\* \\_b\\_ \\`c\\` \\| \\~d\\~ \\#e');
  });

  it('round-trips a source name with "&" through the whole document', () => {
    const report = sampleReport({ title: 'Network & Linux (weekly)' });
    const md = reportToMarkdown(buildReportDoc(report, { generatedAt: NOW.toISOString() }), { defang: false });
    expect(md.startsWith('# Network & Linux (weekly)\n')).toBe(true);
    expect(md).not.toContain('&amp;');
    expect(md).not.toContain('\\(');
  });
});

describe('Markdown structure guards', () => {
  it('keeps note and callout lines from becoming lists, headings or code', () => {
    const report = sampleReport({
      items: [{ ...sampleReport().items[1], note: 'First line\n---\n- not a list\n1. not numbered\n    not code\n===' }],
    });
    const md = reportToMarkdown(buildReportDoc(report, { generatedAt: NOW.toISOString() }));
    expect(md).toContain('> **Analyst note:** First line\\\n> \\---\\\n> \\- not a list\\\n> 1\\. not numbered\\\n> not code\\\n> \\===');
  });

  it('never lets a paragraph of dashes become a thematic break', () => {
    const report = sampleReport({
      items: [{ ...sampleReport().items[0], block: { title: 'Q', blocks: [{ id: 'c', type: 'callout', provenance: 'ai', tone: 'info', text: 'Look\n---\n- x' }], truncated: false } }],
      summary: null,
    });
    const md = reportToMarkdown(buildReportDoc(report, { generatedAt: NOW.toISOString() }));
    expect(md).not.toMatch(/^> ---$/m);
    expect(md).not.toMatch(/^> - x$/m);
  });
});

describe('HTML export', () => {
  it('defangs the document title like the heading', () => {
    const report = sampleReport({ title: 'Activity from evil.example.com' });
    const html = reportToHtml(buildReportDoc(report, { generatedAt: NOW.toISOString() }));
    expect(html).toContain('<title>Activity from evil[.]example[.]com</title>');
    const raw = reportToHtml(buildReportDoc(report, { generatedAt: NOW.toISOString() }), { defang: false });
    expect(raw).toContain('<title>Activity from evil.example.com</title>');
  });

  it('pins the exact CSP of BLOCKS.md amendment 8 and inline light tokens', () => {
    const html = reportToHtml(build());
    expect(REPORT_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('--background:240 20% 99%;');
    expect(html).toContain('@page{size:A4');
  });

  it("keeps a heading's meta line with what follows when printed", () => {
    const html = reportToHtml(build());
    // Every item heading is followed by its meta line ("Answer · Window …"): printed from
    // a browser, neither may be left alone at the bottom of a page.
    expect(html).toMatch(/<h3>[^<]*<\/h3>\s*<p class="meta">/);
    const print = /@media print\{([^]*)\}$/m.exec(REPORT_CSS)?.[1] ?? '';
    expect(print).toMatch(/h6,:is\(h1,h2,h3,h4,h5,h6\)\+\.meta\{break-after:avoid\}/);
  });

  it('carries no script, image, form or external link from data', () => {
    const html = reportToHtml(build(), { defang: false });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<form|<iframe|<object|<embed|<link\b/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    const anchors = html.match(/<a\s[^>]*>/g) ?? [];
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(a).toMatch(/^<a href="https:\/\/attack\.mitre\.org\/techniques\/T\d{4}\/(\d{3}\/)?" rel="noopener noreferrer">$/);
    // The model's raw HTML is escaped text.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<code>http://evil.example/x</code>');
  });

  it('defangs by default and is deterministic', () => {
    const html = reportToHtml(build());
    expect(html).toContain('203[.]0[.]113[.]14');
    expect(html).not.toContain('203.0.113.14');
    expect(html).toBe(reportToHtml(build()));
  });

  it('escapes every text and renders the AST without markup from the model', () => {
    expect(esc(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    const html = htmlFromAst(parseChatMarkdown('**bold** [x](javascript:alert(1)) <img src=x onerror=1>'), 3, true);
    expect(html).not.toMatch(/<a |<img/);
    expect(html).toContain('<strong>bold</strong>');
  });
});

describe('CSV and JSON exports', () => {
  it('exports every table-like block, labelled, with string cells defused and numbers raw', () => {
    const csv = reportTablesCsv(build())!;
    expect(csv).toContain(`"# 2. Recent sign-in failures"`);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    // CSV is a data format: never defanged.
    expect(csv).toContain('"203.0.113.10"');
    // Numeric cells stay numeric (the Attempts column), null stays empty.
    const signins = csv.split('\r\n\r\n').find((part) => part.includes('Recent sign-in failures'))!;
    const firstRow = signins.split('\r\n')[2].split(',');
    expect(firstRow[5]).toMatch(/^\d+$/);
  });

  it('carries a KPI\'s lower bound and change, like the tiles, the PDF and Word', () => {
    const raw = rawBlock('kpis') as { items: Array<Record<string, unknown>> };
    raw.items[2] = { ...raw.items[2], delta: { value: -4.5, period_label: 'vs prev 24h', good_direction: 'down' } };
    const csv = blockToCsv(parseBlock(raw))!;
    const [head, ...rows] = csv.split('\r\n');
    expect(head).toBe('"Metric","Value","Unit","Context","Bound","Change","Change period"');
    // A scan-bounded count is marked, never read as exact; the change is a signed number.
    expect(rows.find((r) => r.startsWith('"Open cases"'))).toBe('"Open cases",43,"count","scan bounded","at least",,');
    expect(rows.find((r) => r.startsWith('"Alerts ingested"'))).toBe('"Alerts ingested",12840,"count",,,1960,"vs prev 24h"');
    // A negative change stays a number (not a defused string).
    expect(rows.find((r) => r.startsWith('"False positive rate"'))).toBe('"False positive rate",18.4,"percent","of 112 verdicted",,-4.5,"vs prev 24h"');
    // The report-wide CSV uses the same projection.
    const report = reportTablesCsv(build())!;
    expect(report).toContain('"Metric","Value","Unit","Context","Bound","Change","Change period"');
    expect(report).toContain('"Open cases",43,"count","scan bounded","at least",,');
  });

  it('keeps a KPI table without bounds or changes to its four columns', () => {
    const raw = rawBlock('kpis') as { items: Array<Record<string, unknown>> };
    const plain = { ...raw, items: raw.items.map(({ delta: _d, bound: _b, ...rest }) => rest) };
    expect(blockToCsv(parseBlock(plain))!.split('\r\n')[0]).toBe('"Metric","Value","Unit","Context"');
  });

  it('exports one block as CSV and returns null for prose', () => {
    expect(blockToCsv(parseBlock(rawBlock('kpis')))).toContain('"Metric","Value","Unit","Context"');
    expect(blockToCsv(parseBlock(rawBlock('note')))).toBeNull();
  });

  it('writes the report exactly as received, never defanged', () => {
    const report = sampleReport();
    const json = reportToJson(report);
    expect(JSON.parse(json)).toEqual({ blocks_version: 1, report });
    expect(json).toContain('203.0.113.14');
    expect(json).not.toContain('[.]');
  });
});

describe('document nodes', () => {
  it('turns charts into data tables with a kind/unit note', () => {
    const nodes = documentNodes(build(), { defang: false });
    const tableIndex = nodes.findIndex((n) => n.k === 'table' && n.head[1] === 'Wazuh');
    expect(tableIndex).toBeGreaterThan(-1);
    const table = nodes[tableIndex];
    expect(table.k === 'table' && table.rows.some((r) => r.includes('—'))).toBe(true);
    // The kind/unit note is the table's own caption (HTML <caption>, Word caption, sheet row 2).
    expect(table.k === 'table' && table.caption).toBe('Chart: stacked columns, unit: count.');
    expect(table.k === 'table' && table.label).toBeTruthy();
    // Raw numbers ride along for spreadsheets; not-measured stays null (never 0).
    expect(table.k === 'table' && table.values?.some((r) => r.some((v) => typeof v === 'number'))).toBe(true);
    expect(table.k === 'table' && table.units?.[1]).toBe('count');
    const md = reportToMarkdown(build(), { defang: false });
    expect(md).toContain('_Chart: stacked columns, unit: count._');
    expect(reportToHtml(build(), { defang: false })).toContain('<caption>Chart: stacked columns, unit: count.</caption>');
  });

  it('reads a calendar axis as the screen, the CSV and the print do (periods, zone, in progress)', () => {
    const d = buildReportDoc(calendarReport(), { generatedAt: NOW.toISOString() });
    const node = documentNodes(d, { defang: false }).find((n) => n.k === 'table');
    expect(node?.k === 'table' && node.head).toEqual(['Period (Asia/Kolkata)', 'Cases']);
    expect(node?.k === 'table' && node.rows).toEqual([
      ['Sep 2026 (from 12 Sep)', '2'],
      ['Oct 2026 (in progress)', '72'],
    ]);
    // The document's x column is the CSV's x column, cell for cell.
    const csv = blockToCsv(parseBlock(calendarChartRaw()))!.split('\r\n');
    expect(csv).toEqual(['"Period (Asia/Kolkata)","Cases"', '"Sep 2026 (from 12 Sep)",2', '"Oct 2026 (in progress)",72']);
    const md = reportToMarkdown(d);
    expect(md).toContain('| Period (Asia/Kolkata) | Cases |');
    expect(md).toContain('| Sep 2026 (from 12 Sep) | 2 |');
    expect(md).toContain('| Oct 2026 (in progress) | 72 |');
    const html = reportToHtml(d);
    expect(html).toContain('Period (Asia/Kolkata)');
    expect(html).toContain('Sep 2026 (from 12 Sep)');
    expect(html).toContain('Oct 2026 (in progress)');
    // Never the UTC bucket start (local midnight in Kolkata is 18:30 UTC the day before,
    // so September would read as August).
    for (const text of [md, html]) {
      expect(text).not.toContain('2026-08-31 18:30 UTC');
      expect(text).not.toContain('Time (UTC)');
    }
  });

  it('keeps a plain time axis in readable UTC and marks its still-filling bucket like the chart', () => {
    const table = documentNodes(build(), { defang: false }).find((n) => n.k === 'table' && n.head[1] === 'Wazuh');
    expect(table?.k === 'table' && table.head[0]).toBe('Time (UTC)');
    const xs = table?.k === 'table' ? table.rows.map((r) => r[0]) : [];
    expect(xs.length).toBeGreaterThan(1);
    for (const x of xs.slice(0, -1)) expect(x).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(xs[xs.length - 1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(in progress\)$/);
  });

  it('builds ATT&CK links only from validated technique ids', () => {
    expect(attackUrl('T1059.001')).toBe('https://attack.mitre.org/techniques/T1059/001/');
    expect(attackUrl('T1110')).toBe('https://attack.mitre.org/techniques/T1110/');
    expect(attackUrl('T1059/../../x')).toBeNull();
    expect(attackUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('conversation export', () => {
  it('serialises each exchange through the same document model', () => {
    const md = conversationToMarkdown(sampleConversation(), { now: NOW, author: 'ana' });
    expect(md.startsWith('# VPN brute force\n')).toBe(true);
    expect(md).toContain('## Conversation');
    expect(md).toContain('### 1. Who is failing logins against vpn-gw-2?');
    expect(md).toContain('#### Recent sign-in failures');
    expect(md).toContain('## Methodology & limitations');
    expect(md).toContain('Lookups (2 calls): Counted log events; Searched cases.');
    expect(md).toContain('## Appendix: queries');
    expect(md).toContain('hxxp://evil\\[.\\]example/login');
    expect(md).toBe(conversationToMarkdown(sampleConversation(), { now: NOW, author: 'ana' }));
  });

  it('writes a calendar chart in its periods, like a report export', () => {
    const conversation = sampleConversation();
    conversation.messages[1].response = { ...conversation.messages[1].response!, blocks: [calendarChartRaw()] };
    const md = conversationToMarkdown(conversation, { now: NOW });
    expect(md).toContain('| Period (Asia/Kolkata) | Cases |');
    expect(md).toContain('| Oct 2026 (in progress) | 72 |');
    const html = conversationToHtml(conversation, { now: NOW });
    expect(html).toContain('Sep 2026 (from 12 Sep)');
    for (const text of [md, html]) expect(text).not.toContain('2026-08-31 18:30 UTC');
  });

  it('writes HTML with the same CSP', () => {
    const html = conversationToHtml(sampleConversation(), { now: NOW });
    expect(html).toContain(REPORT_CSP);
    expect(html).not.toMatch(/<script|<img/i);
  });

  it('quotes a long prompt in full and keeps an unanswered last prompt', () => {
    const conversation = sampleConversation();
    const long = `${'Why did vpn-gw-2 see so many failures '.repeat(5)}\nand from where?`;
    conversation.messages[0] = { ...conversation.messages[0], content: long };
    conversation.messages.push({ id: 'msg-3', role: 'user', content: 'And yesterday?', created_at: '2026-10-08T12:01:00Z' });
    const doc = buildConversationDoc(conversation, { generatedAt: NOW.toISOString() });
    expect(doc.items).toHaveLength(2);
    expect(doc.items[0].title.length).toBeLessThanOrEqual(LIMITS_TITLE);
    expect(doc.items[0].question).toContain('and from where?');
    expect(doc.items[1].title).toBe('And yesterday?');
    expect(doc.items[1].blocks.some((b) => b.type === 'callout' && b.text === 'No answer was saved for this question.')).toBe(true);
    const md = conversationToMarkdown(conversation, { now: NOW });
    expect(md).toContain('> **Question:**');
    expect(md).toContain('No answer was saved for this question.');
  });

  it('does not report an empty block as a display failure (it is silently omitted)', () => {
    const conversation = sampleConversation();
    conversation.messages[1].response = {
      ...conversation.messages[1].response!,
      blocks: [{ ...rawBlock('signins'), rows: [] }, rawBlock('lookup-query')],
    };
    const doc = buildConversationDoc(conversation, { generatedAt: NOW.toISOString() });
    expect(doc.items[0].dropped).toBe(0);
    expect(doc.items[0].blocks.some((b) => b.type === 'table')).toBe(false);
    expect(doc.methodology.some((l) => l.includes('not displayable'))).toBe(false);
    const md = conversationToMarkdown(conversation, { now: NOW });
    expect(md).not.toContain('not displayable');
    expect(md).not.toContain('Recent sign-in failures');
  });

  it('keeps an empty block item titled and says the lookup found nothing', () => {
    const report = sampleReport({
      items: [{ ...sampleReport().items[1], block: { ...rawBlock('signins'), rows: [] } }],
      summary: null,
    });
    const md = reportToMarkdown(buildReportDoc(report, { generatedAt: NOW.toISOString() }));
    expect(md).toContain('## 1. Recent sign-in failures');
    expect(md).toContain('Table · Window: last 24h');
    expect(md).toContain('The lookup found nothing.');
    expect(md).not.toContain('not displayable');
  });

  it('keeps a stopped or failed turn visible as a notice', () => {
    const conversation = sampleConversation();
    conversation.messages[1].response = {
      ...conversation.messages[1].response!,
      notice: { kind: 'cancelled', message: 'Stopped before the answer was complete', retryable: false },
    };
    const doc = buildConversationDoc(conversation, { generatedAt: NOW.toISOString() });
    expect(doc.items[0].blocks.some((b) => b.type === 'callout' && b.text.includes('Stopped'))).toBe(true);
  });
});
