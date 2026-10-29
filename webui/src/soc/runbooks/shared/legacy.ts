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
 *   2. a `payload.playbook_id` that one of the 9 retired bundled procedures held
 *      ({@link LEGACY_BUNDLED_PLAYBOOK_IDS}), through {@link LEGACY_BUNDLED_RUNBOOK_MAP}: such
 *      a rule ran the bundled procedure before the upgrade, never an operator document of the
 *      same id (the migration turned that document into a shadowed Draft);
 *   3. `payload.playbook_id` through the one-shot migration of the procedure documents (a
 *      runbook whose `migrated_from` names that id in the `playbook_dir` or `playbooks`
 *      namespace, the configured folder first); the reference runbooks were never
 *      procedures, so a `runbooks` namespace document never answers a rule;
 *   4. `payload.playbook_id` through {@link LEGACY_BUNDLED_RUNBOOK_MAP} (a retired reference
 *      runbook id).
 *
 * There is no further step: a `playbook_id` naming a new runbook id directly resolves to
 * nothing on the server, so it resolves to nothing here. A target that is unmapped,
 * unknown, a Draft only or retired is skipped by the server (`run.attach_skipped`), so the
 * editor says the rule needs a runbook. A built-in that a team's published copy replaces is
 * still attached when a rule names it (the server's `catalog.published`), so the caller
 * passes a library read with `show_replaced`.
 *
 * The server reads step 3 from the migration marker's id map; the client reads it from the
 * library's `migrated_from` fields, which hold the same pairs while the migrated runbook
 * exists.
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

/** The runbook the migration made from the legacy procedure `playbookId`, or null. */
function migratedProcedure(library: readonly RunbookSummary[], playbookId: string): RunbookSummary | null {
  for (const namespace of PROCEDURE_NAMESPACES) {
    const hit = library.find((r) => r.migrated_from?.namespace === namespace && r.migrated_from.id === playbookId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve a `run_playbook` rule's payload against the library. `library` null means the
 * library could not be read, so the status is `unknown` rather than a false warning.
 */
export function resolveAutomationRunbook(
  payload: Record<string, unknown> | null | undefined,
  library: readonly RunbookSummary[] | null,
): AutomationRunbookTarget {
  const runbookId = text(payload?.runbook_id);
  const playbookId = text(payload?.playbook_id);
  if (!runbookId && !playbookId) return { status: 'needs_runbook', id: null, runbook: null, via: null };
  if (!library) return { status: 'unknown', id: runbookId ?? playbookId, runbook: null, via: null };
  let id: string | null = null;
  let via: AutomationRunbookTarget['via'] = null;
  if (runbookId) {
    id = runbookId;
    via = 'runbook_id';
  } else if (playbookId) {
    const migrated = LEGACY_BUNDLED_PLAYBOOK_IDS.has(playbookId) ? null : migratedProcedure(library, playbookId);
    if (migrated) {
      id = migrated.id;
      via = 'migration';
    } else if (LEGACY_BUNDLED_RUNBOOK_MAP[playbookId]) {
      // A retired bundled procedure id (step 2) or a retired reference runbook id (step 4).
      id = LEGACY_BUNDLED_RUNBOOK_MAP[playbookId];
      via = 'legacy_map';
    }
  }
  const runbook = id ? library.find((r) => r.id === id) ?? null : null;
  return { status: isAttachable(runbook) ? 'attaches' : 'needs_runbook', id, runbook, via };
}
