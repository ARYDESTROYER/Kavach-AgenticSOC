/**
 * A search hit's snippet as plain text (Round 13, SPEC-chat T27). The conversation
 * search cuts each snippet from the stored answer, which is Markdown with its line
 * breaks folded to spaces, so its markers would show literally ("**65 cases**"). Shared
 * by the history rail and the command palette's chat results; a tiny module so the
 * lazily loaded palette search does not pull in the rail.
 */

/** Markdown markers outside code spans (see {@link plainSnippet}). */
function plainProse(text: string): string {
  return (
    text
      // Links and images keep their text; a link the cut ended inside keeps it too.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*$/, '$1')
      // Bold and strikethrough (the cut can leave one half: "**65…").
      .replace(/\*\*|~~/g, '')
      .replace(/(^|[^\w\\])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '$1$2')
      // Heading markers, now mid-line once the line breaks were folded. A bullet or a
      // quote marker only at the start: mid-line, " * " and " > " may be arithmetic.
      .replace(/(^|\s)#{1,6}(?=\s)/g, '$1')
      .replace(/^(\u2026)?\s*(?:[*+-]|>)\s+/, '$1')
      // Single * or _ emphasis, in pairs only: "*.exe" and "_source" stay as written.
      .replace(/(^|[\s([{"'\u2026])([*_])(?=[^\s*_])(.+?)(?<=[^\s*_\\])\2(?=$|[\s).,;:!?\]}"'\u2026])/g, '$1$3')
      // A code span the cut opened but did not close.
      .replace(/`+/g, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
  );
}

/**
 * A search hit's snippet as plain text (Round 13, T27). The server cuts it from the
 * stored answer, which is Markdown with its line breaks folded to spaces, so markers
 * would show literally ("**65 cases**") in the rail and in the hit's name. Drops bold,
 * italic, strikethrough and code markers, heading markers and a leading bullet or
 * quote marker, and reduces links and images to their text. A code span's text stays
 * exactly as written ("`*.exe`" reads "*.exe"), and so do arithmetic ("3 * 4",
 * "risk > 70") and identifiers ("case_id", "_source").
 */
export function plainSnippet(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .split(/(`+[^`]+`+)/)
    .map((part, index) => (index % 2 ? part.replace(/^`+|`+$/g, '') : plainProse(part)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
