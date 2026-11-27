/**
 * Shared Office Open XML (ECMA-376 transitional) helpers for the client-side DOCX and
 * XLSX exports (Round 12 SPEC WP-REP; SYNTHESIS-chat P1-7): XML escaping, the package
 * relationships and the document properties parts both formats carry.
 *
 * #9: every string that reaches a part goes through {@link xmlText} / {@link xmlAttr}.
 * Model- and log-derived text can carry characters XML 1.0 forbids (NUL, other C0
 * controls, lone surrogates, U+FFFE/U+FFFF); a single one makes Word and Excel refuse
 * the whole file as corrupt, so they are DROPPED, and `& < > " '` become entities. No
 * text is ever spliced into markup unescaped.
 */

import { xmlSafe } from '@/lib/xml-safe';

/** Drop the code points XML 1.0 cannot carry (shared with the chart image writer). */
export { xmlSafe };

/** Escape text for element content. */
export function xmlText(text: string): string {
  return xmlSafe(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape text for a double-quoted attribute value (line breaks kept as references). */
export function xmlAttr(text: string): string {
  return xmlText(text).replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
}

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const NS = {
  contentTypes: 'http://schemas.openxmlformats.org/package/2006/content-types',
  packageRels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  officeRels: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  coreProps: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
  worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  wordMain: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  sheetMain: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
} as const;

export const CONTENT_TYPE = {
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  wordDocument: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  wordStyles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  wordSettings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  wordFooter: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
  workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  sheetStyles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
} as const;

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external?: boolean;
}

/** A `.rels` part. */
export function relationshipsXml(rels: readonly Relationship[]): string {
  const body = rels
    .map(
      (r) =>
        `<Relationship Id="${xmlAttr(r.id)}" Type="${xmlAttr(r.type)}" Target="${xmlAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('');
  return `${XML_DECL}<Relationships xmlns="${NS.packageRels}">${body}</Relationships>`;
}

/** `[Content_Types].xml`: rels/xml defaults plus one override per part. */
export function contentTypesXml(overrides: ReadonlyArray<{ part: string; type: string }>): string {
  const body = overrides.map((o) => `<Override PartName="${xmlAttr(o.part)}" ContentType="${xmlAttr(o.type)}"/>`).join('');
  return (
    `${XML_DECL}<Types xmlns="${NS.contentTypes}">` +
    `<Default Extension="rels" ContentType="${CONTENT_TYPE.rels}"/>` +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `${body}</Types>`
  );
}

/** The package-level relationships: the main part plus the two property parts. */
export function packageRelsXml(mainPart: string): string {
  return relationshipsXml([
    { id: 'rId1', type: NS.officeDocument, target: mainPart },
    { id: 'rId2', type: NS.coreProps, target: 'docProps/core.xml' },
    { id: 'rId3', type: NS.extendedProps, target: 'docProps/app.xml' },
  ]);
}

/** W3CDTF without fractions (`2026-10-08T14:05:00Z`): what Office writes and reads. */
export function w3cdtf(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** `docProps/core.xml`: title, author and the export instant. */
export function corePropsXml(props: { title: string; creator: string | null; at: Date }): string {
  const when = w3cdtf(props.at);
  const creator = props.creator ? `<dc:creator>${xmlText(props.creator)}</dc:creator><cp:lastModifiedBy>${xmlText(props.creator)}</cp:lastModifiedBy>` : '';
  return (
    `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlText(props.title)}</dc:title>${creator}` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

/** `docProps/app.xml`: the producing application (never a data string). */
export function appPropsXml(): string {
  return (
    `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Agentic SOC</Application></Properties>'
  );
}
