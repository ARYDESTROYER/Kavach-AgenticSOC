# R12 research: "Remember me" for the Agentic SOC console

Scope: the user's request. *"Upon logging in there should be an option saying 'Remember me'.
When users check it, it shows the obvious warning. Once accepted, it should remember the
username and password, but auth should still be asked occasionally, maybe once a day or
once every 6 hours."*

This document covers four things: the standards, what competitors do, how sessions work in
the repository today (checked against the code and a live probe), and a concrete design
covering backend, UI, settings, copy, tests and docs.

---

## 0. TL;DR (decisions)

1. **Never store the password in app storage.** "Remember my password" means using the
   **browser password manager**. Three changes support it:
   - correct `autocomplete` attributes (already present);
   - a **hidden `autocomplete="username"` field in the password step**, which is missing
     today and which Chromium documents as required for two-step sign-in;
   - in Chromium only, an explicit `navigator.credentials.store(new PasswordCredential(...))`
     after a successful sign-in with the box checked.

   The **username** is remembered in `localStorage` (`soc.login.rememberedUsername`). It is
   not a secret, and it is stored only after a successful sign-in with the box checked.
2. **"Remember me" means a persistent, server-bounded session.**
   - **Checked:** a persistent `tlsoc_token` cookie with `Max-Age = remember_duration`. The
     JWT `exp` is the same duration, and the registry row carries `remember: true`. The
     server enforces an **overall (absolute) re-authentication timeout** chosen by the admin:
     **6 h / 12 h / 24 h, default 24 h**. 24 h is the NIST SP 800-63B-4 AAL2 ceiling.
   - **Unchecked:** a **non-persistent session cookie** (no Max-Age), plus the existing
     server idle and absolute limits.
   - The server registry is always authoritative. NIST says cookie expiry "SHALL NOT be
     relied upon".
3. **Remember-me never bypasses MFA or step-up.**
   - Every new sign-in after expiry runs the full password + MFA flow.
   - `require_fresh_auth` (the 10-minute sudo window) still gates sensitive actions inside
     a remembered session.
   - There is no "trust this device for MFA" option in this round.
4. **The admin can disable it, change the duration, exclude roles, and decide whether it is
   allowed over plain HTTP.** The admin controls are a new block in **Settings → Security →
   Session policy**. The login page learns the policy from the existing **public
   `GET /api/setup/status`**, so no new public path is needed.
5. **Warning:** checking the box opens a **confirmation dialog** (Radix AlertDialog, the
   existing `ConfirmDialog` pattern) with shared- or public-device copy.
   - Choosing **"Keep me signed in"** checks the box.
   - Choosing **Cancel** leaves it unchecked.
   - Acceptance is recorded per device, so the dialog does not nag on every visit.
6. **Fix a pre-existing bug this feature depends on.** `GET /api/auth/me` ignores the
   session registry. Verified live: after revoking a session, `/api/cases` returns 401 but
   `/api/auth/me` still says `authenticated: true`. Because the webui's 401 handler only
   calls `refresh()`, a revoked or expired session leaves the user **stuck in a console
   where every call 401s** instead of on the sign-in page. With longer, remembered sessions
   this would happen every time a session ages out. `/auth/me` must run the same registry
   check, clear the cookie, and report a `reason`.

---

## 1. Standards and guidance (with citations)

### 1.1 NIST SP 800-63B-4 (final, 2025)
Source: https://pages.nist.gov/800-63-4/sp800-63b.html (Sec. 2.x "Reauthentication") and
https://pages.nist.gov/800-63-4/sp800-63b/session/ (Sec. 5.1 and 5.2).

Reauthentication timeouts by assurance level:

| AAL | Overall (absolute) timeout | Inactivity timeout | Notes |
|---|---|---|---|
| AAL1 | "SHOULD be no more than **30 days**" | "MAY be applied but is not required" | |
| AAL2 | "SHOULD be no more than **24 hours**" | "SHOULD be no more than **1 hour**" | After inactivity only (not the overall limit), the verifier "MAY allow the subscriber to reauthenticate using only a successful password or biometric comparison" together with the session secret |
| AAL3 | "SHALL be no more than **12 hours**" | "SHOULD be no more than **15 minutes**" | Reauthentication is the same as the initial AAL3 authentication |

Sec. 5.1, session bindings and browser cookies:
- "Session secrets that are used as bearer tokens for session management **SHOULD NOT be
  persistent**." Persistent means retained across an application restart or a host reboot.
  A remember-me persistent cookie is therefore a **documented deviation**. That is why it
  is opt-in for the user, admin-governed, and short (24 h or less).
- "Cookies and similar **'remember my browser' features SHALL NOT be used instead of
  authentication**." The one exception is AAL2 reauthentication after the inactivity limit
  (not the overall limit). Our design complies: the cookie keeps an **authenticated
  session** alive up to the overall timeout, and it never replaces the next sign-in.
- Cookies "SHALL be tagged to be accessible only on secure (i.e., HTTPS) sessions" and
  "SHOULD be ... HttpOnly".
- "Cookie expiry SHALL NOT be relied upon to enforce session timeouts". Server-side
  enforcement is required.
- Cookies "SHOULD contain only an opaque string". Ours is a signed JWT carrying `sub` and
  `role`. That is acceptable and unchanged, but noted.
- Secrets "SHOULD NOT be placed in insecure locations (e.g., HTML5 Local Storage)".

Sec. 5.2, reauthentication:
- "the RP MAY alert the subscriber that the session is about to be terminated".
- "Session activity SHALL reset the inactivity timeout".
- "successful reauthentication during a session SHALL reset both timeouts".
- "Agencies SHALL establish and **document** the inactivity and overall time limits".

### 1.2 OWASP ASVS 5.0
Sources: https://raw.githubusercontent.com/OWASP/ASVS/master/5.0/en/0x16-V7-Session-Management.md
and https://raw.githubusercontent.com/OWASP/ASVS/master/5.0/en/0x12-V3-Web-Frontend-Security.md.

