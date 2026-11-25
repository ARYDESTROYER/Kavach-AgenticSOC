/**
 * The simple release version form Agentic SOC uses (`0.2.0`, an optional leading `v`),
 * parsed and compared. Moved out of `upstream-release.ts` (Round 16 WP07) so the What's
 * new notes and the update notice share one definition.
 *
 * Pre-release and build suffixes are refused on purpose: ordering them needs full SemVer
 * precedence rules, and nothing that compares versions here needs them.
 */

export type SemanticVersion = [number, number, number];

/** `[major, minor, patch]` for `0.2.0` or `v0.2.0`, else `null`. */
export function semanticVersion(value: string | null | undefined): SemanticVersion | null {
  if (!value) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  const parsed = match.slice(1, 4).map(Number);
  if (parsed.some((part) => !Number.isSafeInteger(part))) return null;
  return parsed as SemanticVersion;
}

/** Negative when `left` is older, positive when newer, zero when equal. */
export function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
