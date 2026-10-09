/**
 * "Ask about this" topic contract (SPEC §10.7, A7): every topic id the console emits
 * (KPI help popovers, Settings section headers) exists in the committed
 * `backend/app/knowledge/console_map.json` and is a well-formed console-link id, so a
 * click can never reach the chat page with a topic the server would 404.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS_META } from '@/soc/pages/settings/settings-sections-meta';
import { CONSOLE_TOPIC_RE, REQUEST_TOPIC_RE } from '@/soc/chat/topic';
import { KPI_TOPICS, kpiTopic, settingsTopic } from '../ask-topics';

const MAP_PATH = path.resolve(process.cwd(), '..', 'backend', 'app', 'knowledge', 'console_map.json');

function consoleTopicIds(): Set<string> {
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as { topics: Array<{ id: string }> };
  return new Set(map.topics.map((t) => t.id));
}

describe('Ask about this topics', () => {
  const known = consoleTopicIds();

  it('every KPI topic exists in console_map and fits both grammars', () => {
    for (const [anchor, topic] of Object.entries(KPI_TOPICS)) {
      expect(known.has(topic), `${anchor} → ${topic}`).toBe(true);
      expect(CONSOLE_TOPIC_RE.test(topic), topic).toBe(true);
      expect(REQUEST_TOPIC_RE.test(topic), topic).toBe(true);
    }
  });

  it('every Settings section header topic exists in console_map', () => {
    for (const section of SETTINGS_SECTIONS_META) {
      const topic = settingsTopic(section.id);
      expect(known.has(topic), topic).toBe(true);
      expect(CONSOLE_TOPIC_RE.test(topic), topic).toBe(true);
    }
  });

  it('maps only known anchors (no prototype keys, no unknown ids)', () => {
    expect(kpiTopic('mttr')).toBe('kpi:mttr');
    expect(kpiTopic('total-cases')).toBe('kpi:total_cases');
    expect(kpiTopic('toString')).toBeUndefined();
    expect(kpiTopic('nope')).toBeUndefined();
    expect(kpiTopic(undefined)).toBeUndefined();
  });
});
