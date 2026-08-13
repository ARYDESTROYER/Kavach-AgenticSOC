/** Intelligence Runbooks: protected browse + permission-gated CRUD/reindex. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getRunbooks: vi.fn(),
  getRunbook: vi.fn(),
  createRunbook: vi.fn(),
  updateRunbook: vi.fn(),
  deleteRunbook: vi.fn(),
  submitJob: vi.fn(),
  canManage: true,
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getRunbooks: mocks.getRunbooks,
      getRunbook: mocks.getRunbook,
      createRunbook: mocks.createRunbook,
      updateRunbook: mocks.updateRunbook,
      deleteRunbook: mocks.deleteRunbook,
      jobs: {
        ...actual.api.jobs,
        submit: mocks.submitJob,
      },
    },
  };
});

vi.mock('@/soc/components/Can', () => ({
  useCan: () => mocks.canManage,
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
    error: mocks.toastError,
  },
}));

import type {
  Runbook,
  RunbookAuthoringStandard,
  RunbookDetail,
  RunbookIndexResult,
} from '@/lib/types';
import { ApiError } from '@/lib/api';
import { TooltipProvider } from '@/ui/tooltip';
import Runbooks from '../Runbooks';
import {
  RUNBOOK_BODY_MAX_CHARS,
  RUNBOOK_DESCRIPTOR_MAX_CHARS,
  validateRunbookAuthoring,
} from '../runbookAuthoring';
import { RUNBOOK_EXAMPLES } from '../runbookExamples';

const INDEX_OK: RunbookIndexResult = {
  ok: true,
  indexed: 1,
  deleted: 0,
  failed: 0,
  errors: [],
};

function runbook(over: Partial<Runbook> = {}): Runbook {
  return {
    id: 'suspicious_powershell',
    title: 'Suspicious PowerShell',
    summary: 'Investigation reference for encoded PowerShell execution.',
    persona: 'malware',
    applies_to_rules: ['powershell'],
    applies_to_techniques: ['T1059.001'],
    applies_to_entities: ['host', 'user'],
    keywords: ['encodedcommand'],
    source_type: 'operator',
    protected: false,
    editable: true,
    revision: 3,
    created_at: '2026-07-29T10:00:00Z',
    updated_at: '2026-07-30T10:00:00Z',
    index_status: 'indexed',
    indexed_revision: 3,
    last_indexed_at: '2026-07-30T10:01:00Z',
    index_error: null,
    ...over,
  };
}

function detail(row: Runbook, content?: string): RunbookDetail {
  const document = content ?? validDocument(row.id, row.title, row.summary);
  const body = document.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
  return { ...row, content: document, body };
}

function validDocument(
  id = 'suspicious_powershell',
  title = 'Suspicious PowerShell',
  summary = 'Investigate encoded PowerShell execution on a managed host.',
): string {
  return `---
id: ${id}
title: ${title}
summary: ${summary}
persona: malware
applies_to_rules: [powershell]
applies_to_techniques: [T1059.001]
applies_to_entities: [host]
keywords: [encodedcommand]
---

SIGNAL
PowerShell starts with encoded content or a policy bypass on a managed host.

EVIDENCE REQUIRED
Collect process ancestry, script-block telemetry, identity, host, and execution time.

INVESTIGATION STEPS
1. Confirm the original command and process parent from endpoint telemetry.
2. Compare the activity with the host and identity baseline.
3. Record corroborating or conflicting evidence before assigning a verdict.

TRUE POSITIVE SIGNALS
The decoded command performs an unauthorized payload download or credential action.

FALSE POSITIVE SIGNALS
An approved automation owner confirms the exact signed script and expected schedule.

NEEDS HUMAN WHEN
Required process or script-block telemetry is missing, stale, or contradictory.

RECOMMENDED NEXT ACTION
Escalate confirmed malicious execution and preserve the process tree for containment.
`;
}

function response(rows: Runbook[]) {
  return {
    enabled: true,
    retrieval_enabled: true,
    count: rows.length,
    runbooks: rows,
  };
}

function authoringStandard(
  override: Partial<RunbookAuthoringStandard> = {},
): RunbookAuthoringStandard {
  return {
    version: 1,
    body_max_characters: 1_800,
    retrieval_descriptor_max_characters: 1_200,
    document_max_bytes: 131_072,
    section_min_characters: 12,
    reserved_ids: ['index', 'readme', 'reindex'],
    character_count: 'Unicode characters after newline normalization and outer trimming',
    metadata_limits: {
      title_max_characters: 120,
      summary_max_characters: 280,
      persona_max_characters: 48,
      list_max_items: 12,
      list_item_max_characters: 64,
    },
    required_manifest_fields: [
      'id',
      'title',
      'summary',
      'applies_to_rules',
      'applies_to_entities',
      'keywords',
    ],
    optional_manifest_fields: ['persona', 'applies_to_techniques'],
    required_body_labels: [
      'SIGNAL',
      'EVIDENCE REQUIRED',
      'INVESTIGATION STEPS',
      'TRUE POSITIVE SIGNALS',
      'FALSE POSITIVE SIGNALS',
      'NEEDS HUMAN WHEN',
      'RECOMMENDED NEXT ACTION',
    ],
    optional_body_labels: ['LIMITATIONS'],
    investigation_steps: 'Sequential one-line numbered steps: 1., 2., 3.',
    allowed_metadata_format: 'Concise plain text only',
    allowed_body_format: 'Plain sentences and sequential numbered steps only',
    prohibited_metadata_format: ['Markdown headings or table pipes'],
    prohibited_body_format: ['Markdown headings', 'tables'],
    ...override,
  };
}

function renderRunbooks() {
  return render(
    <TooltipProvider>
      <Runbooks embedded />
    </TooltipProvider>,
  );
}

describe('Intelligence Runbooks management', () => {
  beforeEach(() => {
    for (const mock of [
      mocks.getRunbooks,
      mocks.getRunbook,
      mocks.createRunbook,
      mocks.updateRunbook,
      mocks.deleteRunbook,
      mocks.submitJob,
      mocks.toastSuccess,
      mocks.toastWarning,
      mocks.toastError,
    ]) {
      mock.mockReset();
    }
    mocks.canManage = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens bundled Markdown while keeping immutable controls hidden', async () => {
    const bundled = runbook({
      id: 'credential_access',
      title: 'Credential access',
      source_type: 'bundled',
      protected: true,
      editable: false,
      revision: 'bundled:1',
      indexed_revision: 'bundled:1',
    });
    mocks.getRunbooks.mockResolvedValue(response([bundled]));
    mocks.getRunbook.mockResolvedValue(detail(bundled));

    renderRunbooks();
    expect(await screen.findByText('Credential access')).toBeInTheDocument();
    expect(screen.getByText('Bundled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(await screen.findByText('Bundled · protected')).toBeInTheDocument();
    expect(screen.getByText(/id: credential_access/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('explains first use and points to the safe create action', async () => {
    mocks.getRunbooks.mockResolvedValue(response([]));

    renderRunbooks();

    const empty = await screen.findByRole('group', { name: 'No runbooks are available' });
    expect(empty).toHaveAttribute('data-empty-state', 'first-use');
    expect(empty).toHaveAccessibleDescription(
      /no bundled or operator-authored references yet.*use New runbook.*then index/i,
    );
    expect(screen.getByRole('button', { name: /new runbook/i })).toBeVisible();
  });

  it('distinguishes filtered no-results and clears back to the loaded library', async () => {
    const row = runbook();
    mocks.getRunbooks.mockResolvedValue(response([row]));

    renderRunbooks();
    expect(await screen.findByText(row.title)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/search runbooks/i), {
      target: { value: 'definitely-not-present' },
    });

    const noResults = screen.getByRole('status', {
      name: 'No runbooks match these filters',
    });
    expect(noResults).toHaveAttribute('data-empty-state', 'no-results');
    expect(noResults).toHaveAccessibleDescription(/library loaded.*filter.*exclude/i);
    fireEvent.click(within(noResults).getByRole('button', { name: /clear filters/i }));

    expect(screen.getByText(row.title)).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /no runbooks match/i })).not.toBeInTheDocument();
  });

  it('creates a runbook but reports a partial indexing outcome truthfully', async () => {
    const saved = runbook({
      id: 'dns_beaconing',
      title: 'DNS beaconing',
      revision: 1,
      indexed_revision: null,
      index_status: 'error',
      index_error: 'Embedding provider unavailable.',
    });
    const partial: RunbookIndexResult = {
      ok: false,
      indexed: 0,
      deleted: 0,
      failed: 1,
      errors: [{ id: saved.id, error: 'Embedding provider unavailable.' }],
    };
    mocks.getRunbooks.mockResolvedValue(response([]));
    mocks.createRunbook.mockResolvedValue({ ok: true, runbook: saved, index: partial });
    mocks.getRunbook.mockResolvedValue(detail(saved));

    renderRunbooks();
    fireEvent.click(await screen.findByRole('button', { name: /new runbook/i }));
    fireEvent.change(screen.getByLabelText(/runbook id/i), {
      target: { value: 'dns_beaconing' },
    });
    const editor = screen.getByLabelText(/runbook document/i) as HTMLTextAreaElement;
    expect(editor.value).toContain('id: dns_beaconing');
    fireEvent.change(editor, { target: { value: validDocument('dns_beaconing', 'DNS beaconing') } });
    fireEvent.click(screen.getByRole('button', { name: /create runbook/i }));

    await waitFor(() => expect(mocks.createRunbook).toHaveBeenCalledTimes(1));
    expect(mocks.createRunbook).toHaveBeenCalledWith({
      id: 'dns_beaconing',
      content: expect.stringContaining('id: dns_beaconing'),
    });
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      expect.stringContaining('The Markdown is durable; indexing needs attention.'),
    );
    expect(await screen.findByText('Latest index reconciliation')).toBeInTheDocument();
    expect(screen.getByText(/dns_beaconing: Embedding provider unavailable/i)).toBeInTheDocument();
  });

  it('fails closed when the backend publishes a newer authoring policy', async () => {
    mocks.getRunbooks.mockResolvedValue({
      ...response([]),
      authoring_standard: authoringStandard({ version: 2 }),
    });

    renderRunbooks();
    fireEvent.click(await screen.findByRole('button', { name: /new runbook/i }));
    fireEvent.change(screen.getByLabelText(/runbook id/i), {
      target: { value: 'policy_drift' },
    });
    fireEvent.change(screen.getByLabelText(/runbook document/i), {
      target: { value: validDocument('policy_drift') },
    });

    expect(
      screen.getByText(/Console does not match the backend Runbook authoring standard/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create runbook/i })).toBeDisabled();
    expect(mocks.createRunbook).not.toHaveBeenCalled();
  });

  it('updates operator Markdown with the opened optimistic revision', async () => {
    const row = runbook();
    const first = detail(row);
    const changed = first.content.replace(
      'Confirm the original command and process parent from endpoint telemetry.',
      'Validate the original command and complete process tree from endpoint telemetry.',
    );
    const saved = runbook({ revision: 4, indexed_revision: 4 });
    mocks.getRunbooks.mockResolvedValue(response([row]));
    mocks.getRunbook.mockResolvedValueOnce(first).mockResolvedValueOnce(detail(saved, changed));
    mocks.updateRunbook.mockResolvedValue({ ok: true, runbook: saved, index: INDEX_OK });

    renderRunbooks();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(
      screen.queryByRole('heading', { name: /start from an example/i }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/runbook document/i), {
      target: { value: changed },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(mocks.updateRunbook).toHaveBeenCalledWith(row.id, changed, row.revision),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('Runbook updated.'),
    );
    expect(await screen.findByText(/Validate the original command/)).toBeInTheDocument();
  });

  it('deletes only after confirmation and supplies the opened revision', async () => {
    const row = runbook();
    mocks.getRunbooks.mockResolvedValue(response([row]));
    mocks.getRunbook.mockResolvedValue(detail(row));
    mocks.deleteRunbook.mockResolvedValue({ ok: true, id: row.id, index: INDEX_OK });

    renderRunbooks();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/and its retrieval projection will be removed/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /delete runbook/i }));

    await waitFor(() =>
      expect(mocks.deleteRunbook).toHaveBeenCalledWith(row.id, row.revision),
    );
    expect(screen.queryByText(row.title)).not.toBeInTheDocument();
  });

  it('supports search/index filtering and hides every mutation without runbooks:manage', async () => {
    mocks.canManage = false;
    const current = runbook();
    const pending = runbook({
      id: 'cloud_exfiltration',
      title: 'Cloud exfiltration',
      source_type: 'bundled',
      protected: true,
      editable: false,
      revision: 'bundled:2',
      indexed_revision: 'bundled:1',
      index_status: 'indexed',
    });
    mocks.getRunbooks.mockResolvedValue(response([current, pending]));
    mocks.getRunbook.mockResolvedValue(detail(pending));

    renderRunbooks();
    expect(await screen.findByText('Cloud exfiltration')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new runbook/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reindex all/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reindex suspicious powershell/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/search runbooks/i), {
      target: { value: 'cloud' },
    });
    expect(screen.queryByText('Suspicious PowerShell')).not.toBeInTheDocument();
    expect(screen.getByText('Cloud exfiltration')).toBeInTheDocument();
  });

  it('submits full and targeted reconciliation as durable server jobs', async () => {
    const row = runbook();
    mocks.getRunbooks.mockResolvedValue(response([row]));
    mocks.submitJob
      .mockResolvedValueOnce({ job_id: 'job-all', kind: 'runbook_reindex', status: 'queued' })
      .mockResolvedValueOnce({ job_id: 'job-one', kind: 'runbook_reindex', status: 'queued' });

    renderRunbooks();
    fireEvent.click(await screen.findByRole('button', { name: /reindex all/i }));
    await waitFor(() =>
      expect(mocks.submitJob).toHaveBeenNthCalledWith(1, {
        kind: 'runbook_reindex',
        idempotency_key: expect.any(String),
        params: {},
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /reindex suspicious powershell/i }));
    await waitFor(() =>
      expect(mocks.submitJob).toHaveBeenNthCalledWith(2, {
        kind: 'runbook_reindex',
        idempotency_key: expect.any(String),
        params: { runbook_id: row.id },
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/queued/i),
      expect.objectContaining({ description: expect.stringMatching(/server/i) }),
    );
  });

  it('shows the complete authoring standard and gates submission until every issue is fixed', async () => {
    mocks.getRunbooks.mockResolvedValue(response([]));

    renderRunbooks();
    fireEvent.click(await screen.findByRole('button', { name: /new runbook/i }));

    const standard = screen.getByRole('complementary', { name: /authoring standard/i });
    expect(within(standard).getByText(/1,800-character body budget/i)).toBeInTheDocument();
    expect(within(standard).getByText(/Required manifest/i)).toBeInTheDocument();
    expect(within(standard).getByText(/title 120, summary 280/i)).toBeInTheDocument();
    expect(within(standard).getByText(/at most 12 values of 64 characters each/i)).toBeInTheDocument();
    expect(within(standard).getByText(/descriptor capped at 1,200 characters/i)).toBeInTheDocument();
    expect(within(standard).getByText(/Fixed section order/i)).toBeInTheDocument();
    expect(within(standard).getByText(/Plain text only/i)).toBeInTheDocument();
    expect(within(standard).getByText(/Evidence and authority/i)).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: /create runbook/i });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/Required frontmatter field title is missing/i)).toBeInTheDocument();
    expect(screen.getAllByText(/^Why$/)).not.toHaveLength(0);
    expect(screen.getAllByText(/^Fix$/)).not.toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/runbook id/i), {
      target: { value: 'host_script_execution' },
    });
    fireEvent.change(screen.getByLabelText(/runbook document/i), {
      target: { value: validDocument('host_script_execution') },
    });

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(submit).toBeEnabled();
    expect(screen.getAllByText(/approximately 400–500 tokens/i)).not.toHaveLength(0);
  });

  it('previews and downloads reviewed examples without importing or saving them', async () => {
    const exampleContent = validDocument(
      'encoded_powershell_execution',
      'Encoded PowerShell execution',
      'Investigate encoded or policy-bypassing PowerShell on a managed endpoint.',
    );
    const fetchExample = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(exampleContent),
    });
    vi.stubGlobal('fetch', fetchExample);
    mocks.getRunbooks.mockResolvedValue(response([]));

    renderRunbooks();
    fireEvent.click(await screen.findByRole('button', { name: /new runbook/i }));

    expect(screen.getByRole('heading', { name: /start from an example/i })).toBeInTheDocument();
    expect(screen.getByText(/never imports, saves, indexes, or executes/i)).toBeInTheDocument();
    expect(screen.getByText('Impossible travel sign-in')).toBeInTheDocument();
    expect(screen.getByText('Repetitive DNS beaconing')).toBeInTheDocument();

    for (const example of RUNBOOK_EXAMPLES) {
      const link = screen.getByRole('link', {
        name: new RegExp(`download ${example.title} example`, 'i'),
      });
      expect(link).toHaveAttribute('href', example.href);
      expect(link).toHaveAttribute('download', example.filename);
    }

    const heading = screen.getByRole('heading', { name: 'Encoded PowerShell execution' });
    const card = heading.closest('article');
    expect(card).not.toBeNull();
    const download = within(card as HTMLElement).getByRole('link', {
      name: /download encoded powershell execution example/i,
    });

    const editor = screen.getByLabelText(/runbook document/i) as HTMLTextAreaElement;
    const untouchedDraft = editor.value;
    download.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(download);
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: /^preview$/i }));

    expect(await screen.findByText(/id: encoded_powershell_execution/i)).toBeInTheDocument();
    expect(fetchExample).toHaveBeenCalledWith('/examples/runbooks/encoded-powershell.md', {
      cache: 'no-cache',
      credentials: 'same-origin',
    });
    expect(editor.value).toBe(untouchedDraft);
    expect(mocks.createRunbook).not.toHaveBeenCalled();
    expect(mocks.updateRunbook).not.toHaveBeenCalled();
    expect(mocks.submitJob).not.toHaveBeenCalled();
  });

  it('keeps downloads available when an inline example preview cannot load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('static asset unavailable')));
    mocks.getRunbooks.mockResolvedValue(response([]));

    renderRunbooks();
    fireEvent.click(await screen.findByRole('button', { name: /new runbook/i }));

    const heading = screen.getByRole('heading', { name: 'Impossible travel sign-in' });
    const card = heading.closest('article');
    expect(card).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: /^preview$/i }));

    expect(
      await screen.findByText(/preview could not be loaded.*try the direct download/i),
    ).toBeInTheDocument();
    expect(
      within(card as HTMLElement).getByRole('link', {
        name: /download impossible travel sign-in example/i,
      }),
    ).toHaveAttribute('href', '/examples/runbooks/impossible-travel-signin.md');
    expect(mocks.createRunbook).not.toHaveBeenCalled();
    expect(mocks.updateRunbook).not.toHaveBeenCalled();
  });

  it('renders structured backend 422 issues without a duplicate generic error panel', async () => {
    mocks.getRunbooks.mockResolvedValue(response([]));
    mocks.createRunbook.mockRejectedValue(
      new ApiError(
        422,
        'Runbook rejected. Fix the issues below and submit again.',
        {
          detail: {
            code: 'runbook_validation_failed',
            message: 'Runbook rejected. Fix the issues below and submit again.',
            issues: [
              {
                code: 'server.policy',
                field: 'summary',
                problem: 'The summary is not specific enough.',
                reason: 'Broad summaries reduce retrieval precision.',
                fix: 'Name the exact signal and affected entity.',
              },
            ],
          },
        },
      ),
    );

    renderRunbooks();
    fireEvent.click(await screen.findByRole('button', { name: /new runbook/i }));
    fireEvent.change(screen.getByLabelText(/runbook id/i), {
      target: { value: 'host_script_execution' },
    });
    fireEvent.change(screen.getByLabelText(/runbook document/i), {
      target: { value: validDocument('host_script_execution') },
    });
    fireEvent.click(screen.getByRole('button', { name: /create runbook/i }));

    expect(await screen.findByText('The summary is not specific enough.')).toBeInTheDocument();
    expect(screen.getByText('Broad summaries reduce retrieval precision.')).toBeInTheDocument();
    expect(screen.getByText('Name the exact signal and affected entity.')).toBeInTheDocument();
    expect(screen.queryByText('Runbook rejected. Fix the issues below and submit again.')).not.toBeInTheDocument();
    expect(mocks.toastError).toHaveBeenCalledWith('Runbook rejected—fix 1 issue below.');
  });
});

describe('Runbook authoring validator parity', () => {
  it('counts only the trimmed Unicode body and accepts ordinary underscores across CRLF and BOM', () => {
    const document = `\uFEFF${validDocument('field_name_case').replace(
      'process ancestry',
      'process_name and process ancestry',
    )}`.replaceAll('\n', '\r\n');
    const result = validateRunbookAuthoring(document, 'field_name_case');

    expect(result.issues).toEqual([]);
    expect(result.bodyCharacters).toBe(Array.from(result.body).length);
    expect(result.bodyCharacters).toBeLessThan(RUNBOOK_BODY_MAX_CHARS);
    expect(result.body).toContain('process_name and process ancestry');
  });

  it('returns all actionable formatting, structure, and metadata issues in one pass', () => {
    const invalid = validDocument('format_case')
      .replace('title: Suspicious PowerShell', 'title: **Suspicious PowerShell**')
      .replace('summary: Investigate', 'summary: [Describe] Investigate')
      .replace(
        'PowerShell starts with encoded content or a policy bypass on a managed host.',
        '# Signal detail\n**Bold** and _italic_ text with `code` and [link](https://example.test).\n| A | B |\n| --- | --- |',
      )
      .replace('2. Compare', '4. Compare')
      .concat('\n\nUNSUPPORTED SECTION\nThis content does not belong in the fixed scaffold.');

    const result = validateRunbookAuthoring(invalid, 'format_case');
    const codes = new Set(result.issues.map((entry) => entry.code));

    for (const code of [
      'manifest.title.format.bold',
      'manifest.summary.placeholder',
      'body.format.heading',
      'body.format.table',
      'body.format.bold',
      'body.format.italic',
      'body.format.inline_code',
      'body.format.link',
      'body.steps.sequence',
      'body.structure.label_unknown',
    ]) {
      expect(codes.has(code), code).toBe(true);
    }
    expect(result.issues.every((entry) => entry.problem && entry.reason && entry.fix)).toBe(true);
  });

  it('mirrors strict pipe, backtick, placeholder, and malformed-list rejection', () => {
    const invalid = validDocument('parity_case')
      .replace('persona: malware', 'persona: PLACEHOLDER | two')
      .replace('applies_to_rules: [powershell]', 'applies_to_rules: [`powershell`]')
      .replace('applies_to_entities: [host]', 'applies_to_entities: [host')
      .replace('keywords: [encodedcommand]', 'keywords: [placeholder]');

    const codes = new Set(
      validateRunbookAuthoring(invalid, 'parity_case').issues.map((entry) => entry.code),
    );

    for (const code of [
      'manifest.persona.format.table',
      'manifest.persona.placeholder',
      'manifest.applies_to_rules.format.code',
      'manifest.syntax.invalid_list',
      'manifest.keywords.placeholder',
    ]) {
      expect(codes.has(code), code).toBe(true);
    }
  });

  it('rejects scalar lists and every supported uppercase-label character', () => {
    const invalid = validDocument('shape_case')
      .replace(
        'summary: Investigate encoded PowerShell execution on a managed host.',
        'summary: [ambiguous]',
      )
      .concat(
        '\n\nUNSUPPORTED_LABEL / EXTRA-DETAIL\nThis guidance is outside the fixed scaffold.',
      );

    const codes = new Set(
      validateRunbookAuthoring(invalid, 'shape_case').issues.map((entry) => entry.code),
    );

    expect(codes.has('manifest.field.type')).toBe(true);
    expect(codes.has('body.structure.label_unknown')).toBe(true);
  });

  it('rejects a body over 1,800 Unicode characters with an exact repair instruction', () => {
    const document = validDocument('oversized_case').replace(
      'PowerShell starts with encoded content or a policy bypass on a managed host.',
      `PowerShell ${'activity '.repeat(230)}`,
    );
    const result = validateRunbookAuthoring(document, 'oversized_case');
    const issue = result.issues.find((entry) => entry.code === 'body.too_long');

    expect(result.bodyCharacters).toBeGreaterThan(RUNBOOK_BODY_MAX_CHARS);
    expect(issue?.problem).toContain('maximum is 1800');
    expect(issue?.fix).toContain('1800 Unicode characters or fewer');
  });

  it('enforces compact metadata fields, lists, and the aggregate retrieval descriptor', () => {
    const longValue = 'a'.repeat(65);
    const wideList = Array.from({ length: 13 }, (_, index) => `${'x'.repeat(62)}${index}`);
    const document = validDocument('metadata_budget_case')
      .replace('title: Suspicious PowerShell', `title: ${'T'.repeat(121)}`)
      .replace(
        'summary: Investigate encoded PowerShell execution on a managed host.',
        `summary: ${'S'.repeat(281)}`,
      )
      .replace('persona: malware', `persona: ${'P'.repeat(49)}`)
      .replace('applies_to_rules: [powershell]', `applies_to_rules: [${wideList.join(', ')}]`)
      .replace('applies_to_entities: [host]', `applies_to_entities: [${longValue}]`)
      .replace('keywords: [encodedcommand]', `keywords: [${wideList.slice(0, 12).join(', ')}]`);

    const result = validateRunbookAuthoring(document, 'metadata_budget_case');
    const codes = new Set(result.issues.map((entry) => entry.code));

    for (const code of [
      'manifest.title.too_long',
      'manifest.summary.too_long',
      'manifest.persona.too_long',
      'manifest.applies_to_rules.too_many',
      'manifest.applies_to_entities.item_too_long',
      'manifest.descriptor.too_long',
    ]) {
      expect(codes.has(code), code).toBe(true);
    }
    expect(result.descriptorCharacters).toBeGreaterThan(RUNBOOK_DESCRIPTOR_MAX_CHARS);
  });
});
