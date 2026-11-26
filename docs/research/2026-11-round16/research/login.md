# Round 16 research: the sign-in page ("login")

Research agent report, read-only. Repository `Kavach-AgenticSOC`, branch `claude/round16`
(HEAD `3cd362c`, "Journal: Round 16 start", on top of `3cfd5c0`). Nothing in the repository was edited.
A throwaway prototype was built in the scratchpad copy only, to measure the entry-byte impact.

## 0. Summary

The operator asked for a cleaner, "super clean and aesthetic" login page and animation, and for the
Remember me option to say only "Remember me".

What the page is today: a faithful clone of another company's sign-in (the code says it follows
"Mistral's current sign-in choreography" and "uses the current Mistral identity palette and geometry
exactly"), with four 240 px tiles that move forever on `top`/`left` transitions, a cyan-to-orchid
gradient "shine" button, a gradient Light/Dark pill, and its own neutral palette that differs from the
Console's. It is careful work (measured contrast gates, reduced-motion and forced-colours fallbacks),
but it carries three identities at once (Mistral neutrals, a GSAP-style cyan shine, the Console's blue),
and it has several real defects (section 2).

Recommendation in one line: keep the authentication state machine exactly as it is, and replace the
presentation layer with a quiet column on the Console's own tokens, one static brand wash, a
one-shot CSS entrance (280 ms) and step transition (200 ms) that only use `transform` and `opacity`,
the ordinary primary `Button` (which follows the org accent and is already AA-guarded), labelled
"Sign in with ..." SSO buttons, inline field errors, OTP auto-submit, and a Remember me row that is
just the label.

Measured impact of a prototype of the core of this (section 9): entry chunk 329,080 B to 321,910 B
(-7,170 B, gzip 100.40 kB to 98.32 kB); global stylesheet 239,828 B to 225,932 B (-13,896 B). The
redesign pays for itself and lets the baseline ratchet down.

## 1. What exists today (inventory)

| Piece | File | Notes |
|---|---|---|
| Page and state machine | `webui/src/soc/pages/Login.tsx` (1,356 lines) | Modes `signin`, `setup`, `change`, `mfa`, `mfa-enroll`, `mfa-enroll-required`; identity-first two-step sign-in; first paint waits for 4 probes (setup status, SSO providers, branding, the lazy Remember me chunk) |
| Ambient background | `webui/src/soc/components/auth/LoginAuthBackdrop.tsx` | 4 tiles, recursive `setTimeout` per tile, `LOGIN_AMBIENT_CADENCE` "measured from the current live Mistral sign-in background"; `data-login-ambient-cadence="mistral"` |
| Primary CTA | `webui/src/soc/components/auth/ShineButton.tsx` | Gradient face, blurred halo, one-shot sweep keyframe; fixed cyan palette, ignores the org accent |
| Theme control | `webui/src/soc/components/auth/ThemeModePill.tsx` + `LoginThemeControl` in Login.tsx | 214 px gradient pill plus a round "Use system theme" chip |
| Inputs, OTP, SSO marks, strength meter | `webui/src/soc/components/auth/loginParts.tsx` | `LoginTextInput`, `PasswordInput`, `OtpInput` (has an unused `onComplete`), `SsoBrandIcon`; `BrandHero`/`LoginIllustration` exports are dead (tree-shaken, no importer) |
| Remember me (lazy) | `webui/src/soc/components/auth/RememberMeControls.tsx`, `rememberMe.ts` | The row, the warning dialog, `SessionEndNotice`; hint line at `RememberMeControls.tsx:87-91` |
| Styles | `webui/src/styles/theme.css` lines 734 to about 1538 | `.login-auth-canvas` palette, tiles, guides, shine and pill, accessibility fallbacks; about 14.7 kB minified in the global CSS |
| Gates and contract | `webui/scripts/gate-login-accents.mjs` (418 lines), `design-gates.test.ts`, `foundations.test.ts` (login canvas under `prefers-contrast: more`), `docs/development/ui-standard.md` "Identity surfaces" and "Identity accents" |
| Branding (backend) | `backend/app/config.py:910-941` `BrandingConfig` | `org_name`, `product_name`, `logo_data_url`, `accent_color`, `login_subtitle`, `footer_text`, `support_url`, `login_headline` (120), `login_body` (600), `login_chips` (6 x 60), `login_layout` (split/centered/full, ignored by the UI since the minimal shell), `login_illustration` (ignored); all plain text, `<` rejected |
| Boot gate | `webui/src/soc/App.tsx:40-47, 156-162` | `CenterSpinner` "Starting console..." on `bg-canvas` before and after Login |

Entry-chunk bytes today, attributed through the source map of the committed `dist/` (329,093 B with the
build stamp): Login.tsx 21,676; loginParts.tsx 6,216; LoginAuthBackdrop.tsx 5,380; ThemeModePill.tsx
1,350; ShineButton.tsx 436; login.api.ts 224. The Remember me controls are already a lazy chunk (0 entry
bytes).

Records that constrain this work:
- Round 12 SPEC D14 (`docs/research/2026-10-round12/SPEC.md:128`): Remember me design; shown disabled
  with a reason when the admin turned it off or on plain HTTP; warning dialog on check.
- Round 12 research `remember-me.md` section 4.6: the label is "Remember me" (the user's wording) with a
  secondary line "Stay signed in on this device for 24 hours".
- Round 14 SPEC D3 (`docs/research/2026-10-round14/SPEC.md:222`): "Keep the Remember me hint ... a
  disclosure before opting in". The operator's new ask reverses D3 for the row. The disclosure still
  exists in the warning dialog, which every new person on a device sees before the box becomes checked,
  so the "disclosure before opting in" rationale survives.

## 2. Findings and bugs (with evidence)

F1. **The ambient backdrop is perpetual, auto-starting motion beside the form with no pause control.**
`LoginAuthBackdrop.tsx` schedules reveal, move, settle and hide timers per tile forever
(`schedule()` re-arms itself in the hide timer, lines 227-270). It stops only under
`prefers-reduced-motion` or below 640 px. WCAG 2.2.2 Pause, Stop, Hide (Level A) requires a mechanism to
pause, stop or hide moving content that starts automatically, lasts more than five seconds and is shown
in parallel with other content; the Understanding document says a platform mechanism can count but does
not confirm that a reduced-motion preference alone satisfies it, and the documented technique is an
on-page control (https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html). At risk of a Level A
failure.

F2. **The tiles animate layout properties.** `.login-auth-cell` transitions `top` and `left` over
1,800 ms with `will-change: background-color, opacity, top, left` (theme.css lines 847-853). web.dev:
"Where possible, restrict animations to `opacity` and `transform`", moving an element with `top`/`left`
is "likely to be slow", and `will-change` should be used only for a measured problem
(https://web.dev/articles/animations-guide). Four React state updates per tile per cycle (cadence in
`LOGIN_AMBIENT_CADENCE`) is roughly one React render per second while the page sits open, which matters
on SOC wall screens and laptops left on the sign-in page.

F3. **Login field edges are about 1.41:1 (light) and 1.60:1 (dark) at rest.** The login canvas sets
`--login-input-border: rgb(0 0 0 / 15%)` on white and `rgb(255 255 255 / 15%)` on a 6% white fill over
`#101013` (theme.css 753, 796), and redefines `--input: 0 0% 85%`. Computed: 1.41:1 and 1.60:1. The
Console's own border policy (theme.css lines 44-49: "When a border is the ONLY thing conveying a
control/focus edge, use `--border-strong`/`--input` (>=3:1)") measures `--input` at 3.27:1. The
foundations test only enforces 3:1 under `prefers-contrast: more`. Moving the page onto Console tokens
fixes this with no new numbers.

F4. **Colour jump between boot, sign-in and Console.** Cold load shows `CenterSpinner` "Starting
console..." on the Console canvas (`App.tsx:156`, dark `#0c1018` navy), then Login's own gate "Loading
sign-in" on the login canvas (`Login.tsx:1325-1335`, dark `#1a1a1e` charcoal) with a console-page-shaped
skeleton (`shape="page"`: a header block and three KPI tiles, not a form), then the form. After sign-in
the reverse happens: charcoal login, navy "Starting console..." spinner, then the shell. Two different
spinners and two canvases inside about a second reads as flicker, not animation.

F5. **"Continue" pops in on the first keystroke (layout shift on every sign-in).** `Login.tsx:991-995`
renders the button only when the username is non-empty. On phones the content is vertically centred
(`my-auto`), so the whole stack jumps about 32 px when the first character is typed; on desktop the SSO
row and demo hint below jump 64 px. web.dev also advises not to hide or disable the submit button
(https://web.dev/articles/sign-in-form-best-practices).

F6. **An empty username submit does nothing.** `continueSignin` returns silently when the username is
empty (`Login.tsx:509`), while the password step names the missing field ("Enter your password.",
fix LI2). Inconsistent, and pressing Enter gives no feedback.

F7. **The SSO error renders a raw query value.** `Login.tsx:420-423` shows
`Single sign-on failed: ${e}` from `?sso_error=`. The backend only ever sends a closed vocabulary of
snake_case codes (`backend/app/api/routes.py:5511-5576`: `missing_code_or_state`, `state_not_bound`,
`invalid_state`, `unknown_provider`, `token_exchange_failed`, `incomplete_identity`, `not_allowed`,
`audit_unavailable`, `user_not_provisioned`, `session_failed`). So users see "Single sign-on failed:
token_exchange_failed", and anyone can craft a link that puts arbitrary text on the sign-in page
(`/login?sso_error=Your+account+is+locked,+call+...`). React escapes it, so it is not XSS, but it is text
injection on the one page attackers most want to imitate. Map codes to fixed sentences; unknown to a
generic sentence.

F8. **SSO buttons are icon-only.** `Login.tsx:1081-1110` renders a grid of icon buttons with an sr-only
name. A generic OIDC provider gets a neutral `ShieldCheck` glyph, so a sighted user cannot tell which
provider it is. Microsoft's guidance: "It's the association of the Microsoft logo and the 'Sign in with
Microsoft' terms that uniquely represent Microsoft Entra ID"; shorten to "Sign in" only for lack of space
(https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-branding-in-apps). Google allows the
"G" alone inside a button boundary "if needed", recommends "Sign in with Google" / "Continue with
Google", and says the button should be "at least as prominent as other third party sign-in options"
(https://developers.google.com/identity/branding-guidelines).

F9. **The org accent does not reach the primary action.** The shine CTA has a fixed cyan ramp
(theme.css 963-994). An operator who sets `accent_color` gets their colour on the shield mark and focus
ring but a cyan button. The Console's `--primary`/`--primary-foreground` pair is already AA-guarded for any
operator accent (`webui/src/soc/theme-tokens.ts:406-545`).

F10. **The org name is never visible.** The wordmark and tagline are `sr-only` (`Login.tsx:780`); sighted
users see a 56 px shield and "Welcome back". A first-time visitor is welcomed "back", and nothing on the
page says which product or organisation this is unless the operator uploaded a logo.

F11. **Redundant copy on the password step.** The description "Enter the password for alice." sits
directly above an identity row that already shows "alice" (`Login.tsx:734-735, 1013-1038`).

F12. **OTP auto-submit is wired in the component but not used.** `OtpInput` has `onComplete`
(`loginParts.tsx:309`), and Login does not pass it, so users type six digits and then must find
"Verify and continue".

F13. **Duplicate branding request on cold load.** `ThemeProvider` fetches `/api/branding` on mount
(`webui/src/soc/theme.tsx:243-249`) and Login refetches on mount (`Login.tsx:408-416`) and gates first
paint on the second fetch. The refetch exists for the same-session case (a branding save followed by a
sign-out), not for a cold load.

F14. **Nested scroller on phones.** Below 640 px the slab is `min-h-[100dvh] max-h-[100dvh]
overflow-y-auto` inside a `min-h-[100dvh]` main (`Login.tsx:767`), a second scroll container on the one
page where software keyboards appear. Natural document scroll is simpler.

F15. **Trade-dress and identity risk.** For a product meant to be "the ideal free agentic SOC for the
world", copying another company's sign-in "exactly" (palette, 480 x 492 geometry, tile choreography,
warm trail colours gold to red) is a brand and trade-dress risk and gives the project no identity of its
own. I could not open Mistral's live sign-in page to confirm the resemblance; the statement comes from
the repository itself (`LoginAuthBackdrop.tsx:4`, theme.css 736-741, ui-standard.md "Identity surfaces").
The warm trail colours also collide with the Console's severity semantics (red and orange mean severity
everywhere else).

F16 (minor). Dead code: `BrandHero`, `LoginIllustration`, `LOGIN_ILLUSTRATION_LABELS` in
`loginParts.tsx` have no importer except a type in `BrandingEditor.tsx`; the Tailwind keyframes
`hero-in-down`, `hero-in-up`, `aurora-a`, `aurora-b` (`tailwind.config.js:261-283`) are unused.

## 3. External research: what clean sign-in pages do

| Product | What I could verify | Source |
|---|---|---|
| Vercel | Heading "Log in to Vercel"; options in order: "Continue with Email" (first, full width), "Continue with Google", "Continue with GitHub", "Continue with ChatGPT", "Continue with SAML SSO", "Continue with Passkey", "Show other options"; provider logos have light and dark versions; no Remember me checkbox | https://vercel.com/login (fetched 2026-11-24) |
| Linear | Labels "Continue with Google", "Continue with Email" (magic link or code), "Continue with SAML SSO", passkeys ("Log in with passkey", added May 2024); admins can restrict methods | https://linear.app/docs/login-methods , https://linear.app/changelog/2024-05-30-passkeys-a-fast-and-secure-way-to-log-in-to-linear |
| Stripe | The Dashboard checkbox is labelled "Stay signed in", checked by default, "allows you to extend your session time"; the help page states no duration | https://support.stripe.com/questions/stay-signed-in-checkbox-on-the-sign-in-page |
| Notion | Methods: email code, email and password, Google, Apple, SAML SSO, passkeys ("Continue with Google" / Apple). The page layout itself did not render for me (not verified) | https://www.notion.com/help/log-in-and-out |
| 1Password | Sign-in needs email, Secret Key and account password; returning devices store the Secret Key. Page layout not verified | https://support.1password.com/secret-key/ , https://support.1password.com/sign-in-troubleshooting/ |
| Apple Account | "Trust this browser" skips two-factor for 30 days on the web (official). A "Keep me signed in" checkbox is reported by users, without a stated duration on the page (unverified, anecdotal) | https://support.apple.com/HT204053 , https://discussions.agilebits.com/discussion/comment/389632 |
| Raycast | Google, GitHub and Apple as sign-in providers; page wording not verified | https://manual.raycast.com/account-management |
| Microsoft Entra | Asks "Stay signed in?" after sign-in (KMSI); Yes issues a persistent cookie, otherwise a non-persistent cookie lasting 24 hours or until the browser closes; the prompt text itself names no duration | https://learn.microsoft.com/en-us/entra/fundamentals/how-to-manage-stay-signed-in-prompt |
| Arc | Reported as sunsetting on 2026-12-22, with sign-in already ended on mobile; not a useful reference now (reported, not verified on Arc's own page) | https://techcrunch.com/2026/10/22/arc-browser-sunsets-december-22-as-the-browser-company-doubles-down-on-dia/ |
| Mistral | Could not verify the live page | (none) |

Patterns that hold across the ones I could verify:
1. One column, a heading that names the product ("Log in to Vercel"), no hero, no moving background.
2. Every provider button carries its name in visible text ("Continue with ..." or "Sign in with ...").
3. "Keep me signed in" style options do not state a duration on the control (Stripe, Microsoft's
   prompt, Apple as reported). The duration lives in help text or admin settings.
4. Passkeys are now standard on developer tools (Vercel, Linear, Notion, Stripe:
   https://stripe.com/blog/passkeys-a-faster-more-secure-way-to-log-in-to-the-stripe-dashboard).

Standards used for the design:
- web.dev sign-in best practices: `autocomplete="username"` / `current-password` / `new-password`,
  name the button by its action, do not disable submit, show-password toggle, forgot-password path
  (https://web.dev/articles/sign-in-form-best-practices); Chrome's guide also says label the final
  submit "Sign in" rather than "Continue"
  (https://developer.chrome.com/docs/modern-web-guidance/guides/forms/autofill-sign-in-form). The
  page already follows the autocomplete rules.
- Motion: animate only `transform` and `opacity` (web.dev, above). NN/g: most UI animation belongs
  in 100 to 500 ms, simple feedback about 100 ms, larger transitions 200 to 300 ms, and "it is far more
  common for animations to be too long than too short" (https://www.nngroup.com/articles/animation-duration/).
- WCAG 2.3.3 Animation from Interactions (AAA) lists the `prefers-reduced-motion` query (C39) as a
  sufficient technique (https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html);
  WCAG 2.2.2 (Level A) is avoided by having no perpetual motion at all.

## 4. Proposed design

Principle: the form is the page, on the Console's own surface, with one accent colour (the org's),
one quiet entrance, and nothing that moves after it settles.

### 4.1 Layout

- `main`: `min-h-dvh bg-canvas` plus a class `login-canvas` that adds one static brand wash:
  `radial-gradient(60rem 28rem at 50% -8rem, hsl(var(--primary) / 0.08), transparent 70%)`. It
  follows the org accent, costs no JavaScript and is removed under `prefers-reduced-transparency` and
  `forced-colors`.
- One column, 25rem (400 px) wide at >= 640 px, centred in the viewport (`grid place-items-center`,
  `py-16`). No slab, no border, no shadow (the canvas is the surface, as on Vercel).
- Phones (< 640 px): the column is full width with 24 px side padding (`px-6`), top-aligned at
  `max(4rem, 12dvh)`, natural document scroll (no nested scroller, F14).
- Appearance switch: top-right corner (16 px inset, 24 px at >= 640 px), see 4.6.
- Footer: support link, operator chips and `footer_text` as one muted 12 px line under the form, as
  today.

### 4.2 Typography and hierarchy

- Mark: the org logo (`logo_data_url`, 32 to 40 px, `object-contain`) or the built-in `Shield` at
  28 px in `text-primary`. 32 px gap to the heading.
- H1: `text-2xl font-semibold tracking-tight` (24/32). Default "Sign in to {org_name}"; "Welcome back"
  only when this device remembers a username; `login_headline` replaces it.
- Description (14 px muted): only when it carries information: `login_subtitle` or `login_body` on the
  sign-in step, and the existing step descriptions for MFA, setup, forced change and enrollment. No
  default description on the sign-in step, and none on the password step (F11).
- Labels 14 px medium above fields; inputs `h-11` (44 px), `text-base` on phones (16 px, avoids browser
  focus zoom) and `sm:text-sm`; the Console `--input` border (3.27:1, F3) and the Console focus ring.
- Left-aligned hierarchy inside the centred column (keeps the current ui-standard reading order).

### 4.3 Sign-in flow (state machine unchanged)

1. Identity step: Username field, then the primary **Continue** button, always rendered (F5). An empty
   submit shows "Enter your username." inline and focuses the field (F6).
2. If SSO providers exist: a hairline divider with "or", then full-width outline buttons, `h-11`,
   provider mark plus visible text "Sign in with Google", "Sign in with Microsoft", "Sign in with
   {display_name}" (F8). The accessible names stay exactly as today, so tests that look them up by name
   keep passing. If Remember me is offered on this step (SSO present), its row sits directly under
   Continue.
3. Password step: the identity row (username plus "Back" or, for a remembered device, "Use a
   different account"), Password with the reveal toggle, the Remember me row, then **Sign in**. The
   hidden `autocomplete="username"` field stays.
4. Demo hint: unchanged content, one muted line under the form.

### 4.4 Remember me

- Available: a single row, the checkbox and the label "Remember me". No secondary line, no
  `aria-describedby` (the hint span is not rendered). This is the operator's ask.
- Turned off by the administrator, or not available on this connection: unchanged (disabled box and the
  one-line reason). These lines state no duration and explain an inert control (Round 12 D14 adjustment
  1). Optional cleaner variant for the operator to choose: hide the row when the administrator turned it
  off (an admin decision the user cannot act on), and keep the disabled row only for plain HTTP.
- The warning dialog on first check keeps its facts, including the duration and the inactivity limit.
  It appears once per person per device, after a deliberate click, and it is where the Round 14 D3
  "disclosure before opting in" now lives. If the operator wants no duration anywhere on the page, the
  limits bullet can say "You'll be asked to sign in again after the time your administrator set" instead;
  that is a weaker disclosure and should be a recorded decision.

### 4.5 Errors and notices

- Field errors (empty field, wrong credentials, 429, network) render in one message region directly
  under the active field: 14 px `text-critical-text` with a 16 px `AlertCircle`, `id="login-error"`,
  the field `aria-invalid`, the region `role="alert"` when it gains text. The quieter second line
  ("You've tried 3 times.") stays. The button stays enabled. This replaces the top `Alert` for field
  errors, so the error appears where the eye is and only one line is added.
- Page errors (SSO callback failure, enrollment session expired) keep the top `Alert`, with SSO codes
  mapped to fixed sentences (F7), for example `not_allowed` "Your account is not allowed to sign in with
  single sign-on.", `user_not_provisioned` "No account exists for this identity yet. Ask an
  administrator to add you.", `invalid_state` / `state_not_bound` "The sign-in link expired. Try
  again.", anything else "Single sign-on failed. Try again, or sign in with your username."
- The session-ended notice keeps its calm info style and copy (Round 14 rules).

### 4.6 Appearance switch

Replace the 214 px gradient pill and the system chip with one 32 px tall group, `role="group"
aria-label="Appearance"`, three 28 px round icon buttons (Monitor, Sun, Moon) with `aria-pressed` and the
names "Use system theme", "Light theme", "Dark theme", on `bg-card` with a `border-border` outline; the
pressed one is `bg-foreground text-background` (the inversion the current chip already uses for
1.4.11). It delegates to `ThemeProvider.setTheme` exactly as today. The two-frame "palette settling"
machinery (`Login.tsx:279-340`) goes away with the tiles it protected.

### 4.7 MFA, setup, forced change, enrollment

- MFA: the same column; six OTP cells `h-12`, `gap-1.5` (cells stay about 40 px wide at 320 px);
  auto-submit when the sixth digit arrives (pass `onComplete`, guarded by `busy`, F12); "Verify" stays
  for recovery codes and as a fallback; on failure clear the cells, focus the first one, show the
  inline error.
- Setup, forced change and mandated enrollment keep their copy, reserve slots and `MfaSetupCard`, and
  take the same input and button grammar.

### 4.8 Animation (CSS only)

All keyframes live in theme.css under `@media (prefers-reduced-motion: no-preference)`, use `transform`
and `opacity` only, fill `backwards` (the Round 12 lesson: a `both`-filled finished opacity animation
makes the element a backdrop root, `tailwind.config.js:285-291`), and set no `will-change`.

| # | What | Spec | Why |
|---|---|---|---|
| A1 | Page entrance, once per mount after the first-paint gate | Column: opacity 0 to 1, translateY 8 px to 0, 280 ms, `var(--motion-ease-premium)` | One calm arrival instead of perpetual motion |
| A2 | Step change (identity and password, sign-in and MFA) | Incoming form only: opacity 0 to 1, translateX 12 px to 0 forward, -12 px back, 200 ms; the outgoing form unmounts at once, heights are not animated | Shows direction without overlap or reflow |
| A3 | Primary button | Existing `press-scale` (scale 0.97, 100 ms) and the variant hover; busy = `Loader2` spin plus "Signing in..." in a fixed-width button | Feedback within NN/g's 100 ms band |
| A4 | Field error | The message fades in, opacity only, 150 ms | No vestibular motion on an error |
| A5 | Brand wash | Static. Optional: a single 600 ms opacity fade on first paint | Stays under WCAG 2.2.2's five seconds |
| A6 | Hand-off to the Console | `CenterSpinner` reveals its glyph and label after 300 ms (`animation: fade-in 200ms 300ms backwards`), so a fast sign-in goes from the form to the shell with no spinner flash; same canvas tokens, so no colour jump (F4) | The "animation" the user notices most is the transition into the app |

Under `prefers-reduced-motion: reduce` none of A1 to A5 run (the media query never matches, and the
global reset also applies); the page simply appears. Optional, off by default: a 240 ms, three-cycle
`translateX(+-3px)` shake of the password field on a failed attempt, reduced-motion gated.

### 4.9 Loading gate

Keep waiting for the four probes (the FOUC fixes are real), but render the final shell during the wait:
canvas, appearance switch and mark, with a small `LoadingGlyph` where the form goes that reveals after
300 ms, and drop `shape="page"`. Skip the duplicate branding fetch when ThemeProvider's own fetch is
recent (expose a `brandingFetchedAt` or a `brandingFresh` flag from `useTheme()`; refetch when Login
mounts after a sign-out or when older than about 30 s) (F13).

### 4.10 Light, dark, phone, branding

- Light and dark: Console tokens only (`--canvas`, `--card`, `--foreground`, `--muted-foreground`,
  `--input`, `--ring`, `--primary`, `--primary-foreground`, `--critical-text`), all already measured
  by `scripts/gate-contrast.mjs` in both themes. Add the pairs "input on canvas", "input on background"
  and "muted-foreground on canvas" to the gate so the login surfaces stay covered after the accent gate
  retires.
- Phone: section 4.1; every target at least 44 px tall; OTP cells at least 40 px wide at 320 px.
- Branding: `logo_data_url` and `org_name` visible (F10), `accent_color` drives the button, the ring and
  the wash (F9), `login_headline`/`login_body`/`login_subtitle`/`login_chips`/`footer_text`/
  `support_url` keep their places and plain-text rendering (#9). `login_layout` and
  `login_illustration` stay accepted and round-trip, and stay ignored (no backend change). The
  BrandingEditor login preview mirrors the new shell.

## 5. Copy changes

| Where | Today | Proposed |
|---|---|---|
| Remember me row, available (`RememberMeControls.tsx:87-91`) | "Remember me" plus "Stay signed in on this device for up to 24 hours" | "Remember me" only |
| Sign-in H1 default (`Login.tsx:708, 731`) | "Welcome back" | "Sign in to {org_name}"; "Welcome back" when the device remembers a username |
| Sign-in description default (`Login.tsx:716`) | "Sign in to continue to {org_name}." | none (operator copy still shows) |
| Password step description (`Login.tsx:734-735`) | "Enter the password for {username}." | none (the identity row shows the name) |
| Continue | appears after typing | always shown |
| Empty username | nothing happens | "Enter your username." |
| SSO buttons | icon only, sr-only "Sign in with X" | visible "Sign in with Google" / "Sign in with Microsoft" / "Sign in with {display_name}" |
| SSO callback error (`Login.tsx:423`) | "Single sign-on failed: {raw code}" | fixed sentences per code, generic sentence otherwise |
| Appearance control | "Light mode: switch to dark mode" pill plus "Use system theme" | group "Appearance": "Use system theme", "Light theme", "Dark theme" |
| Docs `docs/getting-started/first-run.md:100-116` | "the button appears once you type a username"; screenshots titled Welcome back | updated sentence, two new screenshots; the docs may keep "up to 24 hours" (help text, not the page) |
| BrandingEditor (`BrandingEditor.tsx:511-512, 1271, 1353`) | placeholder and help mention "Welcome back" | "Sign in to {org_name}" |

## 6. Recommendations (implementable)

R1. Remember me row says only "Remember me". Effort S, value high.
- Where: `RememberMeControls.tsx` `RememberMeControl`: compute `hint` only for the two unavailable
  states; render the hint span and `aria-describedby` only when `hint` is set.
- Risks: reverses Round 14 D3; record it in the Round 16 SPEC with the dialog as the disclosure.
- Test: `login.remember.test.tsx` cases "offers the box with the policy duration and a 44px row" and
  "formats a 6 hour preset" become: the row's accessible name is "Remember me", it has no accessible
  description, and the row contains no text matching `/hour|minute/`; the dialog cases that assert the
  duration stay unchanged. Lazy chunk, 0 entry bytes.

R2. Remove the ambient backdrop and the identity palette; move the page onto Console tokens. Effort M,
value high.
- Where: delete `LoginAuthBackdrop.tsx` and its test; delete theme.css lines 734 to the identity-accent
  fallbacks (about 800 source lines) and add the about 20-line block of section 4.8; `Login.tsx` shell
  markup (`formInner`, the gate, `main`).
- Risks: reverses the recorded ui-standard "Identity surfaces" contract (Round 12-14 work); the login
  loses its isolated look and gains continuity with the Console. Fixes F1 to F4, F14, F15.
- Test: no element with `data-login-ambient-*`; with fake timers, advancing 60 s causes no re-render of
  the page (spy on a render counter); a source guard that parses theme.css and asserts every
  `@keyframes login-*` body touches only `opacity` and `transform`, sits inside
  `prefers-reduced-motion: no-preference`, has no `infinite`, and lasts at most 300 ms (600 ms for the
  optional wash).

R3. Replace `ShineButton` with the primary `Button`; retire the login accents gate. Effort S, value
medium.
- Where: `Login.tsx` (Continue, Sign in); delete `ShineButton.tsx`, `ThemeModePill.tsx`,
  `auth-accents.test.tsx`, `scripts/gate-login-accents.mjs` and `.d.mts`, step 6 in `scripts/gates.mjs`,
  the "login identity accents" block in `design-gates.test.ts`, the two paths in
  `bundle-first-paint.test.ts:587-588`, and the `foundations.test.ts:417-490` login canvas block.
- Risks: AGENTS.md forbids removing a gate "merely to make a release green". Here the gate's subject is
  deleted, so record it in the SPEC as subject removal and add the replacement contrast pairs of 4.10 in
  the same change.
- Test: `gate-contrast` passes with the new pairs; the button follows an operator accent (set
  `accent_color`, assert `--primary` drives it and `--primary-foreground` clears 4.5:1 through the
  existing `theme-tokens` guard tests).

R4. Three-option appearance switch. Effort S, value medium. Where: `LoginThemeControl` in Login.tsx
(prototype in the scratchpad: about 30 lines). Test: the group exposes three pressed-state buttons;
each sets `soc.theme` to `system`, `light`, `dark`; axe clean.

R5. Always-visible Continue and an inline empty-username message. Effort S, value medium. Where:
`continueSignin` and the identity form. Test: Continue present at first paint; Enter on an empty field
shows "Enter your username.", focuses the field, and does not change step.

R6. Labelled full-width SSO buttons under an "or" divider. Effort S, value medium. Where:
`Login.tsx:1078-1110`. Keep the accessible names "Sign in with X". Test: visible text equals the
accessible name; the generic OIDC provider shows its `display_name`; three providers stack.

R7. Closed-vocabulary SSO error messages. Effort S, value high (removes text injection on the sign-in
page). Where: a `SSO_ERRORS` map next to the `sso_error` effect (`Login.tsx:418-429`). Risk: a newer
backend code shows the generic sentence (acceptable, same as `signedOutNotice`). Test: every backend
code maps to a sentence (a test reads the codes from `routes.py` or a shared list); an arbitrary value
such as "Call 555" never appears in the DOM.

R8. Inline field errors. Effort S to M, value medium. Where: the identity and password forms and the
MFA form; keep `login-error` and `aria-invalid` wiring. Test: the existing "keeps the username and
returns focus to an announced invalid password after failure" keeps its assertions on focus and
description; the error is now inside the field group.

R9. Header: visible mark and "Sign in to {org_name}", no redundant descriptions. Effort S, value
medium. Where: `titleByMode`, `descByMode`, `activeDescription`, the header markup. Test: one `h1`;
"Welcome back" only with a remembered username; `login_headline` still replaces the H1 and
`login_body`/`login_subtitle` still render as plain text (the existing white-label tests).

R10. OTP auto-submit. Effort S, value medium. Where: pass `onComplete` to `OtpInput` in the MFA branch,
guarded by `busy`. Test: six digits typed or pasted call `api.auth.mfa.verify` exactly once.

R11. Smooth cold load and hand-off. Effort M, value medium. Where: `App.tsx` `CenterSpinner` (delayed
reveal), Login's gate (final shell plus delayed glyph, no `shape="page"`), `theme.tsx` freshness flag
for branding. Risks: the FOUC regression tests (`login-branding-sync`, `login-jank-reserve`,
`login-layout-fixes`) must still hold: the form must not paint before the probes settle. Test: those
tests keep passing; a new test asserts one `/api/branding` call on a cold load and two after a sign-out.

R12. BrandingEditor preview mirrors the new shell. Effort S, value medium. Where:
`BrandingEditor.tsx:503-570` (drop `LoginAuthBackdrop staticFrame`, the 480 x 492 slab). Test:
`BrandingEditor.preview.test.tsx` and `BrandingEditor.login.test.tsx` updated to the new geometry.

R13. Records: ui-standard.md "Identity surfaces" and "Identity accents" rewritten to this design;
first-run.md and its two screenshots; CHANGELOG `[Unreleased]`; ratchet `PRE_REVAMP_ENTRY_BYTES` to the
measured entry; regenerate the Help Center knowledge if `build_app_knowledge --check` fails. Effort S,
value medium.

R14. Cleanup: delete the dead `BrandHero`, `LoginIllustration` and their label maps from
`loginParts.tsx` (keep `LoginLayout`/`LoginIllustration` types and the `as*` coercers that
`login.api.ts` and BrandingEditor use), and the unused Tailwind keyframes. Effort S, value low.

R15 (optional). A "Forgot password?" disclosure under the password field that says "Ask an
administrator to reset it" (there is no self-service reset), matching web.dev's forgot-password advice.
Effort S, value low.

R16 (not this round). Passkeys: WebAuthn registration in Account, a "Sign in with a passkey" button and
`autocomplete="username webauthn"` conditional UI on the username field. Effort L, value high (Vercel,
Linear, Notion and Stripe all offer it), backend work in `backend/app/auth/` and new KV records; out of
scope for a presentation round.

## 7. Tests that change

Measured by running the current login tests against the prototype (scratchpad copy): 19 of 253 failed,
in 8 of 12 files, all for the expected reasons.

| File | What changes |
|---|---|
| `webui/src/soc/__tests__/login.render.test.tsx` | The first case pins the Mistral geometry (`sm:w-[30rem]`, `sm:min-h-[30.75rem]`, `sm:px-12`, `sm:pb-24`), `data-login-ambient-grid`, `data-login-ambient-cadence="mistral"`, four guides, four tiles, the pill names, `data-login-theme-palette-settling`, SSO `h-10`, Continue hidden until typing and its `login-shine-button` class, inputs `h-12`; rewrite to the new shell. "shows no em dash" walks accessible names (update for the new controls). Headline "Welcome back" assertions |
| `webui/src/soc/__tests__/login.remember.test.tsx` | Lines 198-215 (the hint copy and `toHaveAccessibleDescription`); header comment item 1; "sends remember with the sign-in and with single sign-on" only if SSO names change (they should not, R6) |
| `webui/src/soc/__tests__/login-layout-fixes.test.tsx` | "renders one minimal pane with ordinary theme tokens" and the loading-gate case (pill name, Continue presence) |
| `webui/src/soc/__tests__/login-jank-reserve.test.tsx` | SSO probe case looks up "Sign in with Google" as text; keep it passing by rendering that visible text (R6) |
| `webui/src/soc/__tests__/login-branding-sync.test.tsx` | The first-paint gate case (selectors and headline) |
| `webui/src/soc/components/__tests__/LoginAuthBackdrop.test.tsx` | Deleted with the component |
| `webui/src/soc/components/__tests__/auth-accents.test.tsx` | Deleted, replaced by appearance-switch cases |
| `webui/src/soc/__tests__/design-gates.test.ts` | The "login identity accents" describe removed; new contrast pairs asserted |
| `webui/src/design-system/__tests__/foundations.test.ts` | The "login identity canvas" block (lines 417-490) removed |
| `webui/src/soc/__tests__/bundle-first-paint.test.ts` | Eager-chain list drops `ShineButton.tsx`/`ThemeModePill.tsx`; baseline comment and ratchet |
| `webui/src/soc/components/__tests__/BrandingEditor.preview.test.tsx`, `BrandingEditor.login.test.tsx` | Preview geometry and placeholder copy |
| `webui/src/soc/__tests__/auth-boot-gates.test.tsx` | Only if `CenterSpinner` markup changes (delayed reveal keeps the label) |
| New | Remember me label-only; Continue always present; empty username message; SSO error mapping; OTP auto-submit once; no timers after first paint; theme.css login keyframe source guard; one branding fetch on cold load |

## 8. Risks and decisions for the orchestrator

1. The operator's ask reverses Round 14 D3 (keep the hint). Record a new decision: the row is
   label-only; the dialog carries the disclosure. Confirm whether the dialog keeps the number (my
   recommendation) or loses it too.
2. Showing the row disabled with a reason (Round 12 D14 adjustment 1): keep as is (recommended), or hide
   it when the administrator turned it off.
3. The redesign replaces a recorded ui-standard contract (Identity surfaces and Identity accents). The
   SPEC must say so explicitly and rewrite both sections, or later reviews will flag the change.
4. Retiring `gate-login-accents.mjs` is subject removal, not gate softening; add the replacement contrast
   pairs in the same change.
5. The Round 16 "What's new" screen (another operator ask) should appear after the hand-off, inside the
   Console, never on the sign-in page; A1 must not chain with it.
6. Visual verification needs real screenshots in light and dark at 1280 px and 375 px for the release
   tracker; AGENTS.md notes the sandbox blocks the Playwright CDNs, so use whatever capture path the
   round already uses.

## 9. Entry-byte impact (measured)

Method: the webui was copied to the scratchpad (`node_modules` symlinked), built with `npx vite build`
before and after a throwaway prototype of R2, R3, R4, R5, R6 (with visible "Continue with X" text),
R7, R9 (header only) and R10, and the entry attributed per source file through its source map
(`attrib.cjs` in the scratchpad). The unmodified copy reproduces the recorded baseline exactly.

| | Before | After | Delta |
|---|---|---|---|
| Entry chunk (`index-*.js`) | 329,080 B | 321,910 B | -7,170 B |
| Entry gzip | 100.40 kB | 98.32 kB | -2.08 kB |
| Global stylesheet (`index-*.css`, render-blocking on every page) | 239,828 B | 225,932 B | -13,896 B |
| Login.tsx in the entry | 21,676 B | 21,682 B | +6 B |
| LoginAuthBackdrop.tsx / ThemeModePill.tsx / ShineButton.tsx in the entry | 5,380 / 1,350 / 436 B | 0 | -7,166 B |
| `icons-*.js` (Sun, Moon) | 106,916 B | 106,916 B | 0 (already in the icons chunk) |

Not in the prototype and estimated: inline error regions (R8) about +150 to +250 B, the Remember me
change (R1) 0 entry bytes (lazy chunk), the delayed-reveal `CenterSpinner` and branding freshness flag
(R11) about +100 to +200 B, the dead-code cleanup (R14) about 0 (already tree-shaken). Expected net:
about -6,700 to -7,000 B, inside the +1,024 B budget with room to spare and well under the 400,000 B
ceiling. Motion stays off the entry path (no `motion` import anywhere in the login chain; all animation
is CSS). Per the Round 15 practice, ratchet `PRE_REVAMP_ENTRY_BYTES` down to the merged measurement so
the saving cannot be spent unseen.

Side note for whoever needs more entry headroom this round: `src/design-system/assets/source-marks.ts`
contributes 7,056 B to the entry (connector brand marks such as Splunk and CrowdStrike appear in the
entry chunk). I did not trace which eager module pulls it in; worth checking, unverified.

## 10. Journal entry (for the orchestrator to append)

```
### 2026-11-24 20:15Z - research agent (login) - Round 16 sign-in page research
- Context: Round 16 discovery; operator asked for a cleaner login page and animation, and a Remember me row that says only "Remember me".
- Did: read Login.tsx and its parts, RememberMeControls, theme.css identity canvas, the login gates and tests, Round 12 D14 and Round 14 D3 records; researched Vercel, Linear, Stripe, Notion, 1Password, Apple, Raycast, Microsoft Entra and the Google/Microsoft SSO brand rules, web.dev, NN/g and WCAG 2.2.2/2.3.3; built a throwaway prototype in the scratchpad only. Findings: perpetual ambient motion with no pause control (WCAG 2.2.2 risk), top/left animation, 1.41:1 login field edges, colour jumps at boot and hand-off, Continue pop-in shift, silent empty-username submit, raw sso_error text injection, icon-only SSO, accent ignored by the CTA, org name never visible, unused OTP auto-submit, duplicate branding fetch.
- Tests: ran the 12 login-related test files against the prototype (19 expected failures in 8 files); prototype entry 329,080 B to 321,910 B, CSS -13,896 B.
- Status: done (report only; no repository changes).
- Next: SPEC decisions on Round 14 D3 reversal, the dialog duration, the ui-standard identity contract and retiring gate-login-accents with replacement contrast pairs.
```
