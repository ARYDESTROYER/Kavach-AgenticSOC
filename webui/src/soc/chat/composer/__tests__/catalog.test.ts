/**
 * useComposerCatalog helpers: Options → Model lists only chat-capable models (an
 * embedding-only one would fail the turn with 422 `chat_model_unavailable`), an older
 * server without a capabilities map keeps the full list, and the sources request is
 * skipped for a caller the catalogue shows lacks `sources:read` (no 403 audit row).
 */
import { describe, expect, it } from 'vitest';
import type { ModelsResponse } from '@/lib/types';
import { modelOptions, sourcesReadable } from '../useComposerCatalog';
import { makeContext } from './fixtures';

const response = (extra: Record<string, unknown> = {}) =>
  ({
    providers: { openai: ['gpt-x', 'text-embedding-3-large', 'text-embedding-3-small'], anthropic: ['claude-test'] },
    configured: {},
    ...extra,
  }) as unknown as ModelsResponse;

describe('modelOptions', () => {
  it('keeps only models whose capabilities include chat', () => {
    const options = modelOptions(
      response({
        capabilities: {
          'gpt-x': ['chat'],
          'text-embedding-3-large': ['embedding'],
          'text-embedding-3-small': ['embedding'],
          'claude-test': ['chat', 'vision'],
        },
      }),
    );
    expect(options.map((o) => o.value)).toEqual(['gpt-x', 'claude-test']);
  });

  it('drops a model the map does not declare chat for (the server would refuse it)', () => {
    const options = modelOptions(response({ capabilities: { 'gpt-x': ['chat'], 'claude-test': [] } }));
    expect(options.map((o) => o.value)).toEqual(['gpt-x']);
  });

  it('falls back to the full list without a capabilities map (older server)', () => {
    expect(modelOptions(response()).map((o) => o.value)).toHaveLength(4);
    expect(modelOptions(response({ capabilities: ['chat'] })).map((o) => o.value)).toHaveLength(4);
  });

  it('ignores prototype keys in the map', () => {
    const options = modelOptions({
      providers: { x: ['constructor', 'gpt-x'] },
      configured: {},
      capabilities: { 'gpt-x': ['chat'] },
    } as unknown as ModelsResponse);
    expect(options.map((o) => o.value)).toEqual(['gpt-x']);
  });
});

describe('sourcesReadable', () => {
  it('waits for the context', () => {
    expect(sourcesReadable(null)).toBeNull();
  });

  it('is true when any sources:read tool is allowed', () => {
    expect(sourcesReadable(makeContext())).toBe(true);
    expect(sourcesReadable(makeContext({}, { search_logs: 'sources:read', log_stats: 'sources:read' }))).toBe(true);
  });

  it('is false when every sources:read tool is denied', () => {
    const deny = { search_logs: 'sources:read', log_stats: 'sources:read', source_health: 'sources:read' };
    expect(sourcesReadable(makeContext({}, deny))).toBe(false);
  });

  it('tries when the catalogue names no sources:read tool at all', () => {
    expect(sourcesReadable(makeContext({ tools: [] }))).toBe(true);
  });
});
