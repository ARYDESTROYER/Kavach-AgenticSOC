/**
 * Roles as the run inside a case words them (Round 14, SPEC §3.1, §4.10.11; second
 * acceptance pass, wrb-10): an approval names its role by the label a person knows it by,
 * "Waiting for approval from a SOC manager", never the stored id ("soc_manager").
 *
 * The label comes from the server first (`role_labels` on the case's runs and on every
 * write's answer, from the role registry), then from the Console's one label map
 * (`ROLE_LABELS`), then from the role's own words (a custom role, "incident_lead" is
 * "Incident lead"). The article follows the sound of the role, by the same rule the
 * server's messages use (`runbook_runs._indefinite_article`, the `inflect` library's
 * rules), so the Console's "Only a SOC manager other than Asha Rao can approve." and the
 * API's refusal read alike: "a user admin", "an MSSP lead", "an HR partner", "a NOC lead",
 * "a USB admin", "an incident lead". A role is plain text; nothing here is markup (#9).
 *
 * The Console's own words for a role read as the server's `runbook_runs.role_label` does,
 * so a run whose answer carries no label for it (an older server, or the run Start runbook
 * just added) words it the same: hidden characters dropped, separators as spaces, runs of
 * spaces as one, an acronym told by its code points ("IR🔒" stays as written), at most 64
 * characters counted by code point (never half an emoji), and "Approver" when no word is
 * left ("-" or "__"). A built-in role is found by the server's `role_key` (Python's case
 * folding, so "ſoc_manager" is the SOC manager), and the article rules read Unicode as
 * Python's regular expressions do.
 */
import { ROLE_LABELS } from '@/soc/pages/Roles.api';

import { roleKey } from './model';

/** Every role the runs' steps name, by its label (`CaseRunbooks.role_labels`). */
export type RoleLabels = Readonly<Record<string, string>>;

/**
 * The most a role label shows, in code points (`RUNBOOK_ROLE_MAX_CHARS`; the server cuts
 * a custom role's words the same, by Python's `[:64]`).
 */
const ROLE_LABEL_MAX_CHARS = 64;

/** No role named: any approver. */
const NO_ROLE_LABEL = 'Approver';

/**
 * Hidden characters the server drops from a role (`unicodedata.category(ch)[0] == "C"`):
 * controls, format characters (a bidirectional override among them), a lone surrogate
 * half and private use. Unassigned code points are left to the server, whose Unicode
 * version differs from the browser's.
 */
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/gu;

/** At most {@link ROLE_LABEL_MAX_CHARS} code points, so a cut never splits a surrogate pair. */
function cut(text: string): string {
  return Array.from(text).slice(0, ROLE_LABEL_MAX_CHARS).join('').trimEnd();
}

/**
 * A role's own words, as the server's `runbook_runs._humanized` reads them, counted by code
 * point: separators as spaces, runs of spaces as one, the first character upper case, and
 * the rest lower case unless the role is written like an acronym ("IR lead" and "IR🔒" stay
 * as they are, "incident_lead" is "Incident lead"). Empty when no word is left. Kept here,
 * not in the shared `humanizeToken`, whose acronym test counts UTF-16 units and whose
 * empty answer is a dash.
 */
function humanizedRole(token: string): string {
  const spaced = token.replace(/[_-]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!spaced) return '';
  const [first, ...others] = Array.from(spaced);
  const rest = others.join('');
  const hasLower = /[a-z]/.test(spaced);
  const acronym =
    (hasLower && /[A-Z]/.test(rest)) || (!hasLower && Array.from(spaced.replace(/ /g, '')).length <= 3);
  return first.toUpperCase() + (acronym ? rest : rest.toLowerCase());
}

/** The built-in labels by role key ("SOC Manager" and "soc-manager" are `soc_manager`). */
const BUILTIN_LABELS: ReadonlyMap<string, string> = new Map(
  Object.entries(ROLE_LABELS).map(([role, label]) => [roleKey(role), label] as const),
);

/**
 * `role_labels` from a server answer, kept only when it is a map of non-empty strings (an
 * older server sends none; then every role falls back to the Console's own words).
 */
export function roleLabelsFrom(source: unknown): RoleLabels {
  const raw = source && typeof source === 'object' ? (source as { role_labels?: unknown }).role_labels : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [role, label] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof label !== 'string') continue;
    const clean = label.replace(HIDDEN_CHARS, '').trim();
    if (clean) out[role] = cut(clean);
  }
  return out;
}

