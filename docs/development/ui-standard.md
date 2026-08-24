---
title: Console UI standard
description: The current enforceable visual, interaction, loading, navigation, and accessibility contract for every Agentic SOC Console page.
---

# Console UI standard

This is the current implementation contract for the Agentic SOC Console. It turns the
Cyber Defence Center visual language into reusable rules for every route. New work
must use these primitives; existing pages migrate toward them as they are touched.

## Migration contract

The shared shell, navigation rail, route-loading fallback, in-app Documentation
index, Case Manager, Settings frame, and Entity investigation workflow are the
current reference surfaces. Other routes remain supported while they move to this
grammar incrementally; a page is not called migrated merely because the shell around
it changed.

When touching an older page, include its loading/empty/error states, menus and
popovers, both themes, narrow layout, and keyboard path in the same change. Remove
page-local card, color, spacing, and motion inventions rather than layering new chrome
over them. Keep deep links and permissions stable, and record any intentional legacy
route in the feature registry and operator documentation.

## Visual character

The Console is a calm SOC command surface: near-black dark mode, quiet light mode,
hairline dividers, dense but readable information, and semantic color only when the
meaning warrants it. Avoid decorative gradients, nested cards, heavy resting shadows,
large rounded marketing panels, emoji status symbols, and animation that competes with
case state.

- Use `background`, `surface`, `card`, `border`, `foreground`, and
  `muted-foreground` tokens from `theme.css`; never add page-local hex colors.
- Use the shared severity/status/verdict/risk palette. Color supplements an icon or
  label; it never carries meaning alone.
- Prefer transparent sections separated by `border-border` over card-inside-card
  layouts. A card is reserved for a selectable record, contained editor, dialog, or
  genuinely independent widget.
- Controls are compact and squared/quiet (`Button`, `Select`, `SegmentedControl`,
  `TimeRangePicker`); keep one visual grammar in light and dark themes.

## Page anatomy

Every routed page follows the same order:

1. `PageContainer` owns the width (`fixed`, `wide`, `fluid`, or `prose`).
2. One `PageHeader` owns title, description, status metadata, and primary actions.
3. Optional controls occupy one compact `ControlBar`/`FilterBar` band.
4. Content is organized into flat sections or shared data/table/chart components.
5. Loading, empty, denied, error, and partial-data states occupy the same geometry as
   the final content so the layout does not jump.

Do not repeat a page title inside the first content panel. Do not add an eyebrow such
as “Decision brief” when the actual outcome heading is already explicit. A nested
workflow can have its own section label only when it adds information.

Tabbed or embedded leaves yield width, heading, and page-action authority to their
host. They may contribute a labelled `ControlBar`, but must not nest another
`PageContainer` or detach an unlabelled refresh row. Queue filters and refresh actions
belong in that control band; `PageHeader` stays focused on route identity and the
single primary action.

`ControlBar` adapts to its own available width, including inside a split pane. Put the
task-defining controls in its primary slot so they remain first in visual and tab order;
lower-priority fields, selects, and segmented controls belong in the secondary slot and
wrap after them. Only simple button-like commands may use the overflow-action contract:
they stay inline on a roomy desktop band and move behind one visibly labelled **More
actions** menu below the shared component breakpoint. Menu items keep visible text,
disabled and consequential styling, Radix arrow-key/Enter/Escape behavior, and return
focus to the trigger when the menu closes. Never move form fields, value selectors, a
sole primary action, or an in-progress command into overflow. Keep `role="group"` for
ordinary independently tabbable controls; do not advertise `role="toolbar"` unless the
implementation also supplies the toolbar roving-focus keyboard model.

## Empty-state semantics

Use the shared `EmptyState` with an explicit `state` whenever a Console surface has
loaded but cannot render its ordinary content. The state is an operator truth, not a
decorative tone:

- **`first-use`** — the capability is available, but its prerequisite configuration
  or first record has not been created. Name the missing prerequisite and offer the
  safest create/configure action when the operator is allowed to take it.
- **`no-data`** — the requested scope loaded successfully and contains no records.
  State that scope without implying success, failure, or a disabled capability.
- **`no-results`** — records may exist, but the current search or filters exclude all
  of them. Preserve the operator's filters and provide one clear/reset action.
- **`success`** — absence is the confirmed desirable outcome, such as a completed or
  clear attention queue. Say what was checked and what the operator should do next;
  do not infer success from missing, degraded, or unavailable evidence.
- **`unavailable`** — a known disabled, unsupported, or unmet prerequisite prevents
  the content from being produced. Explain the prerequisite and the safe recovery;
  a request failure remains an error, and authorization denial keeps its own gate.
- **`error`** — a load or operation failed. Keep the failure actionable, preserve any
  usable stale content, and offer Retry when safe. Legacy `variant="error"` remains a
  compatibility alias for this semantic state.

The title names the outcome; the description says why content is absent and gives the
next safe action. `EmptyState` supplies the state-appropriate marker and accessible
group/status/alert semantics. Do not use a calm no-data state for a failed request, or
celebrate a clear queue unless the loaded evidence proves it.

## Queue and detail workspaces

