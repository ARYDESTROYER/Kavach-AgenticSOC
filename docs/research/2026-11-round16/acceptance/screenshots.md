# Release screenshots for 0.2.0 (WP17B)

Every screenshot SPEC §5.3 asks for, in light and dark, and the eight highlights of the newest
What's new update (`0.2.0.2026-12`) that now carry images. Of these 76 files, the 16 the notes
use are in `docs/assets/releases/0.2.0/`. The other 60 are review captures: WP17C moved them to
`docs/research/2026-11-round16/acceptance/screenshots/` (written `screenshots/...` in the table
below), which the Help Center bundle leaves out.

## How they were taken

- **Source.** The seeded Demo only (`DEMO_MODE=seeded ./scripts/run-demo.sh`), signed in as the
  Demo's `Admin`, on the tree at `08db702`. The people, hosts and email addresses on screen are
  the seeded Demo's fictional ones (`lumenpay.example` and the like). The MFA step used one extra
  account made on that throwaway backend (`soc.analyst`); its password and second-factor secret
  appear in no image.
- **Browser.** Playwright 1.63.0 Chromium, headless. Desktop 1440 by 900 CSS pixels and phone 390
  by 844, both at device scale factor 2, so a full desktop frame is 2880 by 1800 pixels and a
  phone frame 780 by 1688. A crop keeps the device scale (`ai-working` is a 975 by 441 CSS crop,
  1950 by 882 pixels). The contact sheet is a page composed of the tiles, rendered 1440 CSS
  pixels wide and saved at one pixel per CSS pixel (1440 by 2022) to stay under the size cap.
- **Encoding.** PNG from the browser, then WebP through ImageMagick 6.9 (libwebp 1.3.2) with
  `-strip -quality Q -define webp:method=6`. The notes images use quality 80 to 90 and the review
  captures 74; the encoder would lower the quality in steps of 6 for a file over 256,000 bytes,
  and none needed it. Every file is at most 250 KB and at most 2,880 pixels wide, the limits
  `scripts/build_release_notes.py` enforces.
- **Theme.** Switched with the top-bar theme control (on the sign-in page, its own Light and Dark
  buttons), never by the browser scheme alone. Each file was checked twice: by mean luminance
  (every `-light` file above 0.5, every `-dark` file below 0.5) and by eye.
- **Privacy check.** Each image was looked at for secrets, real emails and personal names. Two
  things on screen are deliberate and harmless: the Demo sign-in hint `Admin / Admin@123` (the
  documented Demo default, printed by the Demo sign-in page) on the username and single sign-on
  error steps, and 8-character prefixes of throwaway Demo session ids in the Sessions & activity
  and Audit log tiles of the contact sheet. Those sessions ended with the Demo.

## Every capture

Bytes and pixel sizes are those of the committed files. Item numbers are SPEC §5.3.

