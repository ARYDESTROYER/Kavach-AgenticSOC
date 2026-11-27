/**
 * The What's new decision table (Round 16 SPEC D7, [wn] §4.2, without the eligibility
 * rows): one case per row, plus the dialog's highlight choice (featured first, at most
 * five, grants respected) and the bundled notes' own shape.
 */
import { describe, expect, it } from 'vitest';

import { decideWhatsNew, MAX_DIALOG_HIGHLIGHTS } from '../decide';
import { RELEASE_NOTES, type NotesHighlight, type ReleaseNotes } from '../notes';
import { WHATS_NEW_LATEST } from '../WhatsNewGate';

const all = () => true;

function highlight(id: string, extra: Partial<NotesHighlight> = {}): NotesHighlight {
  return {
    id, kind: 'new', area: 'cases', title: `Title ${id}`, summary: `Summary ${id}.`, details: [],
    featured: false, requires: null, open: null, help: null, screenshot: null, ...extra,
  };
}

const shot = {
  light: { src: 'assets/releases/0.3.0/a-light.webp', width: 2880, height: 1800 },
  dark: { src: 'assets/releases/0.3.0/a-dark.webp', width: 2880, height: 1800 },
  alt: 'The case header with its AI chip and the popover open beside it.',
  caption: null,
};

const NOTES: ReleaseNotes = {
  schema: 1,
  latest: '0.3.0.2027-02-01',
  releases: [
    {
      version: '0.3.0', status: 'released', date: '2027-02-01', title: 'Three', summary: 'The third line.',
      docs: 'releases/0.3.0/', records: [],
      updates: [
        { id: '0.3.0.2027-02-01', date: '2027-02-01', title: 'February', highlights: [
          highlight('feb-a'), highlight('feb-b', { featured: true, screenshot: shot }),
          highlight('feb-admin', { featured: true, screenshot: shot, requires: 'users:manage' }),
        ] },
        { id: '0.3.0.2027-01-10', date: '2027-01-10', title: 'January', highlights: [
          highlight('jan-a'), highlight('jan-b'),
        ] },
      ],
    },
    {
      version: '0.2.0', status: 'released', date: '2026-12-01', title: 'Two', summary: 'The second line.',
      docs: 'releases/0.2.0/', records: [],
      updates: [
        { id: '0.2.0.2026-12-01', date: '2026-12-01', title: 'December', highlights: [
          highlight('d1'), highlight('d2'), highlight('d3'), highlight('d4'), highlight('d5'), highlight('d6'),
        ] },
      ],
    },
  ],
};

describe('the decision table', () => {
  it('shows nothing when the marker is the newest update', () => {
    expect(decideWhatsNew(NOTES, '0.3.0.2027-02-01', { has: all })).toBeNull();
  });

  it('lists the updates newer than an older marker, across releases, newest first', () => {
    const plan = decideWhatsNew(NOTES, '0.2.0.2026-12-01', { has: all });
    expect(plan?.kind).toBe('updates');
    expect(plan?.release.version).toBe('0.3.0');
    expect(plan?.updates.map((u) => u.id)).toEqual(['0.3.0.2027-02-01', '0.3.0.2027-01-10']);
    // Featured highlights win when there are any.
    expect(plan?.highlights.map((h) => h.id)).toEqual(['feb-b', 'feb-admin']);
  });

  it('lists only the newer update when the marker is one update behind', () => {
    const plan = decideWhatsNew(NOTES, '0.3.0.2027-01-10', { has: all });
    expect(plan?.updates.map((u) => u.id)).toEqual(['0.3.0.2027-02-01']);
  });

  it('treats an unknown marker (written by a newer build) as having seen everything', () => {
    expect(decideWhatsNew(NOTES, '0.4.0.2027-06-01', { has: all })).toBeNull();
  });

  it('welcomes an account with no marker to the newest version', () => {
    for (const marker of [undefined, null, 7, ['x']]) {
      const plan = decideWhatsNew(NOTES, marker, { has: all });
      expect(plan?.kind).toBe('welcome');
      expect(plan?.release.version).toBe('0.3.0');
      expect(plan?.updates.map((u) => u.id)).toEqual(['0.3.0.2027-02-01', '0.3.0.2027-01-10']);
      expect(plan?.highlights.map((h) => h.id)).toEqual(['feb-b', 'feb-admin']);
    }
  });

  it('re-opens the welcome on demand even when the marker is current or unknown', () => {
    expect(decideWhatsNew(NOTES, '0.3.0.2027-02-01', { has: all, force: true })?.kind).toBe('welcome');
    expect(decideWhatsNew(NOTES, 'unknown', { has: all, force: true })?.kind).toBe('welcome');
    expect(decideWhatsNew(NOTES, '0.2.0.2026-12-01', { has: all, force: true })?.kind).toBe('updates');
  });

  it('shows nothing when there are no notes at all', () => {
    expect(decideWhatsNew({ schema: 1, latest: '', releases: [] }, undefined, { has: all })).toBeNull();
  });
});

describe('the highlights the dialog offers', () => {
  it('leaves out a highlight whose grant the viewer lacks', () => {
    const has = (resource: string, action: string) => !(resource === 'users' && action === 'manage');
    const plan = decideWhatsNew(NOTES, undefined, { has });
    expect(plan?.highlights.map((h) => h.id)).toEqual(['feb-b']);
  });

  it('falls back to the first highlights, at most five, when none is featured', () => {
    const only = { ...NOTES, latest: '0.2.0.2026-12-01', releases: [NOTES.releases[1]] };
    const plan = decideWhatsNew(only, undefined, { has: all });
    expect(MAX_DIALOG_HIGHLIGHTS).toBe(5);
    expect(plan?.highlights.map((h) => h.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
  });

  it('shows nothing for an older marker when the viewer can use none of the newer highlights', () => {
    const gated = {
      ...NOTES,
      releases: [{ ...NOTES.releases[0], updates: [{ ...NOTES.releases[0].updates[0], highlights: [highlight('x', { requires: 'users:manage' })] }] }, NOTES.releases[1]],
    };
    expect(decideWhatsNew(gated, '0.2.0.2026-12-01', { has: () => false })).toBeNull();
  });
});

describe('the bundled notes', () => {
  it('name the newest update the build injects, and the welcome announces the case tabs', () => {
    expect(RELEASE_NOTES.latest).toBe(WHATS_NEW_LATEST);
    expect(RELEASE_NOTES.releases[0].updates[0].id).toBe(WHATS_NEW_LATEST);
    const plan = decideWhatsNew(RELEASE_NOTES, undefined, { has: all });
    expect(plan?.kind).toBe('welcome');
    const tabs = plan?.highlights.find((h) => h.id === 'case-tabs');
    expect(tabs?.summary).toMatch(/Brief, Evidence, AI investigation, Response, Activity and Chat/);
    expect(tabs?.summary).toMatch(/Alt\+2, Alt\+4 and Alt\+5/);
    expect(tabs?.summary).toMatch(/Alt\+6/);
    expect(plan?.highlights.length).toBeLessThanOrEqual(MAX_DIALOG_HIGHLIGHTS);
  });

  it('carry no em dash, en dash, no-break space or the word Round', () => {
    const text = JSON.stringify(RELEASE_NOTES);
    expect(text).not.toMatch(/[\u2014\u2013\u00a0]/);
    expect(text).not.toMatch(/\bRound\b/);
  });
});