/**
 * The name a person knows a role by: the server's label for it, else a built-in role's
 * label however the step writes it ("SOC manager"), else the role's own words as the server
 * reads them ({@link humanizedRole}: "incident_lead" is "Incident lead", "IR_lead" is
 * "IR lead"). "Approver" when the step names none.
 */
export function runRoleLabel(role: string | null | undefined, labels: RoleLabels = {}): string {
  const raw = String(role ?? '');
  if (!raw.trim()) return NO_ROLE_LABEL;
  const served = Object.prototype.hasOwnProperty.call(labels, raw) ? labels[raw] : undefined;
  if (served) return served;
  const builtin = BUILTIN_LABELS.get(roleKey(raw));
  if (builtin) return builtin;
  // Only separators ("-", "__") leave no word to read: any approver, as the server says.
  return cut(humanizedRole(raw.replace(HIDDEN_CHARS, ''))) || NO_ROLE_LABEL;
}

/*
 * The article rules below mirror the server's regular expressions, which Python reads with
 * Unicode rules: its `\b` ends a word before any character that is not a letter, a number
 * or "_" ("UK中" is one word), and its ignore-case "i" also matches "İ" and "ı" (its "s"
 * matches "ſ" and its "k" the Kelvin sign, as the `u` flag's case folding does here).
 */

/** The end of a word after a letter, by Python's Unicode `\b`. */
const WORD_END = '(?![\\p{L}\\p{N}_])';

/**
 * An initialism read letter by letter whose first letter's name starts with a vowel sound
 * ("an MSSP lead", "an HR partner", "an SRE"). The look-ahead leaves out an acronym read as
 * a word, a consonant cluster then a vowel ("a SOC manager", "a NOC lead", "a SIEM admin").
 */
const AN_INITIALISM =
  /^(?!FJO|[HLMNS]Y[^\n]|RY[EO]|SQU|(?:F[LR]?|[HL]|MN?|N|RH?|S[CHKLMNPTVW]?|X(?:YL)?)[AEIOU])[FHLMNRSX][A-Z]/;
/** A vowel letter said as a consonant sound ("a user admin", "a unit lead", "a European desk"). */
const A_BEFORE_VOWEL = new RegExp(
  `^(?:e[uw]|onc?e${WORD_END}|onet[iİı]me|un[iİı](?:[^nmd]|mo)|u[bcfghjkqrst][aeiouİı]|ukr)`,
  'iu',
);
/** A silent "h" ("an hourly reviewer", "an honorary lead"). */
const AN_SILENT_H = /^(?:hour(?![iİı])|he[iİı]r|honest|hono)/iu;
/**
 * A capitalised word that starts with U said from the letter's name "you": a short
 * initialism ("a USB admin", "a UX lead", "a URL owner") and the UN and UK words.
 */
const A_U_INITIALISM = new RegExp(`^U(?:[A-Z]{1,4}|[NK][AIEO]?[A-Z]*)${WORD_END}`, 'u');
/** A vowel letter first, by Python's ignore-case rules. */
const VOWEL_FIRST = /^[aeiouİı]/iu;

/** "a" or "an" before `noun`, by the sound of its first word. */
export function indefiniteArticle(noun: string): 'a' | 'an' {
  const word = noun.trim();
  if (!word) return 'a';
  const first = word.split(/\s+/)[0];
  // A letter by its name: "an X", "a B". One letter is one code point, as the server counts.
  if (Array.from(first).length === 1 && /\p{L}/u.test(first)) {
    return 'AEFHILMNORSX'.includes(first.toUpperCase()) ? 'an' : 'a';
  }
  if (AN_SILENT_H.test(word) || AN_INITIALISM.test(word)) return 'an';
  if (A_U_INITIALISM.test(word)) return 'a';
  if (!VOWEL_FIRST.test(word) || A_BEFORE_VOWEL.test(word)) return 'a';
  return 'an';
}

/** A role inside a sentence. */
export interface RoleWords {
  /** "SOC manager", "Incident lead": the label as a heading or a value shows it. */
  label: string;
  /** "SOC manager", "incident lead": the label inside a sentence ("a different SOC manager"). */
  noun: string;
  /** "a SOC manager", "an incident lead". */
  withArticle: string;
}

/**
 * A role as it reads inside a sentence, with its article. A leading capitalised word that
 * is not an acronym is lowered ("Incident lead" reads "an incident lead"); "SOC" keeps its
 * capitals ("a SOC manager").
 */
export function roleWords(role: string | null | undefined, labels: RoleLabels = {}): RoleWords {
  const label = runRoleLabel(role, labels);
  const noun = /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
  return { label, noun, withArticle: `${indefiniteArticle(noun)} ${noun}` };
}
