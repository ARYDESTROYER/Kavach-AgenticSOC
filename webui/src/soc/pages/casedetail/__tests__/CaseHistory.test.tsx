/**
 * CaseHistory (Round 15, SPEC D4.2, D8.3): the Collaboration tab's lifecycle with who,
 * when and the actions taken, read from the case's own append-only `history` (the
 * activity endpoint is unchanged, [ru] M8). Newest first in append order; untrusted
 * names and notes are plain text (#9).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import type { Case } from '@/lib/types';

import { CaseHistory, caseHistoryItems } from '../CaseHistory';

const at = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, '0')}:00Z`;

describe('caseHistoryItems', () => {
  it('reads every lifecycle kind, newest first, in append order', () => {
    const c = {
      case_id: 'c1',
      history: [
        { event: 'decision', ts: at(0), status: 'closed', decision_by: 'agent', rationale: 'verdict=FALSE_POSITIVE' },
        { event: 'analyst_action', ts: at(5), action: 'reopen', analyst: 'mira', note: '', review_via: 'auto_close_review' },
        { event: 'assigned', ts: at(6), assignee: 'dev', analyst: 'mira' },
        {
          event: 'analyst_action',
          ts: at(9),
          action: 'close',
          analyst: 'dev',
          note: 'Contained.',
          classified_disposition: 'true_positive',
          actions_taken: ['isolated_host', 'disabled_account'],
          batch: 'bulk-123',
        },
        { event: 'auto_close_review', ts: at(10), analyst: 'mira', agrees: false, review_id: 'r1' },
        { event: 'precedent_ratification', ts: at(11) },
        'not an entry',
      ],
    } as unknown as Case;
    const items = caseHistoryItems(c);
    expect(items.map((item) => item.title)).toEqual([
      'Reviewed the automatic close',
      'Closed as true positive',
      'Assigned to dev',
      'Reopened',
      'Closed automatically',
    ]);
    expect(items[0].details).toEqual(['Disagreed with the AI']);
    expect(items[1].actionsTaken).toEqual(['Isolated a host', 'Disabled an account']);
    expect(items[1].details).toEqual(['In a bulk job']);
    expect(items[1].note).toBe('Contained.');
    expect(items[3].details).toEqual(['From an auto-close review']);
    expect(items[4]).toMatchObject({ who: 'AI agent', actor: 'agent' });
  });

  it('words the deterministic routes and a stored older verb', () => {
    const items = caseHistoryItems({
      history: [
        { event: 'decision', ts: at(0), status: 'needs_human', decision_by: 'system' },
        { event: 'decision', ts: at(1), status: 'escalated', decision_by: 'system', escalate: true },
        { event: 'analyst_action', ts: at(2), action: 'confirm_fp', analyst: 'mira', classified_disposition: 'false_positive' },
        { event: 'analyst_policy', ts: at(3) },
      ],
    } as unknown as Case);
    expect(items.map((item) => [item.title, item.who])).toEqual([
      ['Closed by an analyst policy', 'Analyst policy'],
      ['Confirmed a false positive', 'mira'],
      ['Escalated automatically', 'Case manager'],
      ['Sent to an analyst', 'Case manager'],
    ]);
  });

  it('shows an unknown stored action as written, never inventing words', () => {
    const items = caseHistoryItems({
      history: [{ event: 'analyst_action', ts: at(0), action: 'close', analyst: 'mira', actions_taken: ['future_value'] }],
    } as unknown as Case);
    expect(items[0].actionsTaken).toEqual(['future_value']);
  });

  it('gives an automatic decision its recorded reason in plain words, never the engine string (FXA1)', () => {
    const items = caseHistoryItems({
      history: [
        {
          event: 'decision',
          ts: at(0),
          status: 'escalated',
          decision_by: 'system',
          escalate: true,
          rationale: 'True positive routed to human: tp auto-close disabled.',
        },
        {
          event: 'decision',
          ts: at(1),
          status: 'closed',
          decision_by: 'agent',
          rationale: 'FALSE_POSITIVE auto-closed: confidence 0.87 >= 0.85 and risk 13.6 <= 30.0; objection window 1440m.',
        },
        { event: 'decision', ts: at(2), status: 'needs_human', decision_by: 'system', rationale: 'something else' },
      ],
    } as unknown as Case);
    // Newest first; text that is not an engine template stays in the record only.
    expect(items.map((item) => item.reason)).toEqual(['', 'It met the auto-close bar.', 'Auto-close is off for this verdict.']);
  });

  it('is empty without a history', () => {
    expect(caseHistoryItems({ case_id: 'c1' } as Case)).toEqual([]);
  });
});

describe('CaseHistory', () => {
  it('renders names and notes as plain text and says when there is nothing', () => {
    const { rerender } = render(
      <CaseHistory
        c={{
          case_id: 'c1',
          history: [
            { event: 'analyst_action', ts: at(0), action: 'hold', analyst: '<b>mira</b>', note: '<img src=x>' },
          ],
        } as unknown as Case}
      />,
    );
    const item = screen.getByTestId('case-history-item');
    expect(within(item).getByText('<b>mira</b>')).toBeInTheDocument();
    expect(within(item).getByText('<img src=x>')).toBeInTheDocument();
    expect(item.querySelector('img, b')).toBeNull();

    rerender(<CaseHistory c={{ case_id: 'c1', history: [] } as unknown as Case} />);
    expect(screen.getByText('No lifecycle changes yet.')).toBeInTheDocument();
  });

  it('shows the reason an automatic decision recorded (FXA1)', () => {
    render(
      <CaseHistory
        c={{
          case_id: 'c1',
          history: [
            {
              event: 'decision',
              ts: at(0),
              status: 'escalated',
              decision_by: 'system',
              escalate: true,
              rationale: 'True positive routed to human: tp auto-close disabled.',
            },
          ],
        } as unknown as Case}
      />,
    );
    const item = screen.getByTestId('case-history-item');
    expect(within(item).getByText('Escalated automatically')).toBeInTheDocument();
    expect(within(item).getByTestId('case-history-reason')).toHaveTextContent('Reason: Auto-close is off for this verdict.');
    expect(item).not.toHaveTextContent(/tp auto-close disabled|routed to human/);
  });

  describe('a long note (FXA1)', () => {
    const NOTE = 'Waiting on the identity team to confirm the travel. '.repeat(8).trim();
    // jsdom has no layout: the clamped note reports a taller scroll height, as a browser
    // does when line-clamp cuts it.
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    const fake = (clamped: boolean) => {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get(this: HTMLElement) {
          return this.dataset.testid === 'case-history-note' ? (clamped ? 128 : 48) : 0;
        },
      });
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get(this: HTMLElement) {
          return this.dataset.testid === 'case-history-note' ? 48 : 0;
        },
      });
    };
    // jsdom defines both on Element, not HTMLElement: an absent own descriptor is deleted.
    const restore = (name: 'scrollHeight' | 'clientHeight', descriptor: PropertyDescriptor | undefined) => {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    };
    afterEach(() => {
      restore('scrollHeight', scroll);
      restore('clientHeight', client);
    });
    const renderNote = (note: string) =>
      render(
        <CaseHistory
          c={{
            case_id: 'c1',
            history: [{ event: 'analyst_action', ts: at(0), action: 'hold', analyst: 'mira', note }],
          } as unknown as Case}
        />,
      );

    it('is clamped with a Show more toggle that reveals all of it', () => {
      fake(true);
      renderNote(NOTE);
      const note = screen.getByTestId('case-history-note');
      expect(note).toHaveClass('line-clamp-3');
      const more = screen.getByRole('button', { name: 'Show more' });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      expect(more).toHaveAttribute('aria-controls', note.id);
      fireEvent.click(more);
      expect(note).not.toHaveClass('line-clamp-3');
      expect(note).toHaveTextContent(NOTE);
      const less = screen.getByRole('button', { name: 'Show less' });
      expect(less).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(less);
      expect(note).toHaveClass('line-clamp-3');
    });

    it('offers no toggle when the note fits', () => {
      fake(false);
      renderNote('Contained.');
      expect(screen.getByTestId('case-history-note')).toHaveTextContent('Contained.');
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    });
  });

  it('shows the latest eight, with the earlier ones one click away', () => {
    const history = Array.from({ length: 11 }, (_, i) => ({
      event: 'analyst_action',
      ts: at(i),
      action: i % 2 ? 'hold' : 'resume',
      analyst: 'mira',
    }));
    render(<CaseHistory c={{ case_id: 'c1', history } as unknown as Case} />);
    expect(screen.getAllByTestId('case-history-item')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 earlier' }));
    expect(screen.getAllByTestId('case-history-item')).toHaveLength(11);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });
});
