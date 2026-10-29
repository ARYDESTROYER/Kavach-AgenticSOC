/**
 * Which runbook a case-automation rule attaches (Round 14, SPEC §4.10.16). A rule's stored
 * action stays the existing `run_playbook` literal (the naming contract); the rule editor's
 * "Attach a runbook" writes `payload.runbook_id` and, for compatibility, `payload.playbook_id`
 * with the same id. At fire time the server resolves the target
 * (`resolve_automation_runbook_id` in `backend/app/engine/runbook_model.py`) in this order,
 * and the editor mirrors it exactly to show "Needs a runbook" on a rule whose target will be
 * skipped:
 *
 *   1. `payload.runbook_id`;
 *   2. `payload.playbook_id` through the one-shot migration's id map (the marker's `id_map`
 *      for the procedure sources, `migrated_procedure_ids` in
 *      `backend/app/engine/runbook_migration.py`): the procedure the rule ran, as migrated.
 *      The configured folder (`playbook_dir`) answers first, then the stored documents
 *      (`playbooks`). A retired bundled procedure id ({@link LEGACY_BUNDLED_PLAYBOOK_IDS}) is
 *      answered by the folder only: a stored document with that id never ran from a rule
 *      (the bundled procedure won the id, so the migration made the document a shadowed
 *      Draft). The reference runbooks (`runbooks`) were never procedures, so they never
 *      answer a rule;
 *   3. `payload.playbook_id` through {@link LEGACY_BUNDLED_RUNBOOK_MAP}: the built-in that
 *      merged a retired bundled procedure or reference runbook, for a rule the migration
 *      answers nothing for.
 *
 * There is no further step: a `playbook_id` naming a new runbook id directly resolves to
 * nothing on the server, so it resolves to nothing here. A target that is unmapped,
 * unknown, a Draft only or retired is skipped by the server (`run.attach_skipped`), so the
 * editor says the rule needs a runbook. A built-in that a team's published copy replaces is
 * still attached when a rule names it (the server's `catalog.published`), so the caller
 * passes a library read with `show_replaced`.
 *
 * Step 2 prefers the server's own map, which the library read carries as
 * `RunbookLibrary.migrated_procedures`, so callers pass it. A caller that holds only the
 * rows gets the map rebuilt from their `migrated_from` fields, which hold the same pairs
 * only while the migrated runbook is in the library: once that runbook is gone the rows
 * cannot show the mapping, and a retired bundled procedure id falls through to step 3.
 *
 * The server filters that map to the runbooks the viewer may see. For a viewer without
 * `runbooks:manage` or `runbooks:publish` it leaves out an entry whose runbook that viewer
 * may not see (a Draft, or a runbook that is gone), so a retired bundled procedure id
 * migrated to such a runbook resolves here through {@link LEGACY_BUNDLED_RUNBOOK_MAP} and
 * reads as attaching the built-in, while the server skips the rule. The server never
 * discloses that entry to this viewer, so the editor cannot tell. Any other id the map
 * leaves out resolves to nothing, so it still reads as needing a runbook.
 */
import type { RunbookSummary } from '@/lib/types-runbooks';

/** Each retired bundled procedure id to the built-in runbook that merged it (mirror of the server map). */
export const LEGACY_BUNDLED_RUNBOOK_MAP: Readonly<Record<string, string>> = {
  brute_force_login: 'brute-force-password-spray',
  cloud_identity_compromise: 'cloud-identity-keys',
  data_exfiltration_response: 'data-exfiltration',
  phishing_reported_email: 'phishing-suspicious-email',
  privileged_web_access: 'privileged-misuse-insider',
  ransomware_response: 'ransomware-destructive',
  suspicious_outbound_connection: 'suspicious-outbound',
  web_application_abuse: 'web-application-attack',
  web_scanner_activity: 'scanning-reconnaissance',
  brute_force: 'brute-force-password-spray',
  cloud_iam_compromise: 'cloud-identity-keys',
  data_exfiltration: 'data-exfiltration',
  ip_reputation: 'suspicious-outbound',
  mail_abuse: 'phishing-suspicious-email',
  malware: 'malware-endpoint',
  port_scan: 'scanning-reconnaissance',
  vuln_scan: 'scanning-reconnaissance',
  web_attack: 'web-application-attack',
};

