/**
 * The toast a manual Notify shows for `POST /api/cases/{id}/notify`.
 *
 * The notification service returns one result per channel it tried, plus a result of
 * its own (`type` "dispatch", `channel_id` "dispatch") when the dispatch failed as a
 * whole. That record is not a channel, so it is set apart before the channels are
 * counted: a webhook that took the notification before the in-app fan-in raised reads
 * "Sent to 1 channel(s), then the notification service failed (KeyError).", never
 * "Sent to 1, 1 failed.". The record names the exception's type only (its text can
 * carry a channel's URL or address), the same reading the automation notify action
 * gives in the case's activity.
 */
import type { NotificationSendRecord } from '@/lib/types';

export interface NotifyToast {
  kind: 'message' | 'success' | 'warning' | 'error';
  text: string;
}

/** The `type` of the service's own result for a dispatch that failed as a whole. */
export const DISPATCH_FAILED_TYPE = 'dispatch';

/** The exception type a failed dispatch recorded, or a pointer to the audit log. */
function dispatchErrorKind(detail: string | undefined): string {
  const kind = String(detail ?? '')
    .replace(/^dispatch error:\s*/, '')
    .trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(kind) ? kind : 'see audit log';
}

export function notifyResultToast(sent: readonly NotificationSendRecord[]): NotifyToast {
  const broken = sent.find((s) => s.type === DISPATCH_FAILED_TYPE);
  const channels = sent.filter((s) => s.type !== DISPATCH_FAILED_TYPE);
  const okCount = channels.filter((s) => s.ok).length;
  const failCount = channels.length - okCount;
  if (broken) {
    const reason = `the notification service failed (${dispatchErrorKind(broken.detail)})`;
    if (okCount === 0) return { kind: 'error', text: `Not sent: ${reason}.` };
    const failed = failCount > 0 ? `, ${failCount} failed,` : ',';
    return { kind: 'warning', text: `Sent to ${okCount} channel(s)${failed} then ${reason}.` };
  }
  if (channels.length === 0) {
    return { kind: 'message', text: 'No channels matched, so nothing was sent.' };
  }
  if (failCount === 0) {
    return { kind: 'success', text: `Notification sent to ${okCount} channel(s).` };
  }
  if (okCount === 0) {
    return { kind: 'error', text: `Notification failed (${channels[0]?.detail || 'see audit log'}).` };
  }
  return { kind: 'warning', text: `Sent to ${okCount}, ${failCount} failed.` };
}