A desktop list/detail split uses one hairline, focusable separator rather than two
unrelated cards. Pointer resizing and keyboard resizing are the same operation: Arrow
keys make a documented small step, Shift+Arrow a larger step, Home/End reach the safe
bounds, and double-click resets. Clamp both panes to usable minimums, persist only a
presentation preference locally, and remove the handle below the desktop breakpoint;
compact layouts use an explicit back-to-list path.

A routed split workspace may reclaim the shared shell gutter down to a consistent
16px operational inset, but it remains framed rather than touching the navigation or
viewport edge. Inside the detail pane, header, tabs, and every tab panel share one
responsive 16–24px content rail. Do not stack page, pane, and panel padding into
separate 32px gutters; the resizable detail pane must spend its width on evidence.

Row selection is independent of row navigation. “Select visible” means the filtered
rows in the loaded client window and never implies every server match. Mixed bulk
operations expose progress and per-record partial failures; successful records leave
the selection while failures remain retryable. Permission hiding in the Console is
guidance—the API must recheck every action.

Campaigns is analyst-first. The default **Campaign review** workspace owns the current
group list, detail, and read-only refresh; manual correlation and saved cadence belong
only in the permission-gated **Policy & schedule** workspace. Do not append the policy
editor below the analyst queue or expose mutation controls to read-only roles. Each
workspace keeps its own stable loading, error, and empty geometry, while campaign
grouping remains advisory and never becomes deterministic case-decision authority.

## Case investigation-input provenance

Case Manager may disclose the context and platform configuration recorded for one
investigation run, but it must never turn global feature availability into case
provenance. Project the **latest run only** and render applicable inputs conditionally:

- approved operator **memory consulted**;
- indexed **RAG knowledge retrieved**;
- **runbook references retrieved** through RAG, separate from playbooks;
- a **playbook actually injected and consulted**, never merely selected; and
- an immutable **platform threshold-tuning snapshot** for a correlation threshold or
  severity floor that this case traversed.

Call the last item threshold tuning, not model fine-tuning. The summary belongs in the
flat Overview evidence flow and links to detailed Investigation evidence; do not add a
nested feature-badge card. Hide a successful empty section, preserve a stable loading
geometry, and distinguish an unavailable projection from “no inputs.” All displayed
model, memory, retrieval, and operator-authored strings remain plain untrusted text.
Close the section with the authority boundary: these inputs may inform preprocessing
or the agent assessment, while deterministic case policy makes the final route.

## Conversation workspaces

Workspace Chat is a conversation workspace, not an empty dashboard. On desktop it
uses one quiet 264px history rail separated from the active thread by a hairline; below
the desktop breakpoint, the rail becomes a left Sheet opened by an explicit
**History** control. The list is searchable, newest-first, and grouped by recency. Its
rows show title, preview, age, and message count; the selected row exposes
`aria-current`, while rename and delete remain secondary row actions. Loading, empty,
partial-error, and no-match states occupy the rail rather than replacing the usable
active transcript. Desktop exposes one page-level **New chat** action; the mobile Sheet
may repeat it locally because the page action is no longer in view.

The Chat workspace owns one fluid `PageContainer`; a route wrapper must not place the
split conversation workspace inside a second fixed-width container.

Its height follows the available viewport below the shared shell header. Do not impose
a fixed `rem` minimum on the transcript/workbench: short desktop windows must keep the
single docked composer fully visible while the transcript becomes the scroll owner.

History truth is fail-closed. A storage/read failure is an explicit retryable error and
must never render the calm **No previous conversations** state. Revalidate the newest-
first summary list when the workspace mounts and when its browser tab regains focus so
another tab or device does not leave a stale rail indefinitely. Same-origin tabs may
announce mutations for faster refresh, but focus revalidation remains the correctness
fallback; keep the already-open transcript usable while that background refresh runs.

The transcript begins at the top of a readable 52–54rem measure and uses ordinary
speaker labels, neutral operator messages, and flat assistant responses. Keep exactly
one thread header, one `Agent ready|working` status, and one composer. The composer
remains docked at the bottom in empty, restoring, error, and populated states; it is
disabled while a saved thread restores or a turn is in flight. Source and model live in
the composer's settings and quiet footer, not in a second status band. The empty state
is compact and top-aligned, with no vertically centered marketing panel. Do not add an
assistant accent rail, a blue user-message wash, duplicate readiness/source/model
strips, or a second inline composer.

The answer is the primary object. Query, tools, knowledge, citations, reasoning, model,
and per-message cost belong in one collapsed **Evidence & execution** disclosure beneath
that answer instead of separate cards or debug bands. If a bounded saved snapshot omits
larger evidence structures, the disclosure must say that explicitly. New turns follow automatically
only while the analyst is already near the transcript bottom. If the analyst is reading
older evidence, preserve their position and reveal **Jump to latest** when new content
arrives; smooth scrolling must respect reduced-motion preference.

Execution provenance is per turn, not inferred from the conversation's latest selector.
Show the effective source and effective model that actually served the answer. When an
operator explicitly selects a source that is disabled, missing, non-queryable, or cannot
be built, fail that turn with a scoped recovery message; never run it against Primary and
then label the answer with the requested source. Primary is the fallback only when the
operator made no explicit source selection.

