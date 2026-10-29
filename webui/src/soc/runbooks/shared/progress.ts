/**
 * Runbook progress in words (Round 14, SPEC §4.10.7 and §4.10.11): the chip text ("4/11",
 * "5/9 · 1 blocked", "4/11 · 1 waiting"), its accessible name, and the progress line
 * ("4 of 11 steps done · 1 not applicable · 5 required open · 1 waiting").
 *
 * Done counts only steps marked Done; Not applicable is counted on its own and never as
 * done. Shared by the case header, the Runbook tab trigger and the Case Manager queue
 * (W7b), and by the library (W7a). Pure, no React.
 */
import type { RunbookProgress } from '@/lib/types-runbooks';

function n(value: number): string {
  return Math.max(0, Math.trunc(value || 0)).toLocaleString();
}

/** "4/11", "5/9 · 1 blocked", "4/11 · 1 waiting" (blocked first, then waiting). */
export function progressChipText(p: RunbookProgress): string {
  let text = `${n(p.done)}/${n(p.total)}`;
  if (p.blocked > 0) text += ` · ${n(p.blocked)} blocked`;
  if (p.waiting > 0) text += ` · ${n(p.waiting)} waiting`;
  return text;
}

/** The chip's accessible name: "Runbook: 4 of 11 steps done, 1 blocked, 1 waiting for approval". */
export function progressChipLabel(p: RunbookProgress): string {
  const parts = [`${n(p.done)} of ${n(p.total)} ${p.total === 1 ? 'step' : 'steps'} done`];
  if (p.blocked > 0) parts.push(`${n(p.blocked)} blocked`);
  if (p.waiting > 0) parts.push(`${n(p.waiting)} waiting for approval`);
  return `Runbook: ${parts.join(', ')}`;
}

/**
 * The progress line above the phase tabs. `short` is the form for a pane under 640px:
 * "4 of 11 done · 5 required open · 1 waiting".
 */
export function progressLine(p: RunbookProgress, opts: { short?: boolean } = {}): string {
  const parts: string[] = [];
  parts.push(opts.short ? `${n(p.done)} of ${n(p.total)} done` : `${n(p.done)} of ${n(p.total)} ${p.total === 1 ? 'step' : 'steps'} done`);
  if (!opts.short && p.not_applicable > 0) parts.push(`${n(p.not_applicable)} not applicable`);
  if (p.required_open > 0) parts.push(`${n(p.required_open)} required open`);
  if (!opts.short && p.blocked > 0) parts.push(`${n(p.blocked)} blocked`);
  if (p.waiting > 0) parts.push(`${n(p.waiting)} waiting`);
  return parts.join(' · ');
}

/** True when every required step is Done or Not applicable (the run can complete). */
export function requiredStepsClear(p: RunbookProgress): boolean {
  return p.required_open <= 0;
}