| SPEC §5.3 item | Light | Dark |
|---|---|---|
| 1. Case Manager queue with an AI-working row mark (featured `case-workspace`) | `case-workspace-light.webp`: 213,976 B, 2880 by 1800 | `case-workspace-dark.webp`: 202,744 B, 2880 by 1800 |
| 2. Case header with the AI chip and its popover open (featured `ai-working`) | `ai-working-light.webp`: 85,172 B, 1950 by 882 | `ai-working-dark.webp`: 77,626 B, 1950 by 882 |
| 3. Brief tab: Next step row and the four lanes (featured `case-tabs`) | `case-tabs-light.webp`: 80,848 B, 1950 by 1322 | `case-tabs-dark.webp`: 74,994 B, 1950 by 1322 |
| 4. Evidence tab with the events table and its side sheet | `screenshots/case-evidence-light.webp`: 103,852 B, 2880 by 1800 | `screenshots/case-evidence-dark.webp`: 95,954 B, 2880 by 1800 |
| 5. AI investigation tab with the trace and an expanded step detail | `screenshots/case-ai-investigation-light.webp`: 182,650 B, 2880 by 1800 | `screenshots/case-ai-investigation-dark.webp`: 176,084 B, 2880 by 1800 |
| 6. Response tab (tasks and a runbook run) | `screenshots/case-response-light.webp`: 198,656 B, 2880 by 1800 | `screenshots/case-response-dark.webp`: 190,050 B, 2880 by 1800 |
| 7. Activity tab: discussion and files | `screenshots/case-activity-light.webp`: 163,048 B, 2880 by 1800 | `screenshots/case-activity-dark.webp`: 156,250 B, 2880 by 1800 |
| 7. Activity tab: history with status reasons | `screenshots/case-activity-history-light.webp`: 160,544 B, 2880 by 1800 | `screenshots/case-activity-history-dark.webp`: 159,940 B, 2880 by 1800 |
| 8. The close dialog with the AI-running warning | `screenshots/close-dialog-ai-running-light.webp`: 139,856 B, 2880 by 1800 | `screenshots/close-dialog-ai-running-dark.webp`: 129,022 B, 2880 by 1800 |
| 9. Risk explain: the hover line | `screenshots/risk-hover-light.webp`: 57,840 B, 1950 by 548 | `screenshots/risk-hover-dark.webp`: 53,446 B, 1950 by 548 |
| 9. Risk explain: the click panel (featured `explain-numbers`) | `explain-numbers-light.webp`: 145,704 B, 1950 by 1664 | `explain-numbers-dark.webp`: 134,284 B, 1950 by 1664 |
| 10. Decision explain (see Limitations) | `screenshots/decision-explain-light.webp`: 207,080 B, 2880 by 1800 | `screenshots/decision-explain-dark.webp`: 196,852 B, 2880 by 1800 |
| 11. The inspector with the View all fields sheet open (on `case-records`) | `case-records-light.webp`: 104,832 B, 2880 by 1800 | `case-records-dark.webp`: 97,004 B, 2880 by 1800 |
| 12. The usage popover with per-call formulas | `screenshots/case-usage-light.webp`: 219,626 B, 2880 by 1800 | `screenshots/case-usage-dark.webp`: 204,898 B, 2880 by 1800 |
| 13. Sign-in: username step | `screenshots/sign-in-username-light.webp`: 22,048 B, 2880 by 1800 | `screenshots/sign-in-username-dark.webp`: 20,994 B, 2880 by 1800 |
| 13. Sign-in: password step with Remember me (featured `sign-in`) | `sign-in-light.webp`: 13,850 B, 1600 by 900 | `sign-in-dark.webp`: 12,992 B, 1600 by 900 |
| 13. Sign-in: MFA step | `screenshots/sign-in-mfa-light.webp`: 26,080 B, 2880 by 1800 | `screenshots/sign-in-mfa-dark.webp`: 25,192 B, 2880 by 1800 |
| 13. Sign-in: an SSO error sentence | `screenshots/sign-in-sso-error-light.webp`: 28,294 B, 2880 by 1800 | `screenshots/sign-in-sso-error-dark.webp`: 26,688 B, 2880 by 1800 |
| 13. Sign-in at 390 by 844: username step | `screenshots/sign-in-phone-username-light.webp`: 15,740 B, 780 by 1688 | `screenshots/sign-in-phone-username-dark.webp`: 14,276 B, 780 by 1688 |
| 13. Sign-in at 390 by 844: password step | `screenshots/sign-in-phone-password-light.webp`: 14,974 B, 780 by 1688 | `screenshots/sign-in-phone-password-dark.webp`: 13,690 B, 780 by 1688 |
| 13. Sign-in at 390 by 844: MFA step | `screenshots/sign-in-phone-mfa-light.webp`: 19,414 B, 780 by 1688 | `screenshots/sign-in-phone-mfa-dark.webp`: 17,842 B, 780 by 1688 |
| 13. Sign-in at 390 by 844: an SSO error sentence | `screenshots/sign-in-phone-sso-error-light.webp`: 21,414 B, 780 by 1688 | `screenshots/sign-in-phone-sso-error-dark.webp`: 19,460 B, 780 by 1688 |
| 14. The What's new dialog after sign-in | `screenshots/whats-new-dialog-light.webp`: 117,784 B, 2880 by 1800 | `screenshots/whats-new-dialog-dark.webp`: 108,944 B, 2880 by 1800 |
| 15. Communication, What's new page with the version rail (featured `whats-new`) | `whats-new-light.webp`: 166,418 B, 2880 by 1800 | `whats-new-dark.webp`: 159,552 B, 2880 by 1800 |
| 16. Navigation with the Communication group open and the Case Manager AI count | `screenshots/nav-communication-light.webp`: 184,536 B, 2880 by 1800 | `screenshots/nav-communication-dark.webp`: 174,832 B, 2880 by 1800 |
| 17. An Overview KPI explain panel | `screenshots/overview-kpi-explain-light.webp`: 140,268 B, 2880 by 1800 | `screenshots/overview-kpi-explain-dark.webp`: 132,836 B, 2880 by 1800 |
| 17. The Metrics explain samples | `screenshots/metrics-explain-samples-light.webp`: 152,738 B, 2880 by 1800 | `screenshots/metrics-explain-samples-dark.webp`: 136,862 B, 2880 by 1800 |
| 18. The Inbox item for a finished manual run | `screenshots/inbox-run-finished-light.webp`: 61,590 B, 2880 by 1800 | `screenshots/inbox-run-finished-dark.webp`: 60,034 B, 2880 by 1800 |
| 19. Case detail at 390 by 844 | `screenshots/case-phone-light.webp`: 59,102 B, 780 by 1688 | `screenshots/case-phone-dark.webp`: 55,498 B, 780 by 1688 |
| 20. Case Manager queue focus mode (the narrow strip) | `screenshots/queue-focus-light.webp`: 157,702 B, 2880 by 1800 | `screenshots/queue-focus-dark.webp`: 149,540 B, 2880 by 1800 |
| 20. The empty pane | `screenshots/empty-pane-light.webp`: 113,806 B, 2880 by 1800 | `screenshots/empty-pane-dark.webp`: 108,762 B, 2880 by 1800 |
| 21. Sign-in: the Remember me warning dialog | `screenshots/remember-me-warning-light.webp`: 57,660 B, 2880 by 1800 | `screenshots/remember-me-warning-dark.webp`: 53,454 B, 2880 by 1800 |
| 21. Sign-in: the row unavailable with its reason | `screenshots/remember-me-unavailable-light.webp`: 24,132 B, 2880 by 1800 | `screenshots/remember-me-unavailable-dark.webp`: 23,136 B, 2880 by 1800 |
| 22. The non-blocking Reinvestigate dialog | `screenshots/reinvestigate-dialog-light.webp`: 74,692 B, 2880 by 1800 | `screenshots/reinvestigate-dialog-dark.webp`: 71,044 B, 2880 by 1800 |
| 22. Bulk selection in Demo Mode (see Limitations) | `screenshots/bulk-select-demo-light.webp`: 212,410 B, 2880 by 1800 | `screenshots/bulk-select-demo-dark.webp`: 201,676 B, 2880 by 1800 |
| 23. Appearance with the What's new switch and the read-only theme line | `screenshots/appearance-light.webp`: 145,284 B, 2880 by 1800 | `screenshots/appearance-dark.webp`: 139,548 B, 2880 by 1800 |
| 24. Contact sheet of the Console bug-fix surfaces at 1440 and 390 | `screenshots/bug-fixes-contact-sheet-light.webp`: 132,214 B, 1440 by 2022 | `screenshots/bug-fixes-contact-sheet-dark.webp`: 126,416 B, 1440 by 2022 |
| No item: Updates & releases with the new repository (featured `repository-identity`) | `repository-identity-light.webp`: 70,006 B, 2016 by 1070 | `repository-identity-dark.webp`: 67,218 B, 2016 by 1070 |

