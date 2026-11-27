/**
 * notifyResultToast: the manual Notify toast sets the notification service's own
 * "dispatch" result apart from the channels before counting them.
 */
import { describe, expect, it } from 'vitest';
import { notifyResultToast } from '../notifyResult';

const ok = (channel_id: string, type = 'webhook') => ({ channel_id, type, ok: true });
const failed = (channel_id: string, detail: string, type = 'webhook') => ({
  channel_id,
  type,
  ok: false,
  detail,
});
const broken = (detail = 'dispatch error: KeyError') => failed('dispatch', detail, 'dispatch');

describe('notifyResultToast', () => {
  it('reads the per-channel results when the service did not fail', () => {
    expect(notifyResultToast([])).toEqual({
      kind: 'message',
      text: 'No channels matched, so nothing was sent.',
    });
    expect(notifyResultToast([ok('a'), ok('b', 'in_app')])).toEqual({
      kind: 'success',
      text: 'Notification sent to 2 channel(s).',
    });
    expect(notifyResultToast([failed('a', 'HTTP 500')])).toEqual({
      kind: 'error',
      text: 'Notification failed (HTTP 500).',
    });
    expect(notifyResultToast([ok('a'), failed('b', 'HTTP 500')])).toEqual({
      kind: 'warning',
      text: 'Sent to 1, 1 failed.',
    });
  });

  it('never counts the service record as a channel', () => {
    expect(notifyResultToast([ok('a'), broken()])).toEqual({
      kind: 'warning',
      text: 'Sent to 1 channel(s), then the notification service failed (KeyError).',
    });
    expect(notifyResultToast([ok('a'), failed('b', 'HTTP 500'), broken()])).toEqual({
      kind: 'warning',
      text: 'Sent to 1 channel(s), 1 failed, then the notification service failed (KeyError).',
    });
    expect(notifyResultToast([broken('dispatch error: RuntimeError')])).toEqual({
      kind: 'error',
      text: 'Not sent: the notification service failed (RuntimeError).',
    });
    expect(notifyResultToast([failed('a', 'HTTP 500'), broken()])).toEqual({
      kind: 'error',
      text: 'Not sent: the notification service failed (KeyError).',
    });
  });

  it('shows only an exception type, never free text, for the service failure', () => {
    expect(notifyResultToast([broken('dispatch error: https://hooks.example/x')]).text).toBe(
      'Not sent: the notification service failed (see audit log).',
    );
    expect(notifyResultToast([broken('')]).text).toBe(
      'Not sent: the notification service failed (see audit log).',
    );
  });
});
