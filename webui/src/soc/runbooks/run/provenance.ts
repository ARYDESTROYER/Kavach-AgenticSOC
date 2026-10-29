/**
 * The runbook that guided a case's latest investigation (Round 14, SPEC §4.10.9), read
 * from the rationale endpoint (`GET /api/cases/{id}/rationale`): its `runbook` object and
 * `procedure_provenance.runbook`. Selected and consulted stay different facts: a runbook
 * can be matched and never reach the investigator (the cheap router path, the kill
 * switch, a guidance budget), and the Console never claims it was used then.
 *
 * The two halves are typed (`CaseRationale.runbook`, `RationaleProcedureProvenance.runbook`)
 * and still read value by value: an older server leaves them out, a run before Round 14
 * leaves them empty, and a version may arrive as text. Titles are Published operator text
 * and reasons are plain text (#9). Nothing here decides anything (#3).
 */
import type { CaseRationale, RationaleRunbook, RationaleRunbookProvenance } from '@/lib/types';

export interface RunbookGuidance {
  /** The runbook id the investigator received; empty when it never received one. */
  id: string;
  /** The runbook the matcher chose, even when the run never used it. */
  selectedId: string;
  version: number | null;
  title: string;
  reason: string;
  consulted: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function whole(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed > 0 ? parsed : null;
  }
  return null;
}

/** The latest run's runbook guidance, or null when no runbook was matched or received. */
export function rationaleRunbook(rationale: CaseRationale | null | undefined): RunbookGuidance | null {
  if (!rationale) return null;
  const top: RationaleRunbook | null = rationale.runbook ?? null;
  const procedure: RationaleRunbookProvenance | null = rationale.procedure_provenance?.runbook ?? null;
  const consulted = top?.consulted === true || procedure?.consulted === true;
  const id = text(top?.id) || (consulted ? text(procedure?.selected_id) : '');
  const selectedId = text(procedure?.selected_id) || text(top?.selected_id) || id;
  if (!id && !selectedId) return null;
  return {
    id,
    selectedId,
    version: whole(procedure?.version) ?? whole(top?.version),
    title: text(top?.title) || text(procedure?.title),
    reason: text(procedure?.selection_reason) || text(top?.reason),
    consulted: consulted && Boolean(id || selectedId),
  };
}

/** "Brute force and password spray · v4" (or the id when the title is not recorded). */
export function guidanceName(guidance: RunbookGuidance, withVersion = true): string {
  const name = guidance.title || guidance.id || guidance.selectedId;
  return withVersion && guidance.version !== null ? `${name} · v${guidance.version}` : name;
}