76 files, 7,965,474 bytes in all. The contact sheet's tiles (item 24) cover Sessions & activity
labels (B55), the Settings inline SLA error (B51), Approvals (B36, B37), Inbox preferences (B53),
Roles & permissions labels (B57), the setup wizard's Demo rows (B43), Data export in Demo Mode
(B49), the Appearance theme line (B45), the Audit log at 1440 and at 390 (B72, B79), the Help
Center Latest Stable link (B54), and the Auto-tuning and Cost explain lines.

## Wired into the notes

`docs/releases/notes/0.2.0.json`, update `0.2.0.2026-12`; no update id changed, and no older
update or its images was touched.

1. `ai-working`, featured, `ai-working-{light,dark}.webp`.
2. `case-workspace`, featured, `case-workspace-{light,dark}.webp`.
3. `repository-identity`, featured, `repository-identity-{light,dark}.webp`, moved from eighth to
   third place as the capture plan asks, because the Settings field reads
   `https://github.com/ARYDESTROYER/Kavach-AgenticSOC`. The labels on screen match the alt text:
   the **Updates & releases** section, with **Public repository**, **Stable branch** and
   **Testing branch** fields.
4. `case-tabs`, featured, `case-tabs-{light,dark}.webp`.
5. `explain-numbers`, featured, `explain-numbers-{light,dark}.webp`. Its `help` now points at
   `analyst/explainable-numbers/`, the Help Center page the plan names (it is in the `mkdocs.yml`
   nav).
