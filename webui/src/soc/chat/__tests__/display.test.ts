/** Pure display helpers: defanging, the docs-link rule, and the §8 token estimates. */
import { describe, expect, it } from 'vitest';

import {
  defangUrl,
  estimateNextRequest,
  estimateTokens,
  isDocLink,
  isExternalUrl,
  projectTurnMaxTokens,
  splitBareUrls,
} from '../display';

describe('defangUrl', () => {
  it('neuters the scheme and the host dots, leaving the path readable', () => {
    expect(defangUrl('https://evil.example.com/a.b/c?x=1')).toBe('hxxps://evil[.]example[.]com/a.b/c?x=1');
    expect(defangUrl('http://10.0.0.5:8080/')).toBe('hxxp://10[.]0[.]0[.]5:8080/');
    expect(defangUrl('FTP://files.example')).toBe('fxp://files[.]example');
    expect(defangUrl('wss://ws.example')).toBe('wxss://ws[.]example');
  });

  it('is idempotent on already-defanged text', () => {
    const once = defangUrl('https://a.example');
    expect(defangUrl(once)).toBe(once);
  });
});

describe('splitBareUrls', () => {
  it('splits prose into text and defanged URL runs, keeping trailing punctuation outside', () => {
    expect(splitBareUrls('See https://x.example/a). Then stop.')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'url', url: 'https://x.example/a', defanged: 'hxxps://x[.]example/a' },
      { kind: 'text', text: '). Then stop.' },
    ]);
  });

  it('splits out a URL glued to a preceding word or digit', () => {
    expect(splitBareUrls('foohttps://evil.example/x')).toEqual([
      { kind: 'text', text: 'foo' },
      { kind: 'url', url: 'https://evil.example/x', defanged: 'hxxps://evil[.]example/x' },
    ]);
    expect(splitBareUrls('1http://c2.example')).toEqual([
      { kind: 'text', text: '1' },
      { kind: 'url', url: 'http://c2.example', defanged: 'hxxp://c2[.]example' },
    ]);
  });

  it('returns one text run when there is no URL, and ignores a bare scheme', () => {
    expect(splitBareUrls('no links here')).toEqual([{ kind: 'text', text: 'no links here' }]);
    expect(splitBareUrls('just https:// alone')).toEqual([{ kind: 'text', text: 'just https:// alone' }]);
  });

  it('never treats javascript: or data: as a URL run (they stay plain text)', () => {
    expect(splitBareUrls('javascript:alert(1) data:text/html,x')).toHaveLength(1);
    expect(isExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalUrl(' https://a.example ')).toBe(true);
  });
});

describe('isDocLink', () => {
  it('accepts only same-origin versioned Help Center paths', () => {
    expect(isDocLink('/docs/0.1/analyst/chat/')).toBe(true);
    expect(isDocLink('/docs/0.1/analyst/chat/#sources')).toBe(true);
    expect(isDocLink('/docs/12.34/a_b-c')).toBe(true);
    // The Help Center home and dotted release pages are citable (shared contract vectors).
    expect(isDocLink('/docs/0.1/')).toBe(true);
    expect(isDocLink('/docs/0.1/releases/0.1.13/#operator-bootstrap')).toBe(true);
  });

  it('rejects other origins, traversal, other app paths and odd shapes', () => {
    for (const target of [
      'https://docs.example/docs/0.1/x/',
      '//evil.example/docs/0.1/x',
      '/docs/0.1/../../admin',
      '/docs/latest/x/',
      '/docs/0.1',
      '/docs/0.1/./x/',
      '/docs/0.1/releases/0.1./',
      '/docs/0.1/Analyst/',
      '/cases',
      '#/settings',
      'javascript:alert(1)',
      '/docs/0.1/x/#Bad Anchor',
      42,
      null,
    ]) {
      expect(isDocLink(target)).toBe(false);
    }
  });
});

describe('token estimates (SPEC §8)', () => {
  it('estimates chars / 4 rounded up, with a bounded calibration', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(10)).toBe(3);
    expect(estimateTokens(400, 4, 1.5)).toBe(150);
    // An absurd calibration is ignored rather than trusted.
    expect(estimateTokens(400, 4, 40)).toBe(100);
    expect(estimateTokens(400, 0)).toBe(100);
    expect(estimateTokens(Number.NaN)).toBe(0);
  });

  it('adds system + history + draft for the next request', () => {
    expect(
      estimateNextRequest({ staticPromptTokens: 1000, historyTokens: 200, draft: 'x'.repeat(40), calibration: null }),
    ).toEqual({ system: 1000, history: 200, draft: 10, total: 1210 });
    expect(estimateNextRequest({ staticPromptTokens: -5, historyTokens: Number.NaN, draft: '' }).total).toBe(0);
  });

  it('projects the whole-turn bound and clamps it to the ceiling', () => {
    const bounds = { max_model_calls: 5, max_tool_calls: 10, observation_chars: 6000, turn_token_ceiling: 60_000 };
    expect(projectTurnMaxTokens(1000, bounds)).toBe(5000 + 15_000);
    expect(projectTurnMaxTokens(20_000, bounds)).toBe(60_000);
  });
});