| ID (level) | Requirement | Our status / action |
|---|---|---|
| **7.1.1 (L2)** | Document the inactivity timeout and absolute maximum session lifetime; **justify any deviation from NIST 800-63B** | Add a "Session lifetimes" table to `docs/operations/security.md` that documents remember-me as the deviation |
| 7.1.2 (L2) | Document the allowed number of concurrent sessions | Document it (currently unlimited, with per-device rows) |
| 7.2.4 (L1) | Issue a new token on authentication and re-authentication | Already true: a new `sid` is minted on every login |
| **7.3.1 / 7.3.2 (L2)** | Inactivity timeout and absolute maximum lifetime force re-authentication | Remembered sessions get their own **absolute** limit equal to `remember_duration` |
| 7.4.1 (L1) | A terminated session cannot be reused | Registry revocation already enforces this. **Prune grace (7 days) must stay longer than the JWT lifetime** (see §5.8) |
| 7.4.2 / 7.4.5 | Disabling an account ends its sessions; admins can terminate sessions | Already true (`verify()` rejects inactive users; admin revoke and revoke-all) |
| 7.4.3 (L2) | Offer to end other sessions after a credential change | Existing capability. Out of scope here |
| 7.4.4 (L2) | Logout is visible | Already true |
| **7.5.1 / 7.5.3** | Full re-authentication for sensitive attributes and transactions | `require_fresh_auth` stays in force inside remembered sessions |
| 7.5.2 (L2) | Users can view and terminate sessions | Sessions page. Add a "Remembered" badge and an expiry column |
| **3.3.1 (L1)** | Cookies have `Secure` (or the `__Host-` prefix) | `AUTH_COOKIE_SECURE` defaults to false. Remember-me is refused on non-HTTPS, non-loopback origins unless the admin opts in |
| 3.3.2 (L2) | SameSite set per purpose | `Lax` (keep). `Strict` is a possible later hardening |
| 3.3.3 (L2) | `__Host-` prefix | **Not now.** Renaming `tlsoc_token` is a wire-identifier change that needs a versioned migration (AGENTS.md naming contract) |
| 3.3.4 (L2) | HttpOnly for session tokens | Already true |

### 1.3 OWASP cheat sheets
- Session Management (https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html):
  - A cookie with Expires or Max-Age "will be considered a **persistent** cookie and will
    be stored on disk".
  - "Use non-persistent cookies when authentication does not need to persist across
    browser sessions."
  - Typical idle timeouts are "2-5 minutes for high-value applications and 15-30 minutes
    for low risk"; typical absolute timeouts are "between 4 and 8 hours".
  - On automatic client logout: "the user can be notified in advance that the session is
    about to expire".
  - On localStorage: "Do not store authentication tokens, session IDs, JWTs, refresh
    tokens, or any credential in localStorage".
  - "Session cookies must explicitly set SameSite=Strict (preferred) or SameSite=Lax."
- Authentication (https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html):
  - "Allow users to paste into the username, password, and MFA fields". The login page
    already complies.
  - Use "remembered-device cookies **as risk signals, not as substitutes for
    authentication**."
  - On third-party apps: it is "NOT considered safe to allow the third-party application to
    store the user/password combo". The same reasoning applies to our own SPA storing it.

