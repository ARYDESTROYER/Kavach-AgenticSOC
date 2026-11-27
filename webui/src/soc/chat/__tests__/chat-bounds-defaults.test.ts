/**
 * `DEFAULT_CHAT_BOUNDS` (the composer's fallback while `/chat/context` is unavailable)
 * mirrors the backend `ChatAgentConfig` defaults (Round 14 SPEC §4.2.3, defect F16:
 * the fallback still said 30 s after Round 12 moved the model call timeout to 300 s).
 *
 * Every numeric bound is read back from `backend/app/config.py`, so a later change to a
 * default fails here instead of leaving a stale client fallback. `max_parallel` is the
 * effective value `/chat/context` reports; under the default Unlimited mode that is the
 * stored default itself.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CHAT_BOUNDS } from '../chat-api';

const source = readFileSync(path.resolve(process.cwd(), '..', 'backend', 'app', 'config.py'), 'utf8');
const start = source.indexOf('class ChatAgentConfig(BaseModel):');
const body = source.slice(start, source.indexOf('_MAX_INTERNAL_DOMAINS', start));
const defaults = new Map<string, number>();
for (const m of body.matchAll(/(\w+): int = Field\(\s*default=([\d_]+),/g)) {
  defaults.set(m[1], Number(m[2].replace(/_/g, '')));
}

describe('DEFAULT_CHAT_BOUNDS mirrors ChatAgentConfig', () => {
  it('found the backend class', () => {
    expect(start).toBeGreaterThan(0);
    expect(defaults.size).toBeGreaterThan(10);
  });

  it('uses the backend default for every numeric bound', () => {
    for (const [key, value] of Object.entries(DEFAULT_CHAT_BOUNDS)) {
      if (typeof value !== 'number') continue;
      expect(defaults.has(key), key).toBe(true);
      expect(value, key).toBe(defaults.get(key));
    }
  });

  it('carries the tripled Timeouts and capacity defaults (SPEC §4.2.1)', () => {
    expect(DEFAULT_CHAT_BOUNDS.max_parallel).toBe(12);
    expect(DEFAULT_CHAT_BOUNDS.tool_timeout_s).toBe(45);
    expect(DEFAULT_CHAT_BOUNDS.model_step_timeout_s).toBe(900);
  });

  it('uses the backend defaults for the answer switches', () => {
    expect(body).toMatch(/default_stream_mode: Literal\["steps", "text"\] = Field\(\s*default="steps"/);
    expect(DEFAULT_CHAT_BOUNDS.default_stream_mode).toBe('steps');
    expect(body).toMatch(/allow_text_streaming: bool = Field\(\s*default=True/);
    expect(DEFAULT_CHAT_BOUNDS.allow_text_streaming).toBe(true);
  });
});
