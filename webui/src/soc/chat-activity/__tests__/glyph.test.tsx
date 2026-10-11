/**
 * The activity glyph grammar (Round 12, SPEC D13): ring while working, accent dot for
 * unread, amber for needs input, red for failed; the text a host points at (precomputed
 * into the snapshot by the writers, so the entry carries no wording logic); the brand
 * ring (only the ring moves, never an operator's logo); the document-title composer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { ActivityGlyph, BrandActivityRing } from '../glyph';
import { CaseChatActivityGlyph, useCaseChatRequest } from '../case-glyph';
import { setBaseDocumentTitle } from '../document-title';
import { setDocumentTitlePrefix } from '../title-prefix';
import {
  chatActivityTitle,
  clearChatActivity,
  describeChatActivity,
  getChatActivity,
  putChatActivity,
  requestCaseChat,
  setAnimatedBrand,
  type ChatActivity,
} from '../activity';

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

  it('says a question the analyst already looked at is still waiting (a dot always has text)', () => {
    const seen = describeChatActivity([entry({ scope: 'conv:q', status: 'needs_input', title: 'Which host?', seen: true })]);
    expect(seen).toEqual({ status: 'needs_input', text: 'Chat: 1 question waiting for your answer: Which host?' });
    const both = describeChatActivity([
      entry({ scope: 'conv:q', status: 'needs_input', title: 'Which host?', seen: true }),
      entry({ scope: 'conv:r', status: 'needs_input', title: 'Which user?' }),
      entry({ scope: 'conv:s', status: 'needs_input', title: 'Which day?', seen: true }),
    ]);
    expect(both.text).toBe('Chat: 1 question needs your input: Which user?; 2 questions waiting for your answer');
  });

  it('names the case of a case chat, so two cases can be told apart', () => {
    const one = describeChatActivity([entry({ scope: 'case:k1', kind: 'case', caseId: 'case-0539', title: 'Summarize case' })], 'Case chat');
    expect(one.text).toBe('Case chat: 1 answer in progress: Case case-0539: Summarize case');
    expect(chatActivityTitle({ kind: 'case', caseId: 'case-0539', title: '' })).toBe('Case case-0539');
    expect(chatActivityTitle({ kind: 'workspace', caseId: null, title: 'Weekly hunt' })).toBe('Weekly hunt');
    // Bounded: a long prompt is clipped with an ellipsis.
    const long = chatActivityTitle({ kind: 'case', caseId: 'case-1', title: 'x'.repeat(200) });
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('is precomputed into the snapshot per destination on every write', () => {
    putChatActivity(entry({ scope: 'conv:a', title: 'Investigate host X' }));
    putChatActivity(entry({ scope: 'case:k', kind: 'case', caseId: 'k', status: 'unread', title: 'Summarize' }));
    const snap = getChatActivity();
    expect(snap.workspace).toEqual({ status: 'running', text: 'Chat: 1 answer in progress: Investigate host X' });
    expect(snap.case).toEqual({ status: 'unread', text: 'Case chat: 1 new answer: Case k: Summarize' });
    expect(snap.all.status).toBe('running');
    clearChatActivity();
    expect(getChatActivity()).toMatchObject({ workspace: { status: null, text: '' }, case: { status: null, text: '' }, all: { status: null } });
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
    expect(screen.getByText(', Case chat: 1 new answer: Case case-7: Summarize')).toHaveClass('sr-only');
  });
});

describe('useCaseChatRequest (a case-chat toast’s Open)', () => {
  function CasePage({ caseId, onChat }: { caseId: string; onChat: () => void }) {
    useCaseChatRequest(caseId, onChat);
    return null;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the Chat tab of the case asked for, once, whether its page is open or still loading', () => {
    const onChat = vi.fn();
    const other = vi.fn();
    const { rerender } = render(
      <>
        <CasePage caseId="case-1" onChat={onChat} />
        <CasePage caseId="case-2" onChat={other} />
      </>,
    );
    act(() => requestCaseChat('case-1'));
    expect(onChat).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    // Taken: a later render does not switch tabs again.
    rerender(
      <>
        <CasePage caseId="case-1" onChat={onChat} />
        <CasePage caseId="case-2" onChat={other} />
      </>,
    );
    expect(onChat).toHaveBeenCalledTimes(1);
    // The page mounts after the request (a lazy route): it takes it on mount.
    act(() => requestCaseChat('case-3'));
    const late = vi.fn();
    render(<CasePage caseId="case-3" onChat={late} />);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('lets a request nobody took lapse, so an old toast never hijacks a later visit', () => {
    vi.useFakeTimers();
    act(() => requestCaseChat('case-9'));
    vi.advanceTimersByTime(31_000);
    const onChat = vi.fn();
    render(<CasePage caseId="case-9" onChat={onChat} />);
    expect(onChat).not.toHaveBeenCalled();
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

  it('writes the base straight to the title until the prefix composer loads', async () => {
    vi.resetModules();
    const fresh = await import('../document-title');
    fresh.setBaseDocumentTitle('Acme · Agentic SOC');
    expect(document.title).toBe('Acme · Agentic SOC');
    const prefix = await import('../title-prefix');
    prefix.setDocumentTitlePrefix('●');
    expect(document.title).toBe('● Acme · Agentic SOC');
    fresh.setBaseDocumentTitle('Agentic SOC');
    expect(document.title).toBe('● Agentic SOC');
    prefix.setDocumentTitlePrefix('');
    expect(document.title).toBe('Agentic SOC');
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

describe('wiring', () => {
  it('the case page takes a case-chat toast’s Open request onto its Chat tab', () => {
    const src = readFileSync(resolve(__dirname, '../../pages/CaseDetail.tsx'), 'utf8');
    expect(src).toMatch(/useCaseChatRequest\(open \? id : null, \(\) => setTab\('chat'\)\)/);
  });

  it('draws the brand ring as an outline concentric with the tile, 3px out, never rotating the shape', () => {
    const css = readFileSync(resolve(__dirname, '../../../styles/activity.css'), 'utf8');
    const ring = css.match(/\n\.chat-brand-ring \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(ring).toMatch(/inset: -3px/);
    expect(ring).toMatch(/border-radius: calc\(var\(--radius\) \+ 1px\)/);
    // Only the highlight inside the outline turns; the outline itself only fades in.
    expect(css).toMatch(/\.chat-brand-ring::before \{\s*animation: chat-activity-spin/);
    expect(css).toMatch(/\.chat-brand-ring \{\s*animation: chat-activity-in 300ms ease-out;\s*\}/);
  });
});
