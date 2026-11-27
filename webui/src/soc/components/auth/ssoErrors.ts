/**
 * Single sign-on callback errors (Round 16 WP04, B25).
 *
 * A failed single sign-on callback redirects to `/login?sso_error=<code>`, and the code
 * comes from a closed list in the backend (`sso_callback`, backend/app/api/routes.py).
 * The sign-in page shows only the fixed sentence for a known code and one generic
 * sentence for anything else, so a crafted link can never put its own words on the
 * sign-in page. `login.sso-errors.test.tsx` reads the codes from routes.py and checks
 * that this list matches them exactly.
 */

/** The sentence for each code the backend sends. */
export const SSO_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  missing_code_or_state: 'The identity provider did not send a sign-in code. Try again.',
  state_not_bound: 'This sign-in started in another browser or tab. Start it again here.',
  invalid_state: 'The sign-in link expired. Try again.',
  unknown_provider: 'This single sign-on provider is not set up. Ask an administrator.',
  token_exchange_failed: 'The identity provider could not confirm the sign-in. Try again.',
  incomplete_identity: 'The identity provider did not share an email address for your account.',
  not_allowed: 'Your account is not allowed to sign in with single sign-on.',
  audit_unavailable: 'Sign-in is unavailable right now. Try again in a few minutes.',
  user_not_provisioned: 'No account exists for this identity yet. Ask an administrator to add you.',
  session_failed: 'The session could not start. Try again.',
});

/** The sentence for any code this Console does not know. */
export const SSO_ERROR_FALLBACK = 'Single sign-on failed. Try again.';

/** The fixed sentence for a callback code; the query value itself is never shown. */
export function ssoErrorMessage(code: string): string {
  return Object.prototype.hasOwnProperty.call(SSO_ERROR_MESSAGES, code)
    ? SSO_ERROR_MESSAGES[code]
    : SSO_ERROR_FALLBACK;
}
