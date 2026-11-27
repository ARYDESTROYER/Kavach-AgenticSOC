/**
 * The browser's runbook Markdown parser and exporter agree with the server's (Round 14,
 * SPEC §4.10.13, §4.10.21 "Markdown round trip").
 *
 * The fixtures are the server's own output: `parse_runbook_markdown`,
 * `normalise_definition` and `export_runbook_markdown` in
 * `backend/app/engine/runbook_model.py`, over the twelve bundled runbooks and a set of
 * edge-case sources. When a bundled runbook or the server's format changes, regenerate
 * them from `backend/` with the backend virtual environment:
 *
 *   from app.engine.runbook_model import parse_runbook_markdown, export_runbook_markdown,
 *       normalise_definition, RUNBOOK_LIBRARY_DIR
 *   # for each library file: parse, normalise, export(version=parsed.version); dump JSON
 *
 * (the full snippet is in the W7a progress notes). The server stays the authority: the
 * editor sends the Markdown itself when it saves from the Source view.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { RunbookDefinition, RunbookIssue } from '@/lib/types-runbooks';

import { exportRunbookMarkdown, normaliseDefinition, parseRunbookMarkdown } from '../markdown';

interface BundledFixture {
  file: string;
  version: number | null;
  issues: RunbookIssue[];
  definition: RunbookDefinition;
  export: string;
}

interface EdgeFixture {
  name: string;
  source: string;
  version: number | null;
  ok: boolean;
  issues: RunbookIssue[];
  definition: RunbookDefinition | null;
  export: string | null;
}

const FIXTURES = path.join(__dirname, 'fixtures');
const LIBRARY = path.resolve(process.cwd(), '..', 'backend', 'app', 'runbooks', 'library');

const bundled = (
  JSON.parse(readFileSync(path.join(FIXTURES, 'bundled-runbooks.parse.json'), 'utf8')) as { runbooks: BundledFixture[] }
).runbooks;
const edges = (
  JSON.parse(readFileSync(path.join(FIXTURES, 'edge-runbooks.parse.json'), 'utf8')) as { cases: EdgeFixture[] }
).cases;

describe('runbook Markdown: parity with the server', () => {
  it('covers the twelve bundled runbooks', () => {
    expect(bundled).toHaveLength(12);
  });

  it.each(bundled.map((b) => [b.file, b] as const))('%s parses to the server definition', (file, fixture) => {
    const text = readFileSync(path.join(LIBRARY, file), 'utf8');
    const parsed = parseRunbookMarkdown(text);
    expect(parsed.issues).toEqual(fixture.issues);
    expect(parsed.version).toBe(fixture.version);
    expect(parsed.definition).not.toBeNull();
    expect(normaliseDefinition(parsed.definition as RunbookDefinition)).toEqual(fixture.definition);
  });

  it.each(bundled.map((b) => [b.file, b] as const))('%s exports byte for byte as the server does', (_file, fixture) => {
    expect(exportRunbookMarkdown(fixture.definition, fixture.version)).toBe(fixture.export);
  });

  it.each(bundled.map((b) => [b.file, b] as const))('%s round-trips: parse, export, parse gives the same definition', (_file, fixture) => {
    const again = parseRunbookMarkdown(exportRunbookMarkdown(fixture.definition, fixture.version));
    expect(again.issues).toEqual([]);
    expect(again.version).toBe(fixture.version);
    expect(normaliseDefinition(again.definition as RunbookDefinition)).toEqual(fixture.definition);
  });

  it.each(edges.map((e) => [e.name, e] as const))('edge case %s matches the server', (_name, fixture) => {
    const parsed = parseRunbookMarkdown(fixture.source);
    expect(parsed.definition !== null).toBe(fixture.ok);
    expect(parsed.version).toBe(fixture.version);
    expect(parsed.issues).toEqual(fixture.issues);
    if (fixture.definition) {
      expect(normaliseDefinition(parsed.definition as RunbookDefinition)).toEqual(fixture.definition);
      expect(exportRunbookMarkdown(fixture.definition, fixture.version)).toBe(fixture.export);
    }
  });

  it('refuses a source over 64 KiB before reading it', () => {
    const parsed = parseRunbookMarkdown(`---\nid: a\n---\n${'x'.repeat(70_000)}`);
    expect(parsed.definition).toBeNull();
    expect(parsed.issues.map((i) => i.code)).toEqual(['source_too_large']);
  });

  it('never throws on garbage', () => {
    for (const text of ['', '---', '---\n---', '---\nid: [\n---', '\u0000\u0001', '### x', '---\nid: a\n---\n```lookup\n']) {
      expect(() => parseRunbookMarkdown(text)).not.toThrow();
    }
  });
});