A new conversation is a truthful local draft until its first successful response is
saved and the backend confirms that the record is durable. Selecting an existing
conversation restores the server transcript and its source/model inside the still-mounted
workspace. Preserve the unsent composer draft independently for the new-chat draft and
for each visited saved thread; switching threads must not erase analyst input or write it
to server history. A restore failure leaves that frame
and its single disabled composer in place, with explicit **Retry** and **Start new chat**
recovery. Stale in-flight replies must not land in a newly selected thread, and thread
switching is disabled while the current turn is being committed. Case Manager chat is
a separate case-scoped entry point to the same engine and must never appear in personal
Workspace history. On narrow layouts, closing the History Sheet returns focus through
the Radix trigger path.

Every persisted Workspace turn carries one stable 8–128 character
`idempotency_key`. Retrying an ambiguous response reuses that identifier; the server
returns the previously committed turn or commits it once, never bills or appends a
duplicate exchange. Do not promote a draft into the saved rail until the verified-save
response arrives. If generation succeeds but persistence does not, retain the local
turn attempt with an explicit **not saved** state and one retry path rather than
claiming durability; do not put the failed attempt into hidden model history.

History remains intentionally bounded. The current contract retains at most 50
conversations per user and 100 messages per conversation. When an older conversation or
turn is removed, disclose the boundary in the rail/transcript; message counts describe
retained messages and must not imply that a clipped transcript is complete. Use the
server's `history_truncated`, total-count, and `oldest_retained_at` metadata rather than
inferring completeness in the client. Persisted history is partitioned by normalized
user identity so one operator's append does not rewrite every user's transcript.
Deployments upgrading from the legacy shared document must migrate it through the
compatibility path without requiring an operator reset.

## Navigation and information architecture

`src/soc/registry.tsx` is the only feature registry. It derives routes, the left rail,
and command-palette destinations. Add, rename, gate, hide, or deprecate a feature there;
do not hand-build a second nav list.

- Primary navigation contains distinct operator jobs, not alternate reports over the
  same objects. Legacy destinations may stay hidden and routable for bookmarks during a
  transition.
- The **Intelligence** group uses five direct, non-overlapping operator destinations:
  **Knowledge corpus** is indexed RAG material; **Reference runbooks** are retrievable
  investigation guidance; **Operator memory** is approved durable context;
  **Response playbooks** are deterministically selected procedures; and **Agent
  personas** are read-only specialist profiles. Each destination is a first-level
  child and stable deep link. Do not hide Personas behind a Playbooks tab or use the
  generic labels “Knowledge”, “Memory”, “Catalog”, or “Playbooks & agents” when the
  specific contract is known. The legacy `#/catalog` route remains a compatibility
  alias that opens **Response playbooks**.
- Intelligence catalogs are divider-led reference lists, not card galleries. Each
  persona or playbook row exposes identity, purpose, and the smallest useful evidence
  summary first; criteria, tools, coverage, and replay evidence disclose in place.
  Reserve a Sheet for a full source document or create/edit workflow so scanning the
  catalog never replaces the operator's route context.
- The collapsed rail remains a stable 64px dock until the operator explicitly expands
  it. Hovering or focusing a grouped icon reveals one compact, viewport-clamped
  destination flyout; it never widens the entire rail. Pointer travel across the gap is
  delay-safe, focus opens immediately, Escape restores the trigger, and childless
  destinations retain simple labels/tooltips. Explicit expansion uses the shared
  reduced-motion-aware transition.
- The global command palette uses progressive disclosure. Its blank state contains
  recent work, a few safe quick actions, and top-level destinations only. Deep child
  routes, individual Settings sections, cases, and sources appear after the operator
  types a query. Do not render the entire route and Settings registry before input: a
  launcher should offer one calm first decision, then reveal precision on demand.
  Because the palette has wide, compact, and keyboard openers outside its Dialog,
  remember the exact opener and restore focus to it on Escape, selection, or close.
- Product documentation is a bottom utility destination, separate from operational
  feature groups.
- The in-app **Documentation** destination opens the version-matched Help Center
  shipped with the application at `/docs/<major.minor>/`; it never substitutes a
  GitHub directory for product help. Generate that static site from the same Markdown
  and accepted source identity as the application instead of copying articles into
  React components or maintaining a second manual.
- Installed documentation is authoritative for the running build and does not carry
  a blanket freshness warning. Latest Stable, Development, “View source”, and “Edit
  this page” are secondary destinations with explicit version/channel context.
- Deep links remain stable. If a page is consolidated, add an explicit redirect or a
  hidden compatibility route and document the replacement.

## Motion and loading

Every lazy route renders the shared centered route fallback immediately. A blocking
page, panel, or empty-table load uses `LoadingState` from `@/design-system`: one named,
centered, reduced-motion-safe indeterminate progress ring over optional static geometry. Never show a blank
canvas, only the word “Loading”, a page-local spinner, or several competing shimmer
animations. Keep usable content mounted during refresh and use the existing
`LoadingBar`; do not add another animation dependency. Button-level progress remains
local to the button it disables.