/** The 9 ids the retired bundled procedures held (mirror of the server's `LEGACY_BUNDLED_PLAYBOOK_IDS`). */
export const LEGACY_BUNDLED_PLAYBOOK_IDS: ReadonlySet<string> = new Set([
  'brute_force_login',
  'cloud_identity_compromise',
  'data_exfiltration_response',
  'phishing_reported_email',
  'privileged_web_access',
  'ransomware_response',
  'suspicious_outbound_connection',
  'web_application_abuse',
  'web_scanner_activity',
]);

/** The migration namespaces a rule could run before Round 14, in the server's order (folder first). */
export const PROCEDURE_NAMESPACES: readonly string[] = ['playbook_dir', 'playbooks'];

export type AutomationRunbookStatus = 'attaches' | 'needs_runbook' | 'unknown';

export interface AutomationRunbookTarget {
  status: AutomationRunbookStatus;
  /** The runbook id the rule resolves to, when it resolves to one. */
  id: string | null;
  /** The library row of that runbook, when it is in the library. */
  runbook: RunbookSummary | null;
  /** How the id was found. */
  via: 'runbook_id' | 'migration' | 'legacy_map' | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A runbook a rule can attach: one with a live version that is not retired. */
export function isAttachable(r: RunbookSummary | null | undefined): boolean {
  return !!r && r.live_version != null && !r.retired;
}

/**
 * The migration's procedure map rebuilt from the library rows: legacy procedure id to the
 * runbook made from it, with the server's precedence (`migrated_procedure_ids`): the
 * configured folder first, then the stored documents, and never a stored document that
 * holds a retired bundled procedure id (it never ran from a rule).
 */
export function migratedProceduresFromLibrary(library: readonly RunbookSummary[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const namespace of PROCEDURE_NAMESPACES) {
    for (const row of library) {
      const from = row.migrated_from;
      if (!from || from.namespace !== namespace || typeof from.id !== 'string' || !from.id) continue;
      if (namespace === 'playbooks' && LEGACY_BUNDLED_PLAYBOOK_IDS.has(from.id)) continue;
      if (!Object.prototype.hasOwnProperty.call(out, from.id)) out[from.id] = row.id;
    }
  }
  return out;
}

/**
 * The runbook id `map` holds for `playbookId`, read as the server's dictionary lookup reads
 * it: own keys only (a `playbook_id` such as `constructor` names nothing), trimmed text.
 */
function mappedId(map: Readonly<Record<string, string>>, playbookId: string): string | null {
  return Object.prototype.hasOwnProperty.call(map, playbookId) ? text(map[playbookId]) : null;
}

/**
 * Resolve a `run_playbook` rule's payload against the library. `library` null means the
 * library could not be read, so the status is `unknown` rather than a false warning.
 * `migratedProcedures` is the server's map from the same library read
 * (`RunbookLibrary.migrated_procedures`); when it is absent the map is rebuilt from the
 * rows ({@link migratedProceduresFromLibrary}).
 */
export function resolveAutomationRunbook(
  payload: Record<string, unknown> | null | undefined,
  library: readonly RunbookSummary[] | null,
  migratedProcedures?: Readonly<Record<string, string>> | null,
): AutomationRunbookTarget {
  const runbookId = text(payload?.runbook_id);
  const playbookId = text(payload?.playbook_id);
  if (!runbookId && !playbookId) return { status: 'needs_runbook', id: null, runbook: null, via: null };
  if (!library) return { status: 'unknown', id: runbookId ?? playbookId, runbook: null, via: null };
  let id: string | null = null;
  let via: AutomationRunbookTarget['via'] = null;
  if (runbookId) {
    // Step 1.
    id = runbookId;
    via = 'runbook_id';
  } else if (playbookId) {
    const map =
      migratedProcedures && typeof migratedProcedures === 'object'
        ? migratedProcedures
        : migratedProceduresFromLibrary(library);
    const migrated = mappedId(map, playbookId);
    if (migrated) {
      // Step 2.
      id = migrated;
      via = 'migration';
    } else {
      // Step 3: a retired bundled procedure id or a retired reference runbook id.
      id = mappedId(LEGACY_BUNDLED_RUNBOOK_MAP, playbookId);
      via = id ? 'legacy_map' : null;
    }
  }
  const runbook = id ? library.find((r) => r.id === id) ?? null : null;
  return { status: isAttachable(runbook) ? 'attaches' : 'needs_runbook', id, runbook, via };
}
