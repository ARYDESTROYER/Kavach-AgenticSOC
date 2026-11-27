/**
 * ChatMarkdown — the BLOCKS.md amendment 5 subset, with adversarial fixtures:
 * no <img>, no link to an external or in-app target written by the model, no raw
 * HTML, bidi/invisible characters stripped, defanged URLs with a copy button, docs
 * links only for `/docs/<major.minor>/…`, headings demoted under the message h3.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { axe, toHaveNoViolations } from 'jest-axe';

import { ChatMarkdown, parseChatMarkdown, parseInline } from '../ChatMarkdown';

expect.extend(toHaveNoViolations);

vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn(async () => true) }));
import { copyText } from '@/lib/clipboard';

function renderMd(text: string, props: Partial<React.ComponentProps<typeof ChatMarkdown>> = {}) {
  return render(<ChatMarkdown text={text} {...props} />);
}

const anchors = (container: HTMLElement) => Array.from(container.querySelectorAll('a'));

describe('ChatMarkdown — links and URLs', () => {
  it('links only a validated same-origin Help Center path, in a new tab', () => {
    const { container } = renderMd('Read [the chat guide](/docs/0.1/analyst/chat/#sources) first.');
    const links = anchors(container);
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/docs/0.1/analyst/chat/#sources');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    expect(links[0]).toHaveTextContent('the chat guide');
  });

  it('renders an external link target defanged with a copy button, never as a link', async () => {
    const { container } = renderMd('Click [here](https://evil.example.com/login) now.');
    expect(anchors(container)).toHaveLength(0);
    expect(container).toHaveTextContent('here hxxps://evil[.]example[.]com/login');
    fireEvent.click(screen.getByRole('button', { name: 'Copy defanged link' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('hxxps://evil[.]example[.]com/login'));
    expect(await screen.findByRole('button', { name: 'Copied defanged link' })).toBeInTheDocument();
  });

  it('never nests a docs link inside another docs link', () => {
    const { container } = renderMd('[[inner](/docs/0.1/a/) outer](/docs/0.1/b/)');
    const links = anchors(container);
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/docs/0.1/b/');
    expect(links[0]).toHaveTextContent('inner outer');
    expect(container.querySelector('a a')).toBeNull();
  });

  it('defangs a URL glued to a preceding word or digit', () => {
    const { container } = renderMd('Try foohttps://evil.example/x or 1http://c2.example now.');
    expect(anchors(container)).toHaveLength(0);
    expect(container).toHaveTextContent('Try foohxxps://evil[.]example/x or 1hxxp://c2[.]example now.');
    expect(container).not.toHaveTextContent('https://evil.example');
    expect(container).not.toHaveTextContent('http://c2.example');
    expect(screen.getAllByRole('button', { name: 'Copy defanged link' })).toHaveLength(2);
  });

  it('never nests a button inside a docs link', () => {
    const { container } = renderMd('[see https://x.example and [D1]](/docs/0.1/a/)', {
      citationIds: new Set(['D1']),
      onCitation: () => undefined,
    });
    const link = container.querySelector('a');
    expect(link).toHaveTextContent('see hxxps://x[.]example and [D1]');
    expect(link?.querySelector('button')).toBeNull();
  });

  it('defangs bare URLs in prose and leaves markers inside them literal', () => {
    const { container } = renderMd('Beacon to http://c2.example/*a*_b_ seen.');
    expect(anchors(container)).toHaveLength(0);
    expect(container.querySelector('em')).toBeNull();
    expect(container).toHaveTextContent('hxxp://c2[.]example/*a*_b_');
  });

  it('keeps model-written in-app paths and script URLs as literal text', () => {
    const fixtures = [
      '[Open cases](/cases?status=open)',
      '[Settings](#/settings?s=admin_users)',
      '[Case](app:cases?caseId=case-1)',
      '[x](javascript:alert(1))',
      '[x](data:text/html,<script>alert(1)</script>)',
      '[docs escape](/docs/0.1/../../admin)',
      '[relative](analyst/chat)',
    ];
    for (const text of fixtures) {
      const { container, unmount } = renderMd(text);
      expect(anchors(container)).toHaveLength(0);
      expect(container.textContent).toBe(text.replace(/<[^>]*>/g, (m) => m));
      unmount();
    }
  });

  it('never renders images, raw HTML, autolinks or reference links as elements', () => {
    const text = [
      '![logo](https://evil.example/pixel.png)',
      '<img src=x onerror=alert(1)> <script>alert(1)</script> <a href="https://evil.example">x</a>',
      '<https://auto.example/link>',
      '[ref link][1]',
      '',
      '[1]: https://ref.example/target',
    ].join('\n');
    const { container } = renderMd(text);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(anchors(container)).toHaveLength(0);
    expect(container).toHaveTextContent('![logo](hxxps://evil[.]example/pixel.png)');
    expect(container).toHaveTextContent('<script>alert(1)</script>');
    expect(container).toHaveTextContent('hxxps://auto[.]example/link');
    expect(container).toHaveTextContent('[ref link][1]');
  });
});

describe('ChatMarkdown — sanitisation', () => {
  it('strips bidi overrides, isolates, zero-width and control characters', () => {
    const { container } = renderMd('Run inv‮exe.txt⁦ now​ and \u0007bell');
    expect(container.textContent).toBe('Run invexe.txt now and bell');
    expect(container.textContent).not.toMatch(/[‪-‮⁦-⁩​\u0007]/u);
  });

  it('renders everything as text nodes (no injected markup)', () => {
    const { container } = renderMd('**<b onclick=alert(1)>bold</b>** `<i>x</i>`');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('i')).toBeNull();
    expect(container.querySelector('strong')).toHaveTextContent('<b onclick=alert(1)>bold</b>');
    expect(container.querySelector('code')).toHaveTextContent('<i>x</i>');
  });

  it('never uses dangerouslySetInnerHTML in the chat data layer sources', () => {
    const dir = path.resolve(__dirname, '..');
    for (const name of ['ChatMarkdown.tsx', 'chat-api.ts', 'display.ts', 'ndjson.ts', 'useChatEngine.ts', 'useChatConversations.ts']) {
      const source = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(source, name).not.toMatch(/dangerouslySetInnerHTML\s*[=:{]/);
      expect(source, name).not.toMatch(/\binnerHTML\s*=/);
    }
  });
});

describe('ChatMarkdown — structure', () => {
  it('demotes headings under the message h3 and caps them at h6', () => {
    const { container } = renderMd('# Summary\n## Detail\n### Deeper\n#### Deepest');
    expect(container.querySelector('h4')).toHaveTextContent('Summary');
    expect(container.querySelector('h5')).toHaveTextContent('Detail');
    expect(Array.from(container.querySelectorAll('h6')).map((h) => h.textContent)).toEqual(['Deeper', 'Deepest']);
    expect(container.querySelector('h1, h2, h3')).toBeNull();
  });

  it('honours a different host heading level', () => {
    const { container } = renderMd('# Section', { headingBase: 2 });
    expect(container.querySelector('h3')).toHaveTextContent('Section');
  });

  it('rank-normalises an answer that starts at ## so no heading level is skipped', async () => {
    const { container } = render(
      <div>
        <h3>Assistant</h3>
        <ChatMarkdown text={'## Posture\nAll quiet.\n\n### Detail\nMore.\n\n## Next steps\n- Review'} />
      </div>,
    );
    const headings = Array.from(container.querySelectorAll('h4, h5, h6')).map((h) => [h.tagName, h.textContent]);
    expect(headings).toEqual([
      ['H4', 'Posture'],
      ['H5', 'Detail'],
      ['H4', 'Next steps'],
    ]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('never skips a level when headings jump deeper out of order', async () => {
    const { container } = render(
      <div>
        <h3>Assistant</h3>
        <ChatMarkdown text={'#### Deep first\n\n# Top\n\n#### Deep again\n\n> ### Quoted'} />
      </div>,
    );
    const tags = Array.from(container.querySelectorAll('h4, h5, h6')).map((h) => `${h.tagName}:${h.textContent}`);
    // Ranks: #=1, ###=2, ####=3; "Deep first" is capped at 1 (nothing above it yet),
    // "Deep again" at 2 (one below "Top"), the quoted ### stays at 2.
    expect(tags).toEqual(['H4:Deep first', 'H4:Top', 'H5:Deep again', 'H5:Quoted']);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('re-renders an earlier heading whose rank changes when a new level streams in', () => {
    const tags = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('h4, h5, h6')).map((h) => `${h.tagName}:${h.textContent}`);
    const first = '# A\n\n### B\n\n#### C\n\n### D';
    const { container, rerender } = renderMd(first);
    expect(tags(container)).toEqual(['H4:A', 'H5:B', 'H6:C', 'H5:D']);
    // A new `##` level ranks `###` one deeper; "D" (same source, memoised) follows.
    rerender(<ChatMarkdown text={`${first}\n\n## E`} />);
    expect(tags(container)).toEqual(['H4:A', 'H5:B', 'H6:C', 'H6:D', 'H5:E']);
  });

  it('renders emphasis, strong, strikethrough, inline code and line breaks', () => {
    const { container } = renderMd('A **bold** and *em* and ~~gone~~ and `x = 1`\nnext line');
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('em');
    expect(container.querySelector('del')).toHaveTextContent('gone');
    expect(container.querySelector('code')).toHaveTextContent('x = 1');
    expect(container.querySelector('br')).not.toBeNull();
  });

  it('keeps intraword underscores literal (snake_case identifiers)', () => {
    const { container } = renderMd('field source_ip_address and user_name');
    expect(container.querySelector('em')).toBeNull();
    expect(container).toHaveTextContent('source_ip_address and user_name');
  });

  it('renders ordered, unordered and nested lists', () => {
    const { container } = renderMd('3. Third\n4. Fourth\n   - nested a\n   - nested b\n\n- one\n- two');
    const ol = container.querySelector('ol');
    expect(ol).toHaveAttribute('start', '3');
    expect(ol?.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(ol?.querySelector('ul')?.querySelectorAll('li')).toHaveLength(2);
    const lists = container.querySelectorAll(':scope > div > ul');
    expect(lists).toHaveLength(1);
    expect(lists[0].querySelectorAll('li')).toHaveLength(2);
  });

  it('renders a blockquote and a rule', () => {
    const { container } = renderMd('> quoted **text**\n\n---\n\nafter');
    expect(container.querySelector('blockquote strong')).toHaveTextContent('text');
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('renders fenced code through CodeBlock, including an unterminated fence', () => {
    const { container } = renderMd('```sql\nSELECT * FROM logs\n```\n\n~~~\nopen fence');
    const pres = container.querySelectorAll('pre');
    expect(pres).toHaveLength(2);
    expect(pres[0]).toHaveTextContent('SELECT * FROM logs');
    expect(pres[1]).toHaveTextContent('open fence');
    expect(container).toHaveTextContent('sql');
  });

  it('renders a GFM table with header cells and alignment', () => {
    const { container } = renderMd('| Host | Alerts |\n| :--- | ---: |\n| web-01 | 12 |\n| db\\|02 | 3 |');
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(Array.from(table?.querySelectorAll('th') ?? []).map((th) => th.textContent)).toEqual(['Host', 'Alerts']);
    const cells = Array.from(table?.querySelectorAll('tbody td') ?? []);
    expect(cells.map((td) => td.textContent)).toEqual(['web-01', '12', 'db|02', '3']);
    expect(cells[1]).toHaveClass('text-right');
  });

  it('turns known citation markers into buttons only when the host handles them', () => {
    const onCitation = vi.fn();
    const { container, rerender } = renderMd('Per the guide [D1] and [C9].', {
      citationIds: new Set(['D1']),
      onCitation,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Source D1' }));
    expect(onCitation).toHaveBeenCalledWith('D1');
    expect(container).toHaveTextContent('[C9]');
    rerender(<ChatMarkdown text="Per the guide [D1]." />);
    expect(screen.queryByRole('button', { name: 'Source D1' })).toBeNull();
    expect(container).toHaveTextContent('[D1]');
  });

  it('has no detectable accessibility violations for a rich answer', async () => {
    const { container } = render(
      <div>
        <h3>Assistant</h3>
        <ChatMarkdown
          text={[
            '# Summary',
            'See [the guide](/docs/0.1/analyst/chat/) and https://evil.example/x [D1].',
            '',
            '| Host | Alerts |',
            '| --- | ---: |',
            '| web-01 | 12 |',
            '',
            '1. First',
            '2. Second',
            '',
            '> quoted',
            '',
            '```',
            'code',
            '```',
          ].join('\n')}
          citationIds={new Set(['D1'])}
          onCitation={() => undefined}
        />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders nothing for empty or non-string input', () => {
    const { container } = renderMd('   \n  ');
    expect(container).toBeEmptyDOMElement();
    expect(parseChatMarkdown(undefined)).toEqual([]);
    expect(parseChatMarkdown({ text: 'x' })).toEqual([]);
  });
});

describe('parseChatMarkdown — the exported AST', () => {
  it('exposes a fixed, serialisable tree for the exporters', () => {
    expect(parseChatMarkdown('# Title\nSee [guide](/docs/0.1/x/) and https://a.example')).toEqual([
      { type: 'heading', level: 1, rank: 1, inline: [{ t: 'text', v: 'Title' }], source: '# Title' },
      {
        type: 'paragraph',
        inline: [
          { t: 'text', v: 'See ' },
          { t: 'doc', href: '/docs/0.1/x/', c: [{ t: 'text', v: 'guide' }] },
          { t: 'text', v: ' and ' },
          { t: 'url', url: 'https://a.example', defanged: 'hxxps://a[.]example' },
        ],
        source: 'See [guide](/docs/0.1/x/) and https://a.example',
      },
    ]);
  });

  it('parses triple emphasis and escapes', () => {
    expect(parseInline('***both*** \\*not\\*')).toEqual([
      { t: 'strong', c: [{ t: 'em', c: [{ t: 'text', v: 'both' }] }] },
      { t: 'text', v: ' *not*' },
    ]);
  });

  it('stays fast on pathological input', () => {
    const started = performance.now();
    for (const ch of ['`', '[', '*', '_', '~', '!', '(', '|']) {
      parseChatMarkdown(ch.repeat(20_000));
      parseChatMarkdown(`${ch}a `.repeat(6_000));
    }
    parseChatMarkdown('[a](' + '('.repeat(20_000));
    parseChatMarkdown('> '.repeat(5_000) + 'deep');
    parseChatMarkdown(Array.from({ length: 2_000 }, (_, i) => `${' '.repeat(i % 40)}- item`).join('\n'));
    expect(performance.now() - started).toBeLessThan(4_000);
  });
});