Manual page and queue reloads use the shared `RefreshButton`. Keep its visible action
label and fixed icon slot mounted while the request runs; indicate progress with the
same reduced-motion-safe rotating refresh glyph, `aria-busy`, and a disabled control.
Do not swap the glyph for a differently sized spinner, rename the action to
“Refreshing…”, or allow a second click while the request is in flight: those variants
create toolbar movement and inconsistent feedback. Initial blocking loads and
background data refreshes still follow the `LoadingState` / `LoadingBar` contract above.

Motion explains state change: route entry, disclosure, row insertion/removal, or a
terminal live marker. It does not decorate static content. Honor
`prefers-reduced-motion`; no required information depends on animation. Only the newest
terminal timeline marker may pulse continuously. A successfully committed data refresh
may replay one short transform/opacity-only cue tied to the new payload; it must never
run on its own timer or imply that a request is in flight when it is not.

## Detection-rule authoring honesty

The normal Detection & Rules editor exposes only capabilities that survive Save and
affect the current runtime. A detection-match rule authors exactly one predicate plus
its active correlation threshold: group-by, event count, and time window. Do not add an
**Add condition** affordance, nested AND/OR builder, MITRE metadata input, per-rule
suppression editor, or per-rule cadence input until that capability is persisted,
validated, executed, previewed, and explained end to end.

The Schedule tab remains useful as a read-only explanation: detection cadence is owned
by the source feed and its durable cursor; case-automation rules run after a case
decision. Direct or legacy API clients may already have additive `mitre`, `schedule`,
or `suppression` metadata. Keep those values in the form adapter solely for invisible,
lossless compatibility round-trip so editing a name or threshold cannot erase them;
never badge them as active or let hidden metadata influence deterministic case
authority. Rule preview sends the same single authoritative predicate that Save emits.

## Operational metric and tuning surfaces

Operational summaries use one continuous strip rather than a row of independent
cards. The strip owns its outer hairlines; each metric supplies only the responsive
internal divider needed for the current column count. At the one-, two-, and four-
column breakpoints, no cell may acquire both a left and top divider or lose the line
that separates it from the preceding row. Use the compact `KpiTile` density when the
strip is supporting a workflow rather than serving as the page's primary dashboard.

Observed-outcome metrics embedded in another operational page use the integrated
`ComparisonMetric` variant. Keep the shared reporting window, evidence state, and
safety guardrails in one summary band; do not repeat them in every metric cell. An
unavailable metric says why it is unavailable and never renders a synthetic zero.
Definitions remain available from the metric's keyboard-accessible **How** control.

Auto-tuning uses three task-focused Radix tabs: **Operations** (default), **Outcomes**
(`metrics:view`), and **Policy & history**. Do not place all three workflows in one
continuous page. Operations owns authority, rule state, recommendations, approval
routing, and selected-rule detail in one review surface. Outcomes owns the reporting
window, comparisons, daily evidence, and quality controls. Policy & history owns the
append-only ledger and editable tuner policy.

Operations begins with one compact authority/status band and one continuous three-cell
state strip. The cells form one mutually exclusive distribution rather than four
unrelated KPIs; the monitored total belongs in nearby supporting copy. Rule state
vocabulary is fixed: **Collecting** below `min_samples`,
**Within target** when sufficiently sampled and at or below policy, and **Needs
attention** when sufficiently sampled and above policy. Never label under-sampled
evidence healthy.

Recommendations and monitored evidence share exactly one attention-ordered
**Rule review** workspace. Do not introduce a second review queue, recommendation
card stack, or duplicate rule action. Recommendation-only rows remain visible in the
same workspace. Recommendations are grouped by rule and expose exactly one mutation
affordance per rule. The visual and reading order is **Why it needs attention → Recommended action →
Expected operational effect → Safety replay**. Processing one rule may apply multiple
eligible bounded changes and queue restricted changes; same-rule actions lock together
while unrelated rules remain usable. Never label a recommendation merely **Safe**:
use **Can apply after safety check**, because the evidence and safeguards are recomputed
before the write and may still route the change to Approvals. A restricted-only rule
links to Approvals when the operator has access.

All monitored rules use a responsive diagnosis-first list rather than a wide
statistics-first table. Each row states the rule's evidence state and the bounded next
step before exposing supporting measurements. The observed false-positive ratio is
supporting context; the conservative Wilson lower-bound estimate is the policy gate,
and its distance from policy is stated in **percentage points**. The list provides
search and state filtering, truncates long identifiers without letter-wrapping, and
opens a labelled contextual inspector beside the list only at genuinely wide (1536px+)
layouts or in a focus-managed Sheet below that breakpoint. The inspector owns the
diagnosis, current recommendation, expected effect, replay result, supporting
measurements, optional technical context, and recent history. The page must not
introduce horizontal document overflow.

In **Policy & history**, policy controls precede audit history. Advanced statistical
controls may be collapsed, while the append-only ledger exposes rollback only for the
newest active reversible row per rule.

The Outcomes tab shows one daily trajectory at a time—analyst-reported agreement,
material correction rate, or review-turnaround p50—through a keyboard-operable
`SegmentedControl`. Ratios and elapsed minutes must never share one axis. Preserve
every nullable daily point as a visible gap, show how many current-window days are
measurable, and provide the same values in a visually hidden table. Label the series
as raw eligible daily cohorts: the comparison cells above are source × severity mix
adjusted, while the daily series are deliberately unadjusted. Applied tuning events
belong in a collapsed disclosure as chronological context only; never draw a causal
connector or attribute an outcome shift to a change without an explicit future
analysis contract.

