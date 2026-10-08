/**
 * Report exports (chat revamp SPEC §9.3, BLOCKS.md §7 + amendments 8 and 9): Markdown and
 * HTML are deterministic string serialisers over the same document nodes; HTML carries
 * the exact CSP and no script, image or external link from data; IOCs are defanged by
 * default (never in JSON or CSV); CSV defuses formulas in string cells only.
 */
import { describe, expect, it } from 'vitest';

import { buildConversationDoc, buildReportDoc, sourceTurnsFromConversation } from '../model';
import { markdownFromAst, mdCode, mdText, reportToMarkdown } from '../export/markdown';
import { REPORT_CSP, esc, htmlFromAst, reportToHtml } from '../export/html';
import { blockToCsv, reportTablesCsv } from '../export/csv';
import { reportToJson } from '../export/json';
import { conversationToHtml, conversationToMarkdown } from '../export/conversation';
import { attackUrl, documentNodes } from '../export/walker';
import { parseChatMarkdown } from '../../ChatMarkdown';
import { parseBlock } from '../../blocks/schema';
import { NOW, rawBlock, sampleConversation, sampleReport } from './fixtures';

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
    expect(md).toContain('## Methodology &amp; limitations');
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
    expect(mdText('[x](y) | <b> & *z*')).toBe('\\[x\\]\\(y\\) \\| &lt;b&gt; &amp; \\*z\\*');
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

describe('HTML export', () => {
  it('pins the exact CSP of BLOCKS.md amendment 8 and inline light tokens', () => {
    const html = reportToHtml(build());
    expect(REPORT_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('--background:240 20% 99%;');
    expect(html).toContain('@page{size:A4');
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
    expect(nodes[tableIndex + 1]).toEqual({ k: 'meta', text: 'Chart: stacked columns, unit: count.' });
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
    expect(md).toContain('## Methodology &amp; limitations');
    expect(md).toContain('Lookups \\(2 calls\\): Counted log events; Searched cases.');
    expect(md).toContain('## Appendix: queries');
    expect(md).toContain('hxxp://evil\\[.\\]example/login');
    expect(md).toBe(conversationToMarkdown(sampleConversation(), { now: NOW, author: 'ana' }));
  });

  it('writes HTML with the same CSP', () => {
    const html = conversationToHtml(sampleConversation(), { now: NOW });
    expect(html).toContain(REPORT_CSP);
    expect(html).not.toMatch(/<script|<img/i);
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
