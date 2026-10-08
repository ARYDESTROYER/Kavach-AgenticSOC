/**
 * Indicator defanging for exports and the clipboard (chat revamp SPEC §9.3, BLOCKS.md
 * amendment 9).
 *
 * A pasted or exported IOC must not be clickable or resolvable by the tool it lands in
 * (a mail client, a wiki, a ticket). Defanging is ON by default for Markdown, HTML,
 * Print and Copy data, is a toggle in the export menu, is never applied to the live UI
 * and never to JSON (a machine format must round-trip exactly).
 *
 *   `http://` → `hxxp://`, `ftp://` → `fxp://`, dots in IPv4 addresses and host names
 *   → `[.]`, `@` in e-mail addresses → `[@]`.
 *
 * Idempotent: an already defanged value is left alone. Pure string transform.
 */

const URL_SCHEME_RE = /\b(h)(tt)(ps?)(:\/\/)/gi;
const FTP_SCHEME_RE = /\b(f)(t)(p)(:\/\/)/gi;
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
const EMAIL_RE = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;
// A dotted host name ending in a letter TLD (`evil.example.com`), not a version number.
const DOMAIN_RE = /\b((?:[A-Za-z0-9-]+\.)+)([A-Za-z]{2,24})\b/g;

/**
 * File extensions that are NOT top-level domains, so `svchost.exe`, `cmd.exe` and
 * `report.docx` are left readable. Extensions that ARE delegated TLDs (`.zip`, `.mov`,
 * `.sh`, `.py`) are deliberately absent: a missed defang is worse than an extra `[.]`.
 */
const NOT_A_TLD = new Set([
  'exe', 'dll', 'sys', 'drv', 'ocx', 'cpl', 'scr', 'bat', 'cmd', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'lnk',
  'msi', 'msp', 'jar', 'class', 'pyc', 'bin', 'dat', 'tmp', 'log', 'txt', 'ini', 'cfg', 'conf', 'json',
  'xml', 'yaml', 'yml', 'csv', 'tsv', 'doc', 'docx', 'docm', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pdf',
  'rtf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico', 'iso', 'img', 'vhd', 'vhdx', 'rar', 'gz',
  'tgz', 'tar', 'xz', 'evtx', 'etl', 'reg', 'inf', 'sqlite', 'db',
]);

/**
 * Is `tld` plausibly a top-level domain? Not a known non-TLD file extension, and
 * single-cased: DNS names in logs are lower (or upper) case, while `Mr.Smith` or
 * `end.Next` are prose.
 */
function plausibleTld(tld: string): boolean {
  if (NOT_A_TLD.has(tld.toLowerCase())) return false;
  return tld === tld.toLowerCase() || tld === tld.toUpperCase();
}

/**
 * Defang indicators in free text so a pasted IOC cannot be clicked or resolved.
 * Idempotent (an already defanged value is left alone).
 */
export function defang(text: string): string {
  let out = text.replace(URL_SCHEME_RE, (_m, _h, _tt, p: string, sep: string) => `hxx${p}${sep}`);
  out = out.replace(FTP_SCHEME_RE, (_m, _f, _t, _p, sep: string) => `fxp${sep}`);
  out = out.replace(EMAIL_RE, (_m, user: string, host: string) => `${user}[@]${host}`);
  out = out.replace(IPV4_RE, '$1[.]$2[.]$3[.]$4');
  out = out.replace(DOMAIN_RE, (m: string, _host: string, tld: string) => (plausibleTld(tld) ? m.replace(/\./g, '[.]') : m));
  return out;
}

/** `defang(text)` when `on`, the text unchanged otherwise (the export-menu toggle). */
export function maybeDefang(text: string, on: boolean): string {
  return on ? defang(text) : text;
}