Keep these workspaces flat and divider-led rather than nesting them in rounded cards.
Initial loading uses `LoadingState`; refresh keeps the last usable data mounted beneath
one `LoadingBar`, and a refresh error is reported without replacing that data.

## Operational flow visualizations

The Dashboard Noise Reduction instrument has two deliberately separate presentations.
**Simple** is the default direct-labelled, Carbon-informed full alert-to-case flow.
**Detailed** is the compatibility view of the Testing renderer: preserve its 640x220
stretched canvas, proportional processing spine, direct overlapping Cases outcome fan,
loss badges, excluded-count spur, reduction headline, and complete stage evidence rail.
Do not reinterpret Detailed through the Simple geometry. The selected mode carries into
full-screen inspection. Labelled counts, definitions, coverage, and truncation evidence
are authoritative:

- Preserve the familiar left-to-right lifecycle order and the current selected-window
  scope. Do not invent, relabel, or hide volume to make a branch look fuller.
- **Alerts ingested**, **After clustering**, and **Cases opened** change unit. In Simple,
  draw both transitions as real filled, tapered ribbons so the complete path is visible.
  Use the documented square-root display scale to keep later stages legible, disclose that
  compression beside the graph, and keep exact counts plus alert/cluster/case units in the
  labels. Never present those mixed-unit ribbons as mathematically conserved.
- In Simple, treat **Auto-cleared by AI**, optional **Closed by analyst policy**, and
  **Escalated** as the conserved split of opened cases. Split Escalated again into
  **Closed by human** and **Not analyst-closed**, with equal source/target thickness for
  every same-unit ribbon. Detailed intentionally retains Testing's direct Cases-to-outcome
  fan, including the overlapping human-closure view; its aligned evidence rail is the
  authoritative arithmetic.
- Every Simple stage label carries its exact count **and** a percentage; the count stays
  primary and the share is rendered quietly beside it. Simple uses exactly one share rule:
  each stage's share of the stage it came from—clusters of alerts ingested, cases of
  clusters, the conserved case split of cases opened, and human closure of escalated
  cases. That one rule governs **every surface Simple can render**. The flow band and the
  narrow-width evidence rail are alternative presentations of the same flow and are never
  on screen together, so the rail repeats the graph's parent-relative shares—including the
  em-dash baseline—rather than Detailed's funnel-top arithmetic. That denominator must be
  named wherever the share is announced (the accessible label and the hover card name it
  in words; a disclosure beside the graph states the rule for sighted readers), because
  two shares with different bases must never invite comparison. The first stage is the
  baseline and shows an em dash rather than a self-referential 100%. A zero, absent, or
  unmeasured denominator also renders an em dash and says why—never a fabricated 0%, and
  never a share carried over from another base. Detailed keeps its own published
  funnel-top ("of ingested") arithmetic in the evidence rail; do not restate Simple's rule
  there or Detailed's rule in Simple.
- A disclosure must describe the surface that is actually rendered at the reader's width.
  Gate a sentence about ribbons and display compression to the same container condition as
  the flow band, drop it when conservation fails and only the rail renders, and give the
  rail its own sentence whenever the rail is what shows. Copy that states one rule while
  the visible percentages follow another is a defect, not a wording preference; keep any
  always-rendered clause true on every surface it can be read against.
- **Open cases** is current lifecycle state from the selected-window posture count. It is
  not equal to Escalated minus human closure, so keep it outside the conserved graph as a
  labelled, keyboard-operable queue action. If the bounded scan is truncated, display the
  count as a lower bound and retain the complete-active-case drill-through.
- When the backend emits an **Awaiting review / Candidate** cohort, keep it distinct
  from the mandatory lifecycle; it is not a parent of Cases opened. Simple names it as
  side evidence, while Detailed retains Testing's side-cohort branch.
- Keep Simple's direct labels and Detailed's evidence rail readable in both themes. Stage
  detail must be available to keyboard and pointer users, not hover-only. At narrow widths,
  use the evidence rail rather than crushing either desktop graph's labels—and carry that
  view's share rule and disclosure into the rail with it.
- Outcome activation opens the matching selected-window Cases filter. Earlier stages
  open the selected-window Cases context because raw alert and cluster records are not
  exposed through the case list.
- Counter coverage, the bounded case-store page, the bounded lineage sample, and any
  truncation remain visible. A chart must never imply that partial evidence is complete.
- In Simple only, a successful payload may replay one short left-to-right matte sweep
  clipped to its ribbons. Key it to `generated_at`, remove it under reduced motion, and
  use no gradient, blur, glow, autonomous five-second loop, or additional animation
  dependency. Detailed retains Testing's static presentation.

The implementation layers, public design-system exports, source-asset rules, and
machine-readable catalog contract are documented in the
[Console design system](design-system.md).

## Evidence-led analytics