### 1.4 Browser password-manager mechanics
- **Chromium, form styles it understands**
  (https://www.chromium.org/developers/design-documents/form-styles-that-chromium-understands/):
  for multi-step sign-in, "include a form field containing the username in the form used to
  collect the password ... You can, of course, hide this field via CSS." Use
  `autocomplete="current-password"` on sign-in and `new-password` on change or sign-up.
  **Our password step has no username field**, so Chrome may save the password without (or
  with the wrong) username.
- **Fetch-based login detection:** Chromium treats a filled form that disappears after a
  successful XHR or fetch as a submitted login. A MutationObserver handles late removal.
  See Chromium code review discussions such as https://codereview.chromium.org/2865233003.
  Our SPA unmounts the form after success, which usually triggers the save bubble. It is
  heuristic, so the explicit API below is a belt-and-braces addition.
- **`PasswordCredential` and `navigator.credentials.store()`**
  (https://developer.mozilla.org/en-US/docs/Web/API/PasswordCredential): requires a secure
  context and is "Limited availability" and experimental. MDN BCD
  (`api/PasswordCredential.json`, fetched live) shows **Chrome 51+ and Edge (mirror) only.
  Firefox: no** (bug 1156047). **Safari: no** (webkit 252908). Feature-detect it and use it
  only as a progressive enhancement.
- **`navigator.credentials.get({password:true, mediation})`**
  (https://developer.mozilla.org/en-US/docs/Web/API/CredentialsContainer/get): the
  mediation values are `silent`, `optional` (the default), `required` and `conditional`.
  We do **not** auto-call `get()` on page load because it would pop a native chooser. If a
  later round adds a one-tap "Sign in as X" button, use `mediation:'required'` and call
  `preventSilentAccess()` on logout.
- **"Session" cookies are not guaranteed to die on browser close.** Chromium's "Continue
  where you left off" (and restarts after an update) restore session cookies. See
  https://textslashplain.com/2019/06/24/surprise-undead-session-cookies/ and
  https://github.com/brave/brave-browser/issues/28379. **So the server's idle and absolute
  limits are the real control.** Unchecked sessions must keep server-side bounds.

---

## 2. What competitors and peers do

| Product | Mechanism | Lifetimes and controls | Source |
|---|---|---|---|
| **Microsoft Entra ID** | Post-auth **"Stay signed in?"** (KMSI) interstitial. Yes sets a persistent auth cookie; without it, "a non-persistent cookie is issued and lasts for 24 hours or until the browser is closed." Admin toggle "Show keep user signed in". The prompt is **suppressed for high-risk sign-ins and shared devices**, for guests, and when CA persistent-browser is set | Conditional Access **sign-in frequency** (hours or days, or "every time") and **persistent browser session** (always or never). Default sign-in frequency is a "rolling window of 90 days". Warns that persistent browsers keep "artifacts, which remain usable until token expiration" | https://learn.microsoft.com/en-us/entra/fundamentals/how-to-manage-stay-signed-in-prompt , https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-session-lifetime |
| **Google Workspace** | Web session length set per OU or group. At expiry the "Verify it's you" page appears | Default **14 days**. **Admin console is fixed at 1 hour** and "can't be modified" | https://knowledge.workspace.google.com/admin/security/set-session-length-for-google-services |
| **Google Cloud** (console and gcloud) | Reauthentication policy, by password or security key. Trusted apps can be exempted | Admin chooses **1 to 24 hours**. "The frequency doesn't include how long a user has been inactive" | https://knowledge.workspace.google.com/admin/security/set-session-length-for-google-cloud-services |
| **Google sign-in, shared-device guidance** | Copy on the sign-in page: "Not your computer? Use a private browsing window to sign in" | (UX copy precedent for our warning) | https://support.google.com/accounts/answer/2917834 |
| **Palo Alto Cortex XSIAM / XDR / XSOAR** | Settings → Configurations → General → Security Settings. **User Login Expiration** is "the number of hours (between 1 and 24) after which the user's login session expires", with an optional inactivity auto-logout. **Dashboard Expiration** can be "login session" or "7 days" (for wall screens). Approved domains and IP ranges for login. **No user-facing remember-me** | 1–24 h admin-set | https://cortex-docs.paloaltonetworks.com/cortex-xsiam/onboard-cortex-xsiam/post-deployment/configure-security-settings |
| **CrowdStrike Falcon LogScale** | Org owners set an **inactivity timeout** and **"Require login every"** (maximum session). Users get a **warning 60 s before an inactivity expiry, with a choice to extend**, and a **15-minute warning before forced re-login**. The cookie holds only a session identifier. Admins can view and end sessions | Admin-set | https://library.humio.com/falcon-logscale-cloud/security-session-management.html (No public doc was found for the Falcon platform console itself; Falcon customers typically federate via SSO.) |
| **Elastic Kibana** (our legacy attach target) | `xpack.security.session.idleTimeout` default **3 days** (8.14+). `lifespan` default **30 days**. Elastic Cloud SSO uses a 24 h lifespan | Config-file | https://www.elastic.co/guide/en/kibana/8.19/xpack-security-session-management.html |
| **AWS console** | IAM-user console sessions default to **12 h**. Federated sessions run 15 min to 12 h. IAM Identity Center portal defaults to **8 h** | | https://docs.aws.amazon.com/singlesignon/latest/userguide/howtosessionduration.html |

Takeaways for a SOC console:
- Enterprise security consoles cap re-authentication at **24 h or less** (Cortex 1–24 h,
  Google Cloud 1–24 h, NIST AAL2 24 h). Our 6/12/24 h presets with a 24 h maximum match
  this.
- **The admin has the final say.** Entra's admin toggle and Cortex's expiration settings
  are the models; the user only chooses within the admin's policy.
- **Suppress or deny remember-me for risky contexts:** shared devices, high-risk sign-ins
  and guests (Entra). Our equivalents are excluded roles and insecure transport.
- **Pre-expiry warnings** are standard (LogScale gives 15 min before forced re-login;
  NIST 5.2 says MAY). This is a phase-2 nice-to-have, described in §5.9.

---

## 3. How sessions work today (verified against the code and a live probe)

### 3.1 Token and cookie
- `AuthService.authenticate()` and `mint_session()` mint an HS256 JWT
  (`backend/app/auth/service.py:315`, `:436`):
  - Claims: `{sub, role, mc, sid, tv, iat, exp}`.
  - `exp = AUTH_TOKEN_HOURS * 3600` (env `TLSOC_AUTH_TOKEN_HOURS`, **default 12 h**,
    `config.py:219`).
- The **cookie is set at five sites** with copy-pasted attributes:
  - `routes.py:3149` login, `:3395` refresh, `:3872` mfa/verify, `:4024` mfa/enroll-confirm
    and `:4244` sso/callback.
  - Each call is `set_cookie("tlsoc_token", token, httponly=True, samesite="lax",
    secure=AUTH_COOKIE_SECURE, max_age=auth_token_hours*3600)`.
- **Live probe (TestClient, default settings):**
  `Set-Cookie: tlsoc_token=…; HttpOnly; Max-Age=43200; Path=/; SameSite=lax`.
  - **Every login is already a persistent 12 h cookie.** It survives browser restart, and
    there is no "session-only" mode. That makes a remember-me checkbox meaningless until the
    default becomes non-persistent.
  - **No `Secure`** by default: `AUTH_COOKIE_SECURE=false` (`config.py:223`). DEPLOY.md
    tells TLS deployments to set it to true.
- The login JSON also returns `token`. The webui does not store it.

### 3.2 Registry (`backend/app/stores/sessions.py`)
- There is one KV document holding all rows: `{sid, username, refresh_hash,
  refresh_prev_hash, token_version, created_at, last_active_at, last_authn_at,
  absolute_expiry_at, idle_expiry_at, revoked*, ip/geo/ua, client_type, mfa_method}`.
  There is no `remember` field.
- `is_active(row, idle_timeout, absolute_lifetime)` (`:599`) is a pure check. It enforces
  revoked status, the absolute limit (`created_at + policy.absolute_lifetime`) and idle
  expiry (`last_active_at + policy.idle_timeout`). The **live policy overrides** the
  stamped per-row expiry.
- `touch()` slides the idle window at most once per 60 s.
- Revocation:
  - `revoke(sid)`;
  - `revoke_all(user)` bumps the per-user `tv` sentinel;
  - `revoke_others`.
- Pruning drops revoked or expired rows after a **7-day grace** (`_PRUNE_GRACE_SECONDS`,
  `:48`).
- `deps._session_check` (`api/deps.py:131`) runs on every protected request:
  - checks the `tv` claim against the current `tv`;
  - **lazily registers an unknown sid** on a validly signed token;
  - runs `is_active`, then `touch`.
  - A strict read-only variant runs while the factory-reset mutation gate is closed
    (`strict_request_authority`, `:280`).
  - Deferred privileged jobs use `strict_deferred_authority_expires_at` (`:233`;
    `engine/jobs.py:464`, `routes_jobs.py:328`).
  - `require_fresh_auth` (`deps.py:710`) also reads the limits (`:827`).
  - All of these take `idle_timeout`/`absolute_lifetime` from `prefs.session_policy`.
    **There are 8 call sites in total** (grep `idle_timeout` in `api/` and `engine/`).

### 3.3 Policy (`config.py:2948`, `SessionPolicyConfig`, UI-editable Preferences)
- `access_ttl` is 3600 and "informational".
- `idle_timeout` is 43 200 (12 h).
- `absolute_lifetime` is 2 592 000 (30 d).
- `refresh_ttl` is 2 592 000.
- `sudo_reauth_window` is 600.
- `notify_on_new_device` and `notify_on_terminate` default to False.
- The **effective lifetime today is min(JWT 12 h, idle 12 h, absolute 30 d), so 12 h from
  login regardless of activity.** Nothing ever re-mints the JWT.

### 3.4 Refresh tokens are inert
- Login never issues a refresh token: `_register_session(..., refresh_hash="")` at every
  site.
- `POST /api/auth/refresh` requires `refresh_token` in the body. The webui's
  `api.auth.refresh()` sends no body (`webui/src/lib/api.ts:898`), and it is **never
  called**. The live probe returned 422.
- So the **"Access token TTL" field in Settings has no effect**: the JWT lifetime comes from
  the env `AUTH_TOKEN_HOURS`. `refresh_ttl` is unused outside the config.

### 3.5 Webui
- `webui/src/soc/pages/Login.tsx` (1201 lines) is a two-step sign-in (`identity` →
  `password`). SSO buttons appear only on the identity step. MFA, mandated-enrollment and
  forced-change modes follow.
- It sets `autocomplete="username"` (`:848`) and `current-password` (`:892`).
  **The password-step form has no username input.**
- There is no checkbox, and nothing about login is stored locally.
- `webui/src/soc/auth.tsx`:
  - `AuthProvider` loads `/api/auth/me`.
  - The 401 handler (`App.tsx:136`) just calls `refresh()`, which calls `/auth/me`.
- **`/auth/me` (`routes.py:3165`) only runs `auth.verify(token)`, which checks the
  signature, active user and `exp`. It does NOT check registry revocation, `tv` or
  idle/absolute expiry.** Live probe after revoking the session:
  - `GET /api/cases` returned 401;
  - `GET /api/auth/me` returned `{"authenticated": true, ...}`.
  - The SPA therefore stays in the console, and every call 401s again. The same thing
    happens after an idle or absolute expiry. **This is a bug today and must be fixed for
    remember-me.**
- `SessionPolicyEditor.tsx` (Settings → Security; `settings-sections-meta.ts:408` owns
  `session_policy`):
  - It edits the access TTL, idle, absolute and sudo values, plus the two notify toggles.
  - Its `DEFAULTS` (900/1800/43200/600) **do not match** the backend defaults
    (3600/43200/2592000/600), although the comment claims they do. This is a minor drift
    to correct.
- localStorage keys use the `soc.*` prefix (e.g. `soc.theme`, `soc.nav.collapsed`). Some
  legacy keys use `tlsoc.*`. **New keys must use `soc.*`**, because AGENTS.md forbids
  minting new compatibility-prefixed identifiers.

### 3.6 CSRF and other hardening
- `CSRFMiddleware` (double-submit) exists but is off by default (`csrf_enabled=False`).
- The SameSite=Lax cookie plus JSON bodies (non-simple content type, so a preflight is
  required) mitigate cross-site POSTs today. A persistent cookie widens the time window, so
  keep `Lax`. Recommend `csrf_enabled` for hardened profiles; it is out of scope here.
- Rate limiting is off by default (`rate_limit_enabled=False`). There is a client-side
  attempt counter only.

---

## 4. Design

### 4.1 Policy (backend, `SessionPolicyConfig`): additive fields with defaults
Older stored preferences still load.

```python
remember_me_enabled: bool = True              # admin: offer "Remember me" on the sign-in page
remember_me_duration: int = Field(default=86_400, ge=3_600, le=86_400)  # 1h..24h; UI presets 6h/12h/24h
remember_me_idle_timeout: int = Field(default=0, ge=0, le=86_400)       # 0 = no separate idle (= duration)
remember_me_excluded_roles: list[str] = Field(default_factory=list)     # e.g. ["super_admin"]
remember_me_allow_insecure: bool = False      # allow a persistent cookie on plain-HTTP, non-loopback origins
```

- **The maximum is 24 h** (NIST AAL2 overall-timeout guidance; Cortex and Google Cloud also
  stop at 24 h). It also keeps the **prune-grace invariant** (§5.8). Values outside the
  range are clamped or repaired on load rather than rejected, following the repo's
  `chat_agent` repair convention. Out-of-range writes through the settings API return 422.
- **Idle behaviour for remembered sessions:** the idle limit is `remember_me_idle_timeout`
  if it is above 0, otherwise `remember_me_duration`. This lets a user who checked "Remember
  me" stay signed in overnight within the 24 h window, which is the point of the feature.
  This is the documented NIST deviation (the AAL2 inactivity limit SHOULD be 1 h or less).
  Admins who want an inactivity bound set `remember_me_idle_timeout`, for example to 1 h.
- **When `remember_me_enabled` is false**, existing remembered rows are judged by the
  **standard** limits, which are stricter. Their JWT is still bounded to 24 h or less.
  New logins ignore `remember`.
- **One helper** builds the limits so the 8 call sites cannot drift. It lives in a new
  module, `app/auth/session_limits.py`, or as a `SessionStore` staticmethod:

```python
@dataclass(frozen=True)
class SessionLimits:
    idle: int; absolute: int; remember_idle: int; remember_absolute: int
def session_limits(policy) -> SessionLimits: ...
```

- Extend `SessionStore.is_active(row, *, idle_timeout, absolute_lifetime,
  remember_idle=0, remember_absolute=0)` in a backward-compatible way. For a row with
  `remember: true` and `remember_absolute > 0`, it uses the remember pair; otherwise it uses
  the standard pair.
- Thread the remember pair through `strict_request_authority`,
  `strict_deferred_authority(_expires_at)`, `deps._session_check`, `require_fresh_auth`,
  `auth_refresh`, `routes_jobs.py:328` and `engine/jobs.py:464`.
- **Add a contract test** that greps these files and asserts that every
  `is_active(` / `strict_*authority(` call passes the remember limits.

### 4.2 Token and cookie
- **`AuthService.authenticate(username, password, *, remember=False, remember_seconds=0)`
  and `mint_session(username, *, remember=False, remember_seconds=0)`:**
  - With remember, `exp = remember_seconds` and the claims include `"rm": true`.
  - Without it, behaviour is unchanged: `exp = token_hours` and there is no `rm` claim.
  - `begin_mfa(username, *, remember=False)` puts `"rm": true` in the **signed pending
    token**.
  - Add `pending_remember(token) -> bool`.
  - The claim is server-signed, so remember survives the MFA hop without the client
    re-sending it.
- **One cookie helper replaces the five copies:**

```python
def _set_session_cookie(response, state, token, *, remember_seconds: int = 0) -> None:
    kwargs = dict(httponly=True, samesite="lax", secure=state.secrets.auth_cookie_secure, path="/")
    if remember_seconds > 0:
        kwargs["max_age"] = remember_seconds         # persistent (remembered)
    response.set_cookie("tlsoc_token", token, **kwargs)   # else: session cookie (no Max-Age)
```

  `logout` mirrors the same attributes in `delete_cookie`.
- **Behaviour change (CHANGELOG "Changed"):** unchecked logins now get a
  **non-persistent** cookie. They are signed out when the browser closes, subject to the
  "continue where you left off" caveat in §1.4, and the server bounds still apply.
  Bearer-token API clients are unaffected.
- **Remember eligibility** is decided server-side by `_remember_decision(state, request,
  user, requested: bool) -> (bool, reason)`. Possible reasons:
  - `"not_requested"`;
  - `"disabled"` (policy off);
  - `"role_excluded"`;
  - `"insecure_transport"`: when `auth_cookie_secure` is false **and** the request host is
    not loopback (`localhost`, `127.0.0.1`, `[::1]`) **and** `remember_me_allow_insecure`
    is false. This uses the `Host` / `X-Forwarded-Host` header, matching the existing
    `_sso_redirect_uri` derivation.
  - `"ok"` when remember is granted.

  The login response additively carries `remembered: bool`, `remember_reason: str` and
  `session_expires_at: iso`.
- **Request bodies (additive, so no proxy changes are needed):**
  - `LoginBody.remember: bool = False`.
  - `GET /auth/sso/authorize?provider=…&remember=1` stores `remember` in the `oidc_state`
    record, and `sso_callback` reads it. The SSO session is still bounded by the same
    policy.
  - `mfa/verify` and `mfa/enroll-confirm` read `auth.pending_remember(pending_token)`.
    They do not trust a body field.
  - `auth_refresh` keeps `row.remember`, re-mints with the remember lifetime and sets the
    persistent cookie when the row is remembered.

### 4.3 Registry row and audit
- New row fields:
  - `remember: bool`;
  - `remember_seconds: int`, the value granted at creation, kept for display and forensics;
  - `absolute_expiry_at`, stamped with the remember duration for remembered rows.

  `public()` projects `remember` and both expiry timestamps.
- `_register_session(..., remember_seconds=…)` passes these through. The audit summary
  becomes, for example, `"new session (browser Chrome/macOS) remembered 24h"`. The `login
  ok` AUTH_EVENT becomes `"login ok (remembered 24h)"` or `"login ok"`, so remember choices
  are auditable (#2).
- `_lazy_register` reads the `rm` claim, so a remembered token whose registration write
  failed still gets remember limits rather than silently falling back to the stricter
  standard limits.

### 4.4 `/auth/me`: registry-aware (bug fix)
- After `verify()`, run the session check. This is the same logic as `_session_check`,
  refactored into a non-raising `evaluate_session(...) -> reason | None`.
- On a negative reason (revoked, `tv_mismatch`, `idle_expired`, `absolute_expired`), return
  `{"authenticated": false, "auth_enabled": true, "user": null, "reason": "<reason>"}` and
  `delete_cookie`.
- On a store outage, keep today's behaviour and trust the JWT. A closed mutation gate
  returns 503, as today.
- When authenticated, add additively
  `"session": {"remember": bool, "expires_at": iso, "idle_expires_at": iso}`. This feeds
  the sessions UI and the optional pre-expiry warning.
- Webui: `AuthMe` gains `reason?` and `session?`. When `reason` is `idle_expired` or
  `absolute_expired`, the login page shows a calm notice: "For your security, you were
  signed out after 24 hours. Sign in to continue." This replaces the stuck-console loop.

### 4.5 Public login-page policy (no new public path)
- Extend the **public `GET /api/setup/status`** (`routes.py:493`) with
  `remember_me: {enabled: bool, duration_seconds: int, insecure_blocked: bool}`.
  `insecure_blocked` is computed for the current request, so the UI can hide the box rather
  than offer something the server will refuse.
- It contains nothing secret. `SetupStatus` in `types.ts` gains the optional field.

### 4.6 Webui: Login (Apple-design restraint)
**Control:** a Radix `Checkbox` (`@/ui/checkbox`) with `Label`. The whole row is the hit
target (at least 44 px tall), with press feedback on pointer-down (`press-scale`).
- Label: **"Remember me"** (the user's wording).
- Secondary line, muted `text-xs`: "Stay signed in on this device for 24 hours". The
  duration is formatted from `duration_seconds`: "6 hours", "12 hours" or "24 hours".
- **Placement:** in the **password step**, between the password field and the Sign in
  button. It also appears in the **identity step only when SSO providers exist**, because
  that is the only place an SSO user can choose. Both bind to one `remember` state.
- **Hidden** when `remember_me.enabled` is false or `insecure_blocked` is true. In the
  insecure case, show nothing rather than an error. The admin settings explain it.

**Warning (on check, unchecked → checked):** use the existing `ConfirmDialog`
(Radix AlertDialog: focus-trapped, Escape cancels, `prefers-reduced-motion` gives opacity
only). The tone is *warning*, not destructive: amber `ShieldAlert` icon, no red.
- Title: **"Keep this device signed in?"**
- Body:
  > Only choose this on a device that you alone use. For the next **24 hours**, anyone who
  > can open this browser can use Agentic SOC as **{username}**, including cases, chat and
  > response actions, without entering your password.
  >
  > • Your username will be remembered on this device, and your browser may offer to save
  >   your password.
  > • You'll be asked to sign in again after 24 hours, or sooner if an administrator ends
  >   your session. Sensitive actions still ask for your password.
  > • Don't use this on shared, public, or kiosk computers. Sign out when you're done, and
  >   review signed-in devices in **Account → Sessions**.
- Buttons: primary **"Keep me signed in"**, secondary **"Cancel"** (the default focus is
  Cancel, which is the safe default).
- Once the user accepts, set `localStorage['soc.login.rememberAck'] = '1'` in a
  try/catch. While a remembered username exists on this device, re-checking does not
  re-open the dialog. "Use a different account" clears both keys. Unchecking needs no
  confirmation.

**Remembered username:**
- After a **successful** sign-in (including after MFA, SSO and forced change):
  - if `remembered === true`, store `soc.login.rememberedUsername = username`;
  - if the user did not check the box, remove it.
  - Do not store on submit (that would keep typos or probed names).
  - If the server says `remembered:false` (for example `role_excluded`), remove it and show
    a one-line toast after entering: "Remember me isn't available for your role. You'll stay
    signed in until you close the browser."
- On mount with a remembered username:
  - start on the **password step**, with the username shown in the identity chip and the
    box pre-checked;
  - replace "Back" with **"Use a different account"**, which clears both keys and goes to
    the identity step;
  - focus the password field so the browser can autofill it.
- Logout does **not** clear the remembered username. It is an account-chooser convenience,
  like Google and Microsoft. The user menu, the "Signed out" screen and Account → Sessions
  get a **"Forget this device"** action that clears it.

**Password manager:**
- Add a visually hidden, read-only username field inside the password `<form>`:
  `<input type="text" name="username" autoComplete="username" value={username} readOnly
  tabIndex={-1} className="sr-only" aria-hidden="true" />`. Chromium recommends this
  (§1.4). With `tabIndex={-1}` it is outside the sequential tab order, which keeps it
  compatible with axe's `aria-hidden-focus` rule; verify this with the a11y test.
- After a successful sign-in with `remember` checked, run:

```ts
if (window.isSecureContext && 'PasswordCredential' in window) {
  try { void navigator.credentials.store(new (window as any).PasswordCredential({ id: username, password, name: username })); }
  catch { /* progressive enhancement only */ }
}
```

  Fire and forget. Never block `onAuthenticated`, and never call it for an unchecked box.
  Firefox and Safari rely on their own heuristics plus the hidden username field.
- **Never** write the password to `localStorage`, `sessionStorage`, IndexedDB or a
  readable cookie. Add a vitest that spies on `Storage.prototype.setItem` and asserts that
  no value equals the password.

**SSO:** `api.auth.sso.authorize(providerId, { remember })` adds `&remember=1`.

**Expiry notice:** show `AuthMe.reason` as an inline `Alert` above the form ("You were
signed out after 24 hours" / "after a period of inactivity" / "because this session was
ended from another device or by an administrator").

### 4.7 Webui: settings and sessions
- **`SessionPolicyEditor.tsx`:** add a "Remember me" group under the existing duration
  grid:
  - `Switch`: "Offer 'Remember me' on the sign-in page".
  - `SegmentedControl` (existing primitive): **6 h | 12 h | 24 h**, with a custom
    `NumberField` in hours from 1 to 24.
  - Help text: "How long a remembered device stays signed in before the user must sign in
    again (including MFA). NIST SP 800-63B-4 recommends no more than 24 hours for
    MFA-protected access."
  - Optional "Sign out remembered devices after inactivity" `NumberField` in minutes, where
    0 means off.
  - "Exclude roles" multi-select or `TagInput` over the known roles.
  - `Switch`: "Allow on plain HTTP (not recommended)". Show it only when the backend
    reports `auth_cookie_secure=false`, with an amber note. Expose that flag through the
    settings schema/status as a boolean (secrets stay booleans, #10).
  - **Fix `DEFAULTS`** to mirror the backend.
  - Relabel the inert "Access token TTL" as "Refresh-token rotation (API clients)", or
    mark it advanced. It is out of scope, but flag it in the SPEC so the UI stops implying
    it controls the browser session.
- **`Sessions.tsx`:** add a "Remembered · until {time}" badge in the Device/Browser cell.
  Use the existing `badges.tsx` style and keep it plain text (#9). Add an "Expires" column,
  using `absolute_expiry_at`, or the effective expiry computed server-side.

### 4.8 Settings schema and types
- `webui/src/lib/types.ts`:
  - `SessionPolicy` gets the five remember fields;
  - `SetupStatus.remember_me`;
  - `LoginResult.remembered/remember_reason/session_expires_at`;
  - `AuthMe.reason/session`;
  - the `SessionRow.remember/remember_seconds` projection.
- Regenerate `api-types.gen.ts` (`npm run gen:types`).
- Update `docs/` and the Help Center knowledge (`scripts/build_app_knowledge.py`) if the
  Security docs page changes.

---

## 5. Security analysis and edge cases

1. **Shared or public device:** this is the main risk. It is mitigated by the opt-in
   checkbox, the explicit warning dialog, a 24 h maximum, admin disable and role exclusion,
   visible logout, and the Sessions page with revoke and revoke-others.
2. **Stolen persistent cookie:** it is HttpOnly (no XSS read) and Secure when TLS is
   configured. The insecure-transport refusal prevents a long-lived cleartext cookie on LAN
   HTTP unless the admin overrides it. It is bounded to 24 h or less, and revocation is
   immediate through the registry (and `tv` for revoke-all). Optional later work: bind a
   remembered row to its UA family, and revoke or require re-login on a major UA or OS
   change. That is fragile, so it is not in this round.
3. **MFA:** remember-me never skips MFA. The pending token carries `rm`, so a user cannot
   gain a remembered session that skips the second factor, and cannot strip or add `rm`
   (it is signed). Do not combine it with any future "remember MFA on this device" feature;
   Entra warns against mixing the two.
4. **Step-up:** `require_fresh_auth` uses `last_authn_at` and the 10-minute sudo window.
   It is unchanged, so admin revoke, exports, resets and storage apply re-prompt even in a
   remembered session (ASVS 7.5.1 and 7.5.3).
5. **Policy shortening and disabling:** limits are recomputed from the live policy (the
   existing semantics), so shortening 24 h → 6 h expires existing remembered sessions older
   than 6 h on their next request. Disabling remember-me makes remembered rows fall back to
   the standard limits. Write a test for both.
6. **CSRF:** SameSite=Lax plus JSON content type. A persistent cookie extends the window,
   so document `csrf_enabled` for hardened deployments. Login CSRF stays exempt, as it is
   today.
7. **Username in localStorage:** this is not a credential (OWASP's localStorage
   prohibition concerns tokens and credentials). It reveals the account name on the device,
   which is exactly what the warning says. It is cleared by "Use a different account" and
   "Forget this device".
8. **Pruning invariant (ASVS 7.4.1):**
   - A revoked row is pruned 7 days after revocation.
   - An unknown sid on a valid JWT is **lazily re-registered**.
   - The JWT lifetime (24 h or less) must therefore stay **shorter than
     `_PRUNE_GRACE_SECONDS`** (7 days), or a revoked remembered token could come back after
     pruning.

   Add an assertion test: `SessionPolicyConfig.model_fields['remember_me_duration'].le <
   _PRUNE_GRACE_SECONDS` and `auth_token_hours*3600 < _PRUNE_GRACE_SECONDS`, and warn at
   startup if the env token hours exceed this.
9. **Pre-expiry warning (phase 2, optional):** with `AuthMe.session.expires_at`, show a
   toast 10 minutes before an absolute expiry: "Your session ends at 14:05. Sign in again
   to stay signed in." The action opens the re-auth modal and does a fresh login (new
   `sid`, both timeouts reset, per NIST 5.2). LogScale uses 15 min / 60 s warnings. This
   is not required for the user's ask.
10. **Chrome "continue where you left off":** unchecked sessions may survive a restart.
    The server idle and absolute limits still apply. Document it in the Help Center: "Sign
    out on shared computers."
11. **Env `AUTH_TOKEN_HOURS`:** this still governs standard sessions only. Remembered
    sessions use the policy duration. Document both in `docs/ENVIRONMENT.md`.

---

## 6. Test plan

### Backend (pytest, offline; extend `tests/test_sessions.py`, add `tests/test_remember_me.py`)

Login and cookie:
1. Login **without** remember: `Set-Cookie` has **no** `Max-Age`/`Expires`. The JWT `exp -
   iat` is `token_hours*3600`. There is no `rm` claim. The row has `remember == False`.
   The response has `remembered:false` and `remember_reason:"not_requested"`.
2. Login **with** remember (default policy, loopback host): `Max-Age=86400`. The JWT
   lifetime is 86400 and `rm` is true. The row has `remember == True` and
   `remember_seconds == 86400`. The audit summaries include "remembered".

Remember eligibility:

3. Policy `remember_me_enabled=False` with a remember request: the session cookie is
   standard and the reason is `disabled`.
4. A role in `remember_me_excluded_roles`: standard cookie, reason `role_excluded`.
5. Non-loopback `Host` with `auth_cookie_secure=False`: standard cookie, reason
   `insecure_transport`. The same request with `remember_me_allow_insecure=True`, or with
   `auth_cookie_secure=True`, is remembered.

MFA and SSO:

6. **MFA:** login with remember returns `requires_mfa`. The pending token decodes with
   `rm`. `/auth/mfa/verify` sets a persistent cookie. A tampered pending token (with `rm`
   flipped) is rejected. Repeat for `/auth/mfa/enroll-confirm`.
7. **SSO:** `authorize?remember=1` stores the flag. `callback` (using the existing fake
   provider harness) sets a persistent cookie. Without the flag, it sets a session cookie.

Limits and expiry:

8. `is_active` with a remembered row created 13 h ago:
   - standard absolute = 12 h, remember = 24 h → active;
   - created 25 h ago → `absolute_expired`;
   - idle uses `remember_idle`.
9. Shorten the policy from 24 h to 6 h: an 8 h-old remembered session gets 401
   `session_expired`. Disable remember: the row uses the standard idle limit.
10. **The `strict_request_authority` (mutation gate closed) and
    `strict_deferred_authority_expires_at` (jobs)** paths honour the remember limits.
11. **The contract test** (grep) shows that every `is_active(` and `strict_*authority(`
    caller passes the remember limits.

`/auth/me`:

12. After revoking a session, `/auth/me` returns `authenticated:false`,
    `reason:"revoked"`, and the cookie is cleared. The same applies to `idle_expired`,
    `absolute_expired` and `tv_mismatch`. A valid session includes `session.remember` and
    `expires_at`. Auth off is unchanged.

Other session paths:

13. Lazy-register of a token with `rm` stores `remember=True`.
14. Refresh rotation preserves `remember` and the persistent cookie.
15. Step-up: in a remembered session older than the sudo window, the admin revoke returns
    401 `reauth_required`. That is unchanged and asserted.
16. Logout revokes the session and clears the cookie with matching attributes (`Path=/`).

Public status, config and coverage:

17. `GET /api/setup/status` (unauthenticated) exposes
    `remember_me{enabled,duration_seconds,insecure_blocked}` and nothing else new.
18. Config: the duration bounds are 1 h to 24 h. A stored out-of-range value is repaired
    on load. The prune-grace invariant holds.
19. `test_route_auth_coverage` is unchanged, because there is no new public path.

### Webui (vitest, `test:strict`, zero console output)

Login page:

1. The checkbox is hidden when `remember_me.enabled` is false or `insecure_blocked` is
   true. The label shows "24 hours", "6 hours" and so on, from the status.
2. Checking the box opens the dialog with the warning copy. **Cancel** leaves it
   unchecked. **Keep me signed in** checks it and sets `soc.login.rememberAck`. The next
   check does not open the dialog. Unchecking does not open the dialog.
3. The `api.auth.login` body includes `remember:true`. The SSO authorize call includes
   `remember`.
4. A successful remembered login stores `soc.login.rememberedUsername`. An unchecked
   success removes it. A failure never stores it. `remembered:false` from the server
   removes it and shows the role notice.
5. On mount with a remembered username, the password step shows the chip and "Use a
   different account". Choosing it clears both keys and shows the identity step.
6. The password form contains `input[autocomplete=username][name=username]` with the
   username, and it is not tabbable.
7. `PasswordCredential` is stubbed. `store` is called once with `{id, password}` only when
   the box is checked and the context is secure. A throwing `store` does not break login.
8. **No storage write ever contains the password** (spy on `Storage.prototype.setItem` and
   on IndexedDB `open`).
9. The `AuthMe.reason` notice renders the correct copy for each reason.

Auth provider and settings:

10. `auth.tsx`: a 401 followed by `/auth/me` returning `authenticated:false` lands on Login
    (the regression test for the stuck-console loop).
11. `SessionPolicyEditor`: the remember controls round-trip, the presets map to seconds,
    and `DEFAULTS` equals the backend defaults (a snapshot against the schema).
12. a11y (axe): the checkbox has a label, the dialog has a title and description, and no
    `aria-hidden-focus` violation is raised.

### Gates
- `pytest -q` passes.
- `npm run build`, `test:strict` and `lint` pass (0/0).
- The bundle first-paint budget holds. The dialog must not pull `motion` into the entry
  chunk; `ConfirmDialog` is already in the shell.

---

## 7. Docs to update (same candidate)
- `docs/operations/security.md`:
  - a "Session lifetimes" table (standard and remembered: idle, absolute, cookie
    persistence, MFA, step-up), written as the **ASVS 7.1.1 documentation of NIST
    deviations**;
  - the shared-device guidance;
  - the "continue where you left off" caveat.
- `docs/administration/users-rbac.md`: the new Session-policy controls.
- `docs/ENVIRONMENT.md` and `DEPLOY.md`: `AUTH_TOKEN_HOURS` now governs standard sessions
  only, and `AUTH_COOKIE_SECURE=true` is required for remember-me on non-loopback HTTPS
  deployments.
- `docs/getting-started/first-run.md` and `docs/USAGE.md`: one paragraph on Remember me.
- `CHANGELOG.md` `[Unreleased]`:
  - Added: Remember me.
  - Changed: unchecked sign-ins now use a browser-session cookie.
  - Fixed: `/auth/me` honours revocation and expiry.
- Regenerate the Help Center knowledge corpus if docs pages change.

---

## 8. Work-package sketch (for the SPEC)

**WP-RM1 (backend core):**
- the policy fields, the `session_limits` helper and `is_active` remember limits;
- threading the limits through all 8 call sites, with the contract test;
- the remember-aware `AuthService` mint and pending token;
- the `_set_session_cookie` helper with the 5 sites refactored;
- `_remember_decision`;
- login, MFA verify, enroll-confirm, SSO authorize/callback and refresh wiring;
- the row fields and `public()` projection, audit and lazy-register;
- `setup/status.remember_me`;
- the **`/auth/me` registry check (bug fix)**;
- tests 1–19.

**WP-RM2 (webui login):**
- the checkbox, `ConfirmDialog` warning, remembered username, hidden username field,
  `PasswordCredential.store`, SSO remember param and expiry notice;
- types and API;
- vitest 1–10 and 12.

**WP-RM3 (webui settings and sessions):**
- the `SessionPolicyEditor` remember group, `DEFAULTS` fix and Access-TTL relabel;
- the Sessions badge and expiry column;
- vitest 11.

**WP-RM4 (docs):** §7 and the ASVS 7.1.1 table.

**Review focus for adversarial verifiers:**
- the remember flag cannot be escalated (signed pending token, server decision);
- the password is never persisted;
- every limit call site is remember-aware;
- the `/auth/me` loop is fixed;
- unchecked sessions are non-persistent;
- the prune invariant holds;
- AGENTS.md naming: no new `tlsoc_*` identifiers; the new keys are `soc.login.*`.
