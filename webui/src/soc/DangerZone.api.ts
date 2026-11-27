/**
 * DangerZone.api — shared, co-located reset vocabulary.
 *
 * The Console submits these values through the durable Jobs API as
 * `{kind:'tiered_reset', params:{scope, confirm}}`; destructive work never runs in
 * the browser. The server rechecks `users:manage` and bounded fresh authority both
 * at admission and before execution. The historical `/api/admin/reset` route is a
 * compatibility surface and is not the Console execution path.
 *
 * INVARIANTS this client is careful NOT to violate: it never selects an ES key (#1),
 * never touches `decide()` (#3 — reset DESTROYS cases, it never transitions one), and
 * env-provided secrets are NEVER cleared by any scope (enforced server-side; §6.6).
 * Co-located per the Round-4 convention (NOT in `lib/api.ts`) to avoid contending on
 * the shared client during parallel builds.
 */
/**
 * The three reset tiers, most→least conservative. Byte-matches the backend
 * `ResetScope` enum values (`constants.py:ResetScope`).
 */
export type ResetScope = 'cases' | 'sources' | 'factory';

/**
 * The exact GitHub-style type-to-confirm phrase the operator must type per scope.
 * The backend `_CONFIRM_PHRASE` map (`routes_reset.py:51`) validates the submitted
 * `confirm` against this — a mismatch is a 400 BEFORE any store is touched, so an
 * over-broad scope can never wipe more than exactly what was typed. Mirrored here so
 * the dialog can arm/disarm the destructive button purely client-side too (belt +
 * braces; the server is authoritative).
 */
export const RESET_CONFIRM_PHRASE: Record<ResetScope, string> = {
  cases: 'RESET CASES',
  sources: 'RESET SOURCES',
  factory: 'FACTORY RESET',
};