Analytics surfaces distinguish measurements, evidence quality, and policy. Use the
shared `ComparisonMetric`/definition disclosure for a current value, comparable
baseline, direction, sample, and formula. A measured value may remain visible beside
an **Insufficient** state, but missing evidence renders as an em dash—never zero.
Loading, unavailable, collecting, insufficient, and not-applicable are different
operator states and must not be collapsed into one neutral card.

Agent Effectiveness is aggregate-only and deliberately has no composite score.
Analyst agreement and correction share one graded-case quality domain; human review
turnaround is the independent second domain. A favorable headline requires both
domains plus evaluable, unbreached safety guardrails. Always expose the two complete
UTC windows, sample counts, comparable source×severity coverage, exclusions,
suppressed strata, and truncation. Do not show raw case/source identifiers or imply
causal model learning from an observed period-over-period change.

Cost execution tiers report what the ledger recorded, not what Settings requested.
Keep the fixed Standard/Flex/Batch/Unconfirmed buckets visible even when zero, include
Unconfirmed in coverage denominators, and never label a Standard row as a Flex
fallback unless a future ledger contract explicitly records that provenance.

## Theme and appearance

System, Light, and Dark are the three supported modes. Signed-in appearance entry points
use `PrefsProvider.setThemeMode`; the pre-auth Login delegates directly to the same
underlying `ThemeProvider.setTheme` persistence path because user preferences are not
available yet. First paint, the persisted choice, and every visible selection must
agree. Test every changed surface in both themes; hard-coded light-only dropdowns,
popovers, tooltips, and native-looking menu surfaces are defects.

The semantic SOC palette is system-owned. Severity, status, verdict, and risk fills
must remain coupled to their measured on-fill foreground and standalone-text tokens;
Branding cannot override only one member of that axis. Legacy semantic keys are ignored
compatibly. Small copy on a 10% semantic wash uses the corresponding `*-text` token,
while the base token remains available for icons, borders, charts, and sufficiently
large non-text marks. The contrast gate must test those text tokens on the actual
card-plus-wash composition in both themes, not merely against pure white or black.

Organisation accent overrides are theme-independent fills. Always derive the higher-
contrast black/white `--primary-foreground` from the effective accent and apply that
same pair in Light and Dark. Reapplying or discarding Branding clears the complete
writable inline-token set first so an older override cannot leak into the next preview.
Persist display-font choices as their stable allow-listed key; expand the key to the
self-hosted stack only when writing CSS. Normalise legacy hex primary/ring/secondary
accent tokens to the HSL triplets expected by `hsl(var(--token))` consumers.

## Release identity and supervised updates

The version badge remains the always-visible release identity. For a built-in
super-administrator with the dedicated update permission, place one compact update
control immediately beside it only when the backend reports a newer Stable candidate
and a supported supervisor capability. Do not replace the badge, add a persistent
banner, infer installability from SemVer alone, or expose a Testing observation as an
installable release.

Below the desktop breakpoint, the top bar still shows that release badge and any
candidate, active, or failed update action directly. Group secondary utilities
(notifications, appearance, health detail, account links, source-only observations,
and non-actionable update setup or receipts) in one labelled, non-menu Sheet. The
Sheet must use normal buttons and sections rather than ARIA menu roles, provide 44px
touch targets, close on Escape, and return focus to its trigger. Do not let shell
chrome create document-wide horizontal scrolling at 320px, 390px, or 600px.

The control must begin with server-bound preflight, then open the shared confirmation
dialog with the exact target, components, backup, rollback guarantee, warnings, and
blocking checks. A known unsaved draft withholds Start and directs the operator to
save or discard it. Cancellation returns focus to its trigger. Announce availability
once through a polite live region, never by repeated toast.

After confirmation, show one durable global progress surface with named stages,
bounded progress, the expected reconnect, automatic rollback state, actionable error,
and receipt. Reloading or navigating back must resume the host-side active job; the
browser must never pretend a disconnected request failed if the supervisor may still
be working. Cancel is offered only before switching starts. Manual rollback is offered
only when the supervisor reports a retained rollbackable snapshot.

Following a successful job, activation repeats the no-store release manifest,
backend identity/readiness, and entry-document checks before preserving the hash route
across a full-page navigation. If automatic activation cannot finish, keep an explicit
**Open updated Console** fallback visible. Background discovery failures stay quiet;
explicit failures use one actionable error surface and leave the current document
interactive. Never expose browser-editable image names, release URLs, commands, host
paths, registry/deployment credentials, migration instructions, or Compose fragments.

## Identity surfaces

The sign-in experience is intentionally minimal. Use one vertically and horizontally
centred, borderless 480px by 492px identity slab for the normal desktop sign-in state
on the isolated identity canvas, with a 384px content measure: one standalone 56px
mark, the current auth-mode heading, one short
description, credential controls, one primary action, and quiet support or operator-
configured footer text. The hierarchy remains left-aligned inside the centred slab. A
configured sign-in headline replaces the default heading; it never stacks above a
second `h1`. Do not add a synthetic audit-status claim: auditing is a platform
invariant, not useful sign-in instructions. The form is the page. Do not add a marketing
hero, split context pane, assurance rail, trust-path diagram, decorative illustration,
fake telemetry, or repeated security claims. Exactly two controls carry a gradient and
a glow — the primary CTA and the corner appearance pill, both described under
*Identity accents* below. Nothing else on this canvas may, and nothing in the Console
may at all.

