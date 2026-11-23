/**
 * OverviewPanel — anomaly-baseline advisory embedding (#4).
 *
 * The `BaselineSignatureCard` warm-up/percentile panel was fully built but shipped to
 * NO user — its stated purpose was a CaseDetail embedding that was never wired. It is
 * now mounted in the CaseDetail Overview when the case has a cluster signature AND the
 * baseline has recorded data for it. This spec pins:
 *   1. the embedded "Anomaly baseline" card renders when the case's cluster signature
 *      has baseline data (found=true), and the source-derived signature is plain text (#9);
 *   2. it FAILS QUIET — no panel when the case has no signature, when the baseline has
 *      no data for it (found=false / disabled), or when the fetch errors;
 *   3. advisory only (#3/#4) — the panel is read-only and never decides.
 *
 * The baseline fetch flows through `@/soc/Baseline.api` → `api.get('baseline/{sig}')`,
 * so we mock the low-level api client (no network). `RelatedCrossSource` (also in this
 * panel) uses `api.listCases`, mocked to an empty list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

const { getMock, listCasesMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  listCasesMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, listCases: listCasesMock },
}));

import { OverviewPanel } from '../OverviewPanel';
import type { Case } from '@/lib/types';
import type { BaselineSignature } from '@/soc/Baseline.api';

const WARM: BaselineSignature = {
  signature: 'sig::brute_force::10.0.0.5',
  found: true,
  warmup_target: 504,
  buckets: 3,
  warm_buckets: 2,
  seasonality: 'hour_of_week',
  series: [
    { bucket: 0, n: 504, target: 504, warm: true, progress: 1, p50: 12, p95: 40, p99: 88 },
    { bucket: 1, n: 200, target: 504, warm: false, progress: 200 / 504, p50: 9, p95: 30, p99: 61 },
  ],
};

function baseCase(extra: Partial<Case>): Case {
  return { case_id: 'c1', status: 'open', verdict: 'true_positive', ...extra } as unknown as Case;
}

function renderOverview(c: Case) {
  return render(
    <OverviewPanel c={c} fpPolicy={null} triage={null} />,
  );
}

/** Flush the best-effort baseline fetch chain (resolve → api.get → setData) under act. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('OverviewPanel — anomaly-baseline advisory (#4)', () => {
  beforeEach(() => {
    getMock.mockReset();
    listCasesMock.mockReset();
    listCasesMock.mockResolvedValue({ cases: [] });
  });

  it('embeds the "Anomaly baseline" card when the case signature has baseline data', async () => {
    getMock.mockResolvedValue(WARM);
    renderOverview(baseCase({ cluster_signature: WARM.signature }));

    expect(await screen.findByText('Anomaly baseline')).toBeInTheDocument();
    // Fetched the case's OWN cluster signature (encoded path).
    expect(getMock).toHaveBeenCalledWith(`baseline/${encodeURIComponent(WARM.signature)}`);
    // The source-derived signature renders as a plain text node (#9), never markup.
    expect(screen.getByText(WARM.signature)).toBeInTheDocument();
    // The warm-up gauge label surfaces the "N of M buckets warm" progress.
    expect(screen.getByText(/2 of 3 buckets warm/)).toBeInTheDocument();
  });

  it('renders NO baseline panel when the case has no cluster signature', () => {
    renderOverview(baseCase({}));
    expect(screen.queryByText('Anomaly baseline')).toBeNull();
    // No signature → no fetch at all.
    expect(getMock).not.toHaveBeenCalled();
  });

  it('fails quiet when the baseline has no data for the signature (found=false)', async () => {
    getMock.mockResolvedValue({ ...WARM, found: false, buckets: 0, warm_buckets: 0, series: [] });
    renderOverview(baseCase({ cluster_signature: 'sig::never-seen' }));

    // The panel itself mounts (Recommended action is always present)…
    await screen.findByText('Recommended action');
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    await flush();

    // …but the fail-quiet path shows nothing — never the "No baseline recorded" shell.
    expect(screen.queryByText('Anomaly baseline')).toBeNull();
    expect(screen.queryByText(/No baseline recorded/i)).toBeNull();
  });

  it('fails quiet when the baseline fetch errors (e.g. baseline disabled)', async () => {
    getMock.mockRejectedValue(new Error('baseline disabled'));
    renderOverview(baseCase({ cluster_signature: 'sig::x' }));

    await screen.findByText('Recommended action');
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await flush();

    expect(screen.queryByText('Anomaly baseline')).toBeNull();
  });
});
