/** Strict value guards for refresh-safe durable case-result routes. */

const SAFE_ASCII_TOKEN = /^[A-Za-z0-9_.:@ -]{1,128}$/;
const SAFE_CASE_ID = /^[A-Za-z0-9_.:@ /-]{1,128}$/;
const CASE_RESULT_STATUSES = new Set([
  'active',
  'new',
  'open',
  'needs_human',
  'investigating',
  'escalated',
  'on_hold',
  'resolved',
  'closed',
]);

// C0/C1 controls, bidi formatting/override controls, and decoded URL structure
// delimiters are not valid operator labels in a backend-authored destination.
// Normal international text remains valid and URLSearchParams re-encodes it.
const UNSAFE_CASE_RESULT_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f/?#&=%\\]/u;

function isBoundedCaseResultText(value: string, maxCodePoints: number): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    Array.from(value).length <= maxCodePoints &&
    !UNSAFE_CASE_RESULT_TEXT.test(value)
  );
}

export function isSafeRouteToken(value: string): boolean {
  return SAFE_ASCII_TOKEN.test(value);
}

/** URLSearchParams is forgiving; reject malformed percent escapes before parsing. */
export function hasValidRouteEncoding(value: string): boolean {
  try {
    decodeURIComponent(value.replace(/\+/g, '%20'));
    return true;
  } catch {
    return false;
  }
}

export function isSafeCaseId(value: string): boolean {
  return SAFE_CASE_ID.test(value);
}

export function isSafeCaseResultStatus(value: string): boolean {
  return CASE_RESULT_STATUSES.has(value);
}

/** Matches the backend's assignment bound while retaining normal Unicode names. */
export function isSafeCaseResultAssignee(value: string): boolean {
  return isBoundedCaseResultText(value, 80);
}

/** Matches the backend's tag bound while retaining normal Unicode labels. */
export function isSafeCaseResultTag(value: string): boolean {
  return isBoundedCaseResultText(value, 40);
}