The slab has no radius, border, or elevation. It uses 48px top/side and 96px bottom
desktop insets. Its fixed, login-scoped palette is intentionally independent of Console
branding tokens: Light canvas/slab/muted tile are `#fbfbf8` / `#fff` / `#f5f4ef`;
Dark uses `#1a1a1e` / `#101013` / `#27272b`. Four explicit 0.5px viewport guides
align to the slab edges. The ambient layer follows the live Mistral sign-in choreography:
exactly four neutral 240px tiles reveal sparsely, dwell, move on a 1,800ms ease-in-out
transition, then fade away before scheduling their next randomized cycle. Top and bottom
use two horizontal endpoints; left and right use a two-column by two-row outer lattice and
choose a next cell sharing the current row or column. Only the top and bottom tiles may
emit an occasional warm directional trail (`gold`, amber, orange, vermilion, or red), one
tile behind the current move. Side tiles never emit colour. The trail belongs to the same
movement lifecycle and retracts when that movement settles; there are no detached colour
anchors or independently timed stationary blocks. The light/dark neutral tile, canvas,
and guide tokens remain the dominant visual treatment, so the background reads as a quiet
grid with rare colour rather than a perpetual saturated animation. Do not replace this
backdrop with a gradient, glow, blurred blob, perpetual CSS drift, or tile border; the
*Identity accents* exception below covers controls, never this ambient layer. The decoration
is pointer-inert, `aria-hidden`, reduced-motion-safe, layered below the opaque slab, and
never crosses behind credential content. Light/Dark changes snap the neutral tile palette
atomically while preserving the active movement; never interpolate white tiles through a
large grey flash during a theme switch. Below the small breakpoint, all
guides and ambient tiles disappear and the
surface becomes a full-width, full-height flow with 32px side/top and 80px bottom insets.
A small pre-auth appearance control may sit in the viewport corner: the Light/Dark
pill plus a round *Use system theme* reset that is pressed while `system` is active.
System, Light, and Dark all remain reachable — the pill reflects and sets the RESOLVED
appearance, and choosing either explicitly releases `system`. It delegates to
`ThemeProvider.setTheme`, while authenticated surfaces continue through the preference
layer. Sign-in, setup, MFA, MFA enrollment, and forced password change
share the same centred slab; taller modes grow naturally and the slab scrolls within the
viewport so software keyboards never trap the primary action. The form owns the page's
single `h1`.
Credential entry is identity-first: the initial surface contains only the username field;
once it has a non-empty value, **Continue** appears and advances to the password step.
The password step repeats the selected identity as quiet context and provides an explicit
way back without discarding it. Credential inputs are 48px and primary/SSO actions are
40px or taller. Inputs use a 16px mobile font and 14px desktop font to avoid browser
focus zoom while keeping the reference's editorial density, password-manager
autocomplete, and paste available. Seeded demo credentials label username and password
explicitly beneath the primary credential form; their optional `Use` action fills the
form, advances to the password step, and never submits it. When configured, icon-led,
accessibly named SSO actions follow the identity step in one equal-width row; no empty
divider or provider region is reserved when SSO is absent.
External support links say they open a new tab, and the blocking first-paint gate uses
the shared `LoadingState`.

Legacy `split`, `centered`, and `full` branding values remain readable and round-trip for
configuration compatibility, but all render the same minimal shell. Bounded operator
wordmark, logo, subtitle, optional short welcome copy, footer notes, and support URL may
remain; they must stay plain text and must not rebuild a second content pane. The Branding
editor preview mirrors this exact minimal geometry and tokens.

### Identity accents

The identity canvas — and only the identity canvas — carries two expressive controls:
`ShineButton`, the primary CTA, and `ThemeModePill`, the corner appearance switch. Both
live in `webui/src/soc/components/auth/`, both are styled entirely by
`.login-auth-canvas`-scoped CSS in `theme.css`, and both animate with CSS transitions
and one keyframe — no animation library, and neither sits on a lazy chunk. They are a
deliberate exception to the surface grammar above, not a licence to reintroduce
decoration elsewhere: no Console page may adopt either, and the ambient backdrop stays
neutral.

The exception holds only while these rules do:

- **Colour is measured, never eyeballed.** These are the only surfaces that paint text
  on a raw gradient rather than a semantic token pair, so the token contrast gate cannot
  see them. `webui/scripts/gate-login-accents.mjs` re-derives the worst case from
  `theme.css` on every `npm run gates` and every Vitest run, compositing each face stop
  with the sweep at its peak keyframe opacity and the overlay tint at its declared
  per-theme opacity, and measuring against both label stops. Every composite clears
  4.5:1. The reference palettes these are modelled on do not; that is why the ramps here
  are deeper.
- **Decoration never reaches the measured surface.** The CTA's halo renders outside an
  opaque face; the pill's flair orbs render behind an opaque track. Both controls paint
  no background of their own so their glow layers can sit beneath the opaque child.
