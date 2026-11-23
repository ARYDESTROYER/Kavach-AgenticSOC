/**
 * Round 15 (SPEC D6.6, D6.12): the auto-close review client against the committed
 * OpenAPI contract, and its requests.
 *
 *   - every call names a real path and method of `openapi.json`, its query parameters
 *     are declared and its body fields belong to the declared request body;
 *   - the URL, method and body each call sends;
 *   - the module is lazy: no entry module imports it;
 *   - the browser listens on the `case.review` live channel the backend publishes (D6.5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAutoCloseReviewMetrics, getAutoCloseReviewSummary, listReviewCases, recordReview } from '../api-reviews';
import { STREAM_CHANNELS } from '../useEventStream';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..');
const spec = JSON.parse(readFileSync(resolve(SRC, '..', 'openapi.json'), 'utf8')) as {
  paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }>; requestBody?: unknown }>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};

function op(path: string, method: string) {
  const entry = spec.paths[path]?.[method];
  expect(entry, `${method.toUpperCase()} ${path}`).toBeTruthy();
  return entry!;
}

function queryNames(path: string, method: string): string[] {
  return (op(path, method).parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
}

afterEach(() => vi.restoreAllMocks());

function mockFetch(body: unknown = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('the review client against openapi.json', () => {
  it('names real operations, parameters and body fields', () => {
    op('/api/cases/{case_id}/review', 'post');
    const body = spec.components.schemas.ReviewBody.properties ?? {};
    expect(Object.keys(body).sort()).toEqual(
      ['accuracy', 'action_appropriateness', 'classification', 'elapsed_ms', 'note', 'reasoning_quality'],
    );
    op('/api/auto-close-review/summary', 'get');
    expect(queryNames('/api/metrics/auto-close-review', 'get')).toEqual(['window']);
    expect(queryNames('/api/cases', 'get')).toContain('review');
  });
});

describe('the review client requests', () => {
  it('posts a review to the case', async () => {
    const fetchMock = mockFetch({ agrees: true, can_reopen: true, sampled: true, review_id: 'acr-1' });
    const out = await recordReview('case/1', { classification: 'benign', elapsed_ms: 10 });
    expect(out.review_id).toBe('acr-1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/cases/case%2F1/review');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ classification: 'benign', elapsed_ms: 10 });
  });

  it('reads the summary, the metrics window and the review scope', async () => {
    const fetchMock = mockFetch({});
    await getAutoCloseReviewSummary();
    await getAutoCloseReviewMetrics('now-7d');
    await listReviewCases('pending', { limit: 50 });
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown as [string])[0]));
    expect(urls[0]).toBe('/api/auto-close-review/summary');
    expect(urls[1]).toBe('/api/metrics/auto-close-review?window=now-7d');
    expect(urls[2]).toMatch(/^\/api\/cases\?/);
    expect(urls[2]).toContain('review=pending');
    expect(urls[2]).toContain('limit=50');
  });
});

describe('laziness', () => {
  it('is imported by no module outside the review features', () => {
    const allowed = [
      'lib/api-reviews.ts',
      'soc/pages/casedetail/review/',
      'soc/pages/effectiveness/',
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const rel = full.slice(SRC.length + 1).split('\\').join('/');
        const text = readFileSync(full, 'utf8');
        if (/from ['"]@\/lib\/api-reviews['"]|from ['"]\.\/api-reviews['"]/.test(text)) {
          if (!allowed.some((a) => rel.startsWith(a))) offenders.push(rel);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

describe('the live review nudge', () => {
  it('is a channel the shared stream listens on, so a queue can refresh its review count', () => {
    expect(STREAM_CHANNELS as readonly string[]).toContain('case.review');
  });
});