6. `whats-new`, featured, `whats-new-{light,dark}.webp`.
7. `sign-in`, featured, `sign-in-{light,dark}.webp`.
8. `case-records`, not featured, `case-records-{light,dark}.webp` with alt text and no caption.

Seven highlights are featured (the limit is eight). Alt texts and captions are the capture plan's,
except that the `case-records` alt text now says **Copy JSON**, as the sheet does. `access-fixes`,
`fixes` and `license` stay without images, as the plan says; the contact sheet is a review record
of many small surfaces and is not readable at the 48rem width the page gives a figure.

The welcome for an account holding `system_updates:read` shows `ai-working`, `case-workspace`,
`repository-identity`, `case-tabs` and `explain-numbers`. A viewer without that grant skips
`repository-identity` and sees `whats-new` fifth. `case-tabs` stays inside the first five either
way, as `decide.test.ts` requires.

## Live checks

Run against the seeded Demo after `python3 scripts/build_release_notes.py` and a fresh Help Center
bundle (`npm run docs:bundle`), once in each theme:

- **The welcome for an upgraded account.** With the account's `whats_new_seen` set to the older
  update `0.2.0.2026-11-25`, reloading the Overview opened the welcome ("One update since you last
  looked.") with the five highlights above and the hero image
  `/docs/0.2/assets/releases/0.2.0/ai-working-{light,dark}.webp` loaded in the current theme
  (1,950 pixels wide). **Got it** moved the marker to `0.2.0.2026-12`, and the next reload showed
  no welcome.
- **Communication, What's new.** Every release in the rail renders: 0.2.0 with 66 highlights and
  18 figures, all 18 loaded and none broken once each was scrolled into view; 0.1.1 with 9
  highlights and no figures. The same in light and dark.

## Limitations

- **Item 1, the band notice.** The Case Manager band line ("AI is investigating 1 new alert. It
  joins the queue when the investigation finishes.") counts only AI runs on new events. The
  seeded Demo paces manual and job runs, not new-event runs, so the line had nothing to show.
  `case-workspace` shows the queue row's AI working mark, the header chip and the navigation
  count instead.
- **Item 10, "policy changed since".** The seeded cases were decided without a recorded gate, so
  the decision panel reads "Thresholds not recorded for this decision; these are today's policy
  values." In Demo Mode the server's decision reading uses the Demo's own sandbox policy, so a
  policy change in Settings cannot produce the "changed since" state either. `decision-explain`
  shows the not-recorded reading of an auto-closed case.
- **Item 22, the bulk-close warning.** Bulk changes are off in Demo Mode, so the bulk Close
  dialog cannot open. `bulk-select-demo` shows three cases selected, one with an AI run in
  progress, and the bar's Demo Mode reason.
- **Item 9, the click panel.** The risk panel scrolls. The crop shows the weights, the steps, the
  weighted sum, the total, the rounding, the provenance and **Copy calculation**; the panel's
  title is scrolled out of view above the weights.
- **Files on a Demo case.** The Activity capture reads "Files 1 of 5": the Demo's in-memory store
  allows 5 screenshots per case, a durable store 20.
- **`docs/assets/screenshots/`.** SPEC §5.3 also asks WP17 to refresh the Help Center
  screenshots there. This package was told not to touch that folder, so they are unchanged.
  WP17C refreshed them afterwards.

## Findings for other packages

- **Help Center bundle size.** All 76 files ship in the Help Center bundle and so in the Console
  image (about 8 MB), although only the 16 notes images are referenced. Keeping the review
  captures out needs an `exclude_docs` entry in `mkdocs.yml` (one line per file, or a sub-folder
  for review captures), which this package does not own. Done in WP17C: the 60 review captures
  moved under `research/`, which `exclude_docs` already leaves out, and the Help Center bundle
  went from 24,532,194 bytes (341 files) to 18,046,412 bytes (281 files).
- **Demo Settings and the Brief.** In Demo Mode a change to the auto-close policy in Settings
  changes the Brief's Decision lane sentence (it reads the stored settings) but not the server's
  decision reading (it uses the Demo sandbox policy), so the two disagree until the change is
  undone. The captures were taken with the policy unchanged. WP17C confirmed it and wrote it as
  a Demo known limitation in `docs/getting-started/demo.md`.
- **`test_app_help_tool_keeps_a_destination_the_console_labels_confirm`** fails at `08db702`,
  with or without this package's corpus (`settings:data_export` comes back beside
  `page:batchjobs`). The XFINT merge (`605a61e`, after this base) changes that help link.