- **The pill's glyphs own fixed side cells.** The label can never drift over the bright
  end of either ramp, which is what makes the measured label zone true. Ink and track
  swap instantly between states — the two ramps are not interpolable, so a crossfade
  would pair each ink with the wrong ramp mid-transition.
- **Every fallback is explicit.** The sweep is gated behind
  `prefers-reduced-motion: no-preference`; blurred layers are dropped under
  `prefers-reduced-transparency: reduce`; and under `forced-colors: active` both
  controls return to the system palette AND the gradient-clipped label is un-clipped,
  without which it would stay transparent over a system-painted face and vanish.
- **The CTA's accessible name is its label alone.** The sweep is `aria-hidden`, the halo
  is a pseudo-element, and any icon renders outside the clipped label span (text-fill
  transparency is inherited, so an icon nested inside it would disappear).

## Forms, Settings, and dangerous actions

Settings is one responsive configuration workspace, not a collection of unrelated
admin cards:

- On desktop, use one searchable, registry-derived, grouped section rail beside the
  active editor. Below the desktop breakpoint, replace that long rail with one compact
  contextual trigger and a searchable Sheet chooser; do not stack the full inventory
  above the form.
- The active renderer owns exactly one visible `h2` and its description. The workspace
  may show a compact group/section context line and truthful dirty status, but it must
  not repeat the section title as a second heading.
- Related controls sit in flat, divider-led `SettingsCard` bands. Fields, switches,
  posture summaries, and status text use aligned field/status lanes inside the band;
  do not wrap the section, each toggle, or each summary in another decorative card.
- Dirty state is visible globally and per section. Save and Discard live in one sticky,
  opaque hairline action bar; never introduce a second section-local preference save
  path.
- A dirty preference or write-only-secret draft must not disappear silently. Protect
  reload/tab close and pause Console-driven cross-page navigation before changing
  React state or the hash; use the shared accessible confirmation dialog rather than
  `window.confirm`. Section and anchor jumps inside Settings preserve the same draft
  and do not prompt.

The responsive shell is presentation only. Preserve `#/settings?s=<id>&a=<anchor>`
deep links, registry/RBAC visibility, schema and API fields, write-only secret drafts,
and partial-update/dirty semantics when changing it. Search may expose matching
in-section anchors, but it must not reveal a section the current role cannot access.

Secrets remain write-only. Destructive or externally consequential actions require a
clear label, scoped confirmation, permission gate, and audited backend operation. Never
place deterministic case decisions behind an LLM-generated button.

## Guided setup workflows

The first-run setup workspace is the reference pattern for a short, stateful guided
workflow. It uses one wide, height-bounded shell rather than a marketing card: a
compact product header, a desktop progress rail, a compact progress strip below the
desktop breakpoint, one scrollable content region, and one sticky footer aligned to
the content column. Long manifest-driven editors consume the available width and
scroll inside that frame.

- Keep the sequence short and job-named. The current setup contract is **Workspace →
  Data sources → AI runtime → Review & launch**.
- Focus the new stage heading after every transition, expose `aria-current="step"`,
  announce progress, provide a skip link, and keep exactly one `h1` in the active
  stage.
- Derive progress status from actual readiness, not from which stages were visited.
  A review must distinguish **Ready**, **Needs attention**, and **Optional** and may
  allow a deliberately limited launch when it says what is unavailable.
- Route Back, Continue, progress links, Close, and Launch through one guarded
  transition. Save write-only credential drafts before leaving their stage; keep the
  operator in place on failure. Confirm before abandoning an open editor draft.
- A first-run terminal action names the product outcome (**Launch Agentic SOC**).
  The same flow used as a Settings re-run uses **Apply changes** and offers Close;
  it does not imply a destructive reset.
- Fail closed when authoritative setup state is unknown. Show a shaped error with
  Retry instead of rendering an operational surface on an assumed default.
- Present the default automation posture as an explanation, not a ceremonial switch.
  Detailed tuning belongs in Settings, and deterministic close/escalate authority is
  never altered by setup copy or controls.

## Accessibility and verification

- Keyboard focus is always visible; use the shared focus ring.
- Icon-only controls have an accessible name and a target of at least 24×24 CSS pixels.
- Radix primitives provide menu, dialog, radio, tabs, tooltip, and focus behavior.
- Render source/log/user text as plain text. Truncation has an accessible full-value
  path (hover/focus detail, title, or expanded view).
- An operationally load-bearing caveat—a filter that never ran, a volatile buffer, a
  result that is not what the controls asked for—is visible text or an accessible string.
  A `title` on a non-focusable element is a mouse-only affordance and never the sole
  carrier of such a caveat.
- Maintain WCAG AA token contrast in both themes and never disable paste. A measured
  `*-text` token has no headroom left: do not dim it with an `opacity-*` modifier on the
  wash it was tuned for—use the token as rendered, or pick a different token.

Before handoff, run typecheck, lint, design gates, focused tests, the complete Console
suite, and the production build. Use the in-app browser to inspect both themes, a narrow
viewport, hover/focus behavior, lazy-route loading, and console errors. Update this
standard when a deliberate shared pattern changes; do not let implementation and the
document drift. Stable promotion additionally requires the complete
[release-candidate browser acceptance matrix](testing.md#release-candidate-browser-acceptance)
against the exact built candidate.
