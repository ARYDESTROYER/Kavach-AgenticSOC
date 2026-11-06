/**
 * Stable DOM ids for the editor's fields (Round 14, SPEC F17). The issues summary moves
 * focus to the field a problem names, so every field the server can place an issue on is
 * findable from its step id (or the header) and its field path. A control carries the id
 * itself (`id`), or its wrapper carries it as `data-rb-field` (a Radix Select, whose
 * focusable trigger takes the Field's own id), and `focusField` finds either.
 */
const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function safe(part: string): string {
  return part.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'x';
}

/** The DOM id of a step field (`stepId` set) or a header field (`stepId` null). */
export function fieldDomId(stepId: string | null, field: string): string {
  return stepId == null ? `rb-header-${safe(field)}` : `rb-step-${safe(stepId)}-${safe(field)}`;
}

/**
 * The ids to try for an issue path, most specific first: `lookup.filter.source.ip` tries
 * the filter row, then the filter list, then the lookup section.
 */
export function fieldCandidates(stepId: string | null, field: string): string[] {
  const out: string[] = [];
  let path = field;
  while (path) {
    out.push(fieldDomId(stepId, path));
    const cut = Math.max(path.lastIndexOf('.'), path.lastIndexOf('['));
    if (cut <= 0) break;
    path = path.slice(0, cut);
  }
  return out;
}

/** Moves focus to the field an issue names. True when something took focus. */
export function focusField(stepId: string | null, field: string, root: ParentNode = document): boolean {
  for (const candidate of fieldCandidates(stepId, field)) {
    const el =
      (root.querySelector(`#${CSS.escape(candidate)}`) as HTMLElement | null) ??
      (root.querySelector(`[data-rb-field="${CSS.escape(candidate)}"]`) as HTMLElement | null);
    if (!el) continue;
    const target = el.matches(FOCUSABLE) ? el : (el.querySelector(FOCUSABLE) as HTMLElement | null);
    if (!target) continue;
    target.focus();
    target.scrollIntoView?.({ block: 'center' });
    return true;
  }
  return false;
}
