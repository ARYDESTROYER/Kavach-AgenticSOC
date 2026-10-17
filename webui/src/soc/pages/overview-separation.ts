/**
 * Overview card separation — a TEMPORARY preview switch (Round 13).
 *
 * The operator asked how the Overview's cards could read as separate modules without
 * bringing back heavy boxes. Four candidate treatments ship side by side behind this
 * switch so they can be compared on live data before one is chosen:
 *
 *   grouped    Grouped surfaces: soft tinted surfaces, generous radius, no border or shadow
 *   hairlines  Hairlines: flat modules with thin rules in the gutters between siblings
 *   titled     Titled modules: no boxes, a compact header row with a rule under it
 *   bordered   Bordered cards: a card surface with a quiet 1px border, no shadow
 *
 * The switch is read ONCE when the Overview mounts, from `?separation=<id>` in the page
 * URL or in the hash route (`#/overview?separation=grouped`), and remembered in
 * sessionStorage for the rest of the session. `a`..`d` are accepted as short aliases, and
 * `raised` (the first name of option D, when it still had a resting shadow) still works;
 * `current` (or `none` / `off` / `default`) forgets the stored choice. With no value the
 * Overview renders exactly as it did before: the styles live in `theme.css`, scoped under
 * `[data-ov-sep]`, and nothing matches while the attribute is absent.
 *
 * Remove this module, the `data-ov*` hooks in Overview.tsx and the scoped block in
 * theme.css once the operator has picked one (the winner then becomes the default).
 */

export const SEPARATION_IDS = ['grouped', 'hairlines', 'titled', 'bordered'] as const;
export type SeparationId = (typeof SEPARATION_IDS)[number];

/** Human labels for the preview, in the order the options are presented. */
export const SEPARATION_LABELS: Record<SeparationId, string> = {
  grouped: 'Grouped surfaces',
  hairlines: 'Hairlines',
  titled: 'Titled modules',
  bordered: 'Bordered cards',
};

/** sessionStorage key of the remembered preview choice. */
export const SEPARATION_SESSION_KEY = 'soc.overview.separationPreview';

const ALIASES: Record<string, SeparationId> = {
  a: 'grouped',
  b: 'hairlines',
  c: 'titled',
  d: 'bordered',
  raised: 'bordered',
};

const CLEAR_VALUES = new Set(['current', 'none', 'off', 'default']);

function isSeparationId(value: string): value is SeparationId {
  return (SEPARATION_IDS as readonly string[]).includes(value);
}

/** Normalise one raw value: an id, an alias, a clear request, or nothing usable. */
export function parseSeparation(raw: string | null | undefined): SeparationId | 'clear' | null {
  if (raw == null) return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (CLEAR_VALUES.has(value)) return 'clear';
  if (isSeparationId(value)) return value;
  return ALIASES[value] ?? null;
}

/** The `separation` parameter from the URL query, or from the hash route's own query. */
function paramFromLocation(loc: Pick<Location, 'search' | 'hash'>): string | null {
  try {
    const fromSearch = new URLSearchParams(loc.search || '').get('separation');
    if (fromSearch != null) return fromSearch;
    const hash = loc.hash || '';
    const q = hash.indexOf('?');
    if (q === -1) return null;
    return new URLSearchParams(hash.slice(q + 1)).get('separation');
  } catch {
    return null;
  }
}

function safeSession(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * The preview treatment to render, or null for today's look. A value in the URL wins and
 * is remembered for the session; otherwise the remembered value applies. Storage that is
 * blocked or throws simply means the choice lasts for this mount.
 */
export function readSeparationPreview(
  loc: Pick<Location, 'search' | 'hash'> | null = typeof window !== 'undefined'
    ? window.location
    : null,
  storage: Storage | null = safeSession(),
): SeparationId | null {
  const fromUrl = loc ? parseSeparation(paramFromLocation(loc)) : null;
  if (fromUrl === 'clear') {
    try {
      storage?.removeItem(SEPARATION_SESSION_KEY);
    } catch {
      /* storage blocked */
    }
    return null;
  }
  if (fromUrl) {
    try {
      storage?.setItem(SEPARATION_SESSION_KEY, fromUrl);
    } catch {
      /* storage blocked: the choice lasts for this mount */
    }
    return fromUrl;
  }
  let stored: string | null = null;
  try {
    stored = storage?.getItem(SEPARATION_SESSION_KEY) ?? null;
  } catch {
    stored = null;
  }
  const parsed = parseSeparation(stored);
  return parsed && parsed !== 'clear' ? parsed : null;
}
