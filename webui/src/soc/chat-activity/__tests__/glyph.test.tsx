/**
 * The activity glyph grammar (Round 12, SPEC D13): ring while working, accent dot for
 * unread, amber for needs input, red for failed; the text a host points at; the brand
 * ring (only the ring moves, never an operator's logo); the document-title composer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { ActivityGlyph, BrandActivityRing, describeChatActivity } from '../glyph';
import { CaseChatActivityGlyph } from '../case-glyph';
import { setBaseDocumentTitle, setDocumentTitlePrefix } from '../document-title';
import { clearChatActivity, putChatActivity, setAnimatedBrand, type ChatActivity } from '../activity';

function entry(patch: Partial<ChatActivity> & { scope: string }): ChatActivity {
  return {
    kind: 'workspace',
    conversationId: null,
    caseId: null,
    turnId: null,
    requestKey: null,
    title: '',
    label: null,
    lookups: 0,
    status: 'running',
    startedAt: 1,
    source: 'local',
    ...patch,
  };
}

beforeEach(() => {
  clearChatActivity();
  setAnimatedBrand(true);
});

describe('ActivityGlyph', () => {
  it('draws one decorative mark whose look (ring or coloured dot) the stylesheet keys on its state', () => {
    const { container, rerender } = render(<ActivityGlyph status="running" className="ml-auto" />);
    const mark = container.firstChild as HTMLElement;
    expect(mark).toHaveAttribute('data-activity', 'running');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveClass('chat-activity', 'ml-auto');
    for (const status of ['unread', 'needs_input', 'failed'] as const) {
      rerender(<ActivityGlyph status={status} />);
      expect(container.querySelector(`.chat-activity[data-activity="${status}"]`)).not.toBeNull();
    }
    rerender(<ActivityGlyph status={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('keeps every motion rule behind reduced motion and gives forced colors system colors', () => {
    const css = readFileSync(resolve(__dirname, '../../../styles/activity.css'), 'utf8');
    // Every animation sits inside the no-preference block (reduced motion: a still arc).
    const animated = css.split('@media (prefers-reduced-motion: no-preference)');
    expect(animated).toHaveLength(2);
    expect(animated[0]).not.toMatch(/animation\s*:/);
    // Only transform and opacity move.
    for (const block of css.match(/@keyframes[^{]+\{[\s\S]*?\n\}/g) ?? []) {
      expect(block).not.toMatch(/\b(width|height|top|left|border|background|stroke)\b\s*:/);
    }
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*Highlight/);
  });
});

describe('describeChatActivity', () => {
  it('names one answer by its title and several by count, most important first', () => {
    expect(describeChatActivity([])).toEqual({ status: null, text: '' });
    expect(describeChatActivity([entry({ scope: 'conv:a', title: 'Investigate host X' })])).toEqual({
      status: 'running',
      text: 'Chat: 1 answer in progress: Investigate host X',
    });
    const mixed = describeChatActivity([
      entry({ scope: 'conv:u', status: 'unread', title: 'Weekly hunt' }),
      entry({ scope: 'conv:a' }),
      entry({ scope: 'conv:b' }),
      entry({ scope: 'conv:q', status: 'needs_input', title: 'Which host?' }),
      entry({ scope: 'conv:f', status: 'failed', title: 'Broken' }),
    ]);
    expect(mixed.status).toBe('running');
    expect(mixed.text).toBe(
      'Chat: 2 answers in progress; 1 question needs your input: Which host?; 1 answer failed: Broken; 1 new answer: Weekly hunt',
    );
  });

  it('keeps an already seen question’s dot but does not repeat it in the text', () => {
    const seen = describeChatActivity([entry({ scope: 'conv:q', status: 'needs_input', title: 'Which host?', seen: true })]);
    expect(seen).toEqual({ status: 'needs_input', text: '' });
  });

  it('keeps a model-written title as plain text (never markup)', () => {
    const { container } = render(<span>{describeChatActivity([entry({ scope: 'conv:x', title: '<img src=x onerror=alert(1)>' })]).text}</span>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('CaseChatActivityGlyph', () => {
  it('shows the case’s own state with its text for screen readers', () => {
    const { container } = render(<CaseChatActivityGlyph caseId="case-7" />);
    expect(container.firstChild).toBeNull();
    act(() => putChatActivity(entry({ scope: 'case:case-7', kind: 'case', caseId: 'case-7', status: 'unread', title: 'Summarize' })));
    expect(container.querySelector('[data-activity="unread"]')).not.toBeNull();
    expect(screen.getByText(', Case chat: 1 new answer: Summarize')).toHaveClass('sr-only');
  });
});

describe('BrandActivityRing', () => {
  it('turns only while an answer is being written and the org switch is on', () => {
    const { container } = render(<BrandActivityRing />);
    expect(container.firstChild).toBeNull();
    act(() => putChatActivity(entry({ scope: 'case:c', kind: 'case', caseId: 'c' })));
    const ring = container.querySelector('.chat-brand-ring');
    expect(ring).toHaveAttribute('aria-hidden', 'true');
    act(() => setAnimatedBrand(false));
    expect(container.querySelector('.chat-brand-ring')).toBeNull();
    expect(window.localStorage.getItem('soc.chat.animatedBrand')).toBe('0');
    act(() => setAnimatedBrand(true));
    act(() => putChatActivity(entry({ scope: 'case:c', kind: 'case', caseId: 'c', status: 'unread' })));
    expect(container.querySelector('.chat-brand-ring')).toBeNull();
  });
});

describe('document title', () => {
  afterEach(() => {
    vi.useRealTimers();
    setDocumentTitlePrefix('');
  });

  it('composes the prefix on the branding base, and a branding refresh keeps it', () => {
    setBaseDocumentTitle('Agentic SOC');
    setDocumentTitlePrefix('●');
    expect(document.title).toBe('● Agentic SOC');
    setBaseDocumentTitle('Acme · Agentic SOC');
    expect(document.title).toBe('● Acme · Agentic SOC');
    setDocumentTitlePrefix('✓');
    expect(document.title).toBe('✓ Acme · Agentic SOC');
    setDocumentTitlePrefix('');
    expect(document.title).toBe('Acme · Agentic SOC');
    setBaseDocumentTitle('Agentic SOC');
  });

  it('waits while someone else holds the title (the print export), then takes it back', () => {
    vi.useFakeTimers();
    setBaseDocumentTitle('Agentic SOC');
    setDocumentTitlePrefix('');
    const previous = document.title;
    document.title = 'report-2026-10-10';
    setDocumentTitlePrefix('●');
    expect(document.title).toBe('report-2026-10-10');
    document.title = previous;
    vi.advanceTimersByTime(1_000);
    expect(document.title).toBe('● Agentic SOC');
  });
});
