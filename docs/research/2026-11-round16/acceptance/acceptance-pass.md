# Acceptance pass: record

After XFUI3 merged, an acceptance pass checked each operator ask of Round 16 from the
operator's point of view, not the implementer's, on the integrated tree. It changed no product
code. This record says, per ask, what the checker found delivered, the gaps it reported and
where each gap went. SPEC §8.6 summarises it, and §8.2 records what each fix package shipped.

## Setup

- **Tree.** `claude/round16` at `9343312` ("Journal: WP17C merged"), version `0.2.0`.
- **Checkers.** Eight, one per operator ask, each in its own worktree with its own seeded Demo
  (`DEMO_MODE=seeded`, signed in as `Admin`). Playwright Chromium at 1440 by 900 and 390 by
  844, light and dark (some also at 1024 and 768). Each reported whether its ask was delivered,
  every gap with its repro and the smallest fix, and the known limitations that undercut the
  ask. Items already in SPEC §8.3, or left for §7 on purpose, were not reported as gaps.
- **Skeptics.** The workflow then gave each gap to an independent skeptic told to refute it.
  One verdict ran (below). The orchestrator then stopped the workflow and sent the gaps to
  fix packages that confirmed each gap themselves before fixing it.
- **Screenshots.** In the build scratchpad (`round16/shots/accept-*`), not in the repository.

## Summary

| Ask | Delivered | Gaps | Medium | Low |
|---|---|---|---|---|
| AI investigating signals | partly | 8 | 2 | 6 |
| Case Manager | partly | 12 | 3 | 9 |
| Sign-in | partly | 13 | 4 | 9 |
| Explainable numbers | partly | 15 | 6 | 9 |
| Every record reachable | partly | 9 | 4 | 5 |
| What's new | partly | 4 | 2 | 2 |
| Regressions outside the Case Manager | partly | 5 | 2 | 3 |
| Accessibility and phone | not collected | | | |
| **Total** | | **66** | **23** | **43** |

No gap was high. Two gaps, one from the Case Manager checker and one from the records
checker, describe one defect: seeded Demo cases showed no AI steps in their trace.

The one skeptic verdict that ran: `decision-lane-raw-engine-record`, **confirmed**, medium. Its
corrected fix: change the Console only, keep `decide()`, the backend and the Demo seed as they
are, and have the decision line name who settled the case instead of saying the reason again.

## Where the gaps went

| Package | Gaps |
|---|---|
| FXB | 7 AI signal gaps |
| FXA1 | 8 Case Manager gaps, 2 records gaps and 1 AI signal gap |
| FXA2 | 4 Case Manager gaps and 7 records gaps |
| FXC | 13 sign-in gaps |
| FXD1 | 7 explainable-number gaps and 2 regressions |
| FXD2 | 8 explainable-number gaps |
| FXE | 3 regressions and 3 What's new gaps |
| WP17D | 1 What's new gap |

Each fix package confirmed every gap in the code and, for a Console gap, live in the seeded
Demo before fixing it, and gave each fix a regression test that failed before it. Each was
reviewed independently. No package judged a gap not real. FXF then took what the reviews left.

## AI investigating signals

Delivered: the header chip ticking "AI working · m:ss" from the `202`, the popover with its
five steps and who started the run, the queue mark, the Case Manager navigation count and its
hidden description, Reinvestigate unavailable during a run, the close warning that never
blocks, the run's result kept over a close made during it, the Inbox items and the
`case.close_replaced` audit row.

| Gap | Went to |
|---|---|
| The queue row's name kept "started 1 second ago" for the whole run | FXB |
| At 390 px the header chip was a bare ring, static under reduced motion | FXB |
| The close toast still offered Reopen after a run replaced the close | FXA1 |
| A run that replaced your close read as a plain success on the case page | FXB |
| A failed or cancelled run showed a green "AI finished" | FXB |
| The finish toast covered the close dialog's Close & next button | FXB |
| The close dialog's finished note was not a well-formed sentence | FXB |
| A screen reader heard the end of your own run twice | FXB |

## Case Manager

Delivered: frame 72, band 92, header 119 and first content 207 in all 192 states (4 cases, 4
widths, 2 themes and 6 tabs), Alt+1 to Alt+6, the `[` fold, the `]` inspector, the counted
empty pane and every key in the shortcuts sheet.

| Gap | Went to |
|---|---|
| The Decision lane printed the engine's raw rationale, then said it again in words | FXA1 |
| The People lane said no one had worked on a case with runbook steps done | FXA1 |
| On a phone, Activity and Chat sat past the edge of the tab strip | FXA1 |
| The Events table left the Message column 84 px wide at 1440 px | FXA1 |
| The trace listed and counted people opening the Evidence tab | FXA2 |
| The trace's step counts appeared twice | FXA2 |
| Trace rows named the runbook runner "Agentic soc" | FXA2 |
| On an open case the inspector's Outcome said the AI verdict twice | FXA1 |
| The Decision lane read "Analyst resolved" and wrapped to two lines | FXA1 |
| The Brief's AI lane read "AI AI" | FXA1 |
| The trigger sentence printed a severity range with equal ends | FXA1 |
| Seeded Demo cases showed no AI steps in the trace | FXA2 |

## Sign-in

Delivered: a Remember me row with no duration, motion that runs once and stops (nothing runs
3 s after the page settles, and nothing under reduced motion), every fixed error sentence,
contrast in both themes, no sideways scroll at 390 px and the organization default theme
button. Limitation named: the warning dialog still stated a duration, as D6 then allowed; the
D6 amendment removed it (FXC).

| Gap | Went to |
|---|---|
| The column jumped when a step changed or an error appeared | FXC |
| The required two-factor setup drew a focus box around its heading | FXC |
| The required setup did not use the sign-in grammar, and its secret was cut off | FXC |
| A wide organization logo shrank to a sliver | FXC |
| The forced password change could show the server's raw text | FXC |
| Alert icons sat 5 px below a one-line message | FXC |
| The Remember me box had a fainter focus ring than every other control | FXC |
| Single sign-on buttons showed the provider id when no name was set | FXC |
| Several phone targets were well under 44 px | FXC |
| The two-factor and forced-change buttons were disabled while empty | FXC |
| The text of Back and Use did not line up with the column's edge | FXC |
| The vertical rhythm changed between steps | FXC |
| The account menu said "Log out", in red | FXC |

## Explainable numbers

Delivered: the risk, severity, priority, SLA and confidence of ten cases recomputed by hand to
the cent, and the Overview, Executive summary, noise flow, Metrics and timing figures
reproduced exactly.

| Gap | Went to |
|---|---|
| No number on Standup had an explanation | FXD2 |
| Agent effectiveness changes could not be reproduced | FXD2 |
| The Noisiest rules FP rate was a Wilson bound with no explanation | FXD1 |
| The Detection board counted 57 cases in 7 days where the rest said 56 | FXD1 |
| Human vs AI shares had no explanation and a different base | FXD1 |
| Change chips gave no previous value and did not say they are relative | FXD1 |
| The Cost totals had no explanation | FXD1 |
| "Why was this investigated?" used today's settings without saying so and cut the score | FXD2 |
| The open-cases donut hover showed another number and no arithmetic | FXD1 |
| A percentile step's operands did not give its printed result | FXD2 |
| The Team activity median could not be recomputed | FXD2 |
| The SLA "due in" figure had no time-left step | FXD2 |
| Several board figures had no explanation | FXD1 |
| The time to detect step read "1 minutes" | FXD2 |
| The AI confidence had no source beyond "The case" | FXD2 |

## Every record reachable

Delivered: View all fields with all 67 Case fields, the Evidence events table and sheet, the
usage popover, trace Details with the recorded gate, history reasons, gradings, runbook steps,
files, tasks and the thread.

| Gap | Went to |
|---|---|
| Runbook AI help was shown and totalled as case chat | FXA2 |
| A confirmed AI step draft left no trace in the Console | FXA2 |
| A guessed or default price read "Catalog price" | FXA2 |
| Seeded Demo cases had no AI steps, and the trace cost contradicted the ledger | FXA2 |
| History showed automatic decisions without their reason | FXA1 |
| The decision step claimed a ledger row that does not exist | FXA2 |
| Long History notes were cut to three lines with only a hover title | FXA1 |
| Seeded notifications showed "Channel" instead of their type | FXA2 |
| The build that wrote each AI call was not shown | FXA2 |

## What's new

Delivered: the welcome once per update with the update count, the hero image in the theme,
the deferral on a deep link and the audited acknowledgement; the Communication tracker with 66
highlights, its filter, search and links; the Help Center page agreeing with the notes.

| Gap | Went to |
|---|---|
| An account seeded at startup was welcomed to an update it never ran | FXE |
| Most 0.2.0 changes on the tracker had no screenshot | WP17D |
| The `.env` line the release asks for was cut off at 390 px | FXE |
| The CHANGELOG named the page switch differently from the Console | FXE |

## Regressions outside the Case Manager

Delivered: all 59 routes and Settings sections swept at both widths with no crash, error toast
or unexpected failed call and no sideways scroll at 390 px, and every flow of the ask exercised
(Logs, rule sheets, Runbooks, Chat and Reports, Users and roles with RBAC on and off, Settings,
Jobs and the Audit log).

| Gap | Went to |
|---|---|
| Overview tiles showed the previous window's numbers under the new caption | FXD1 |
| Entity investigation found no events for addresses only push sources held | FXE |
| The Cases bulk bar was wider than the screen in Demo Mode | FXE |
| The SOC operations SLA panel said nothing breached beside a tile that counted 10 | FXD1 |
| Demo chat answered "closed by the AI agent" with every closed case | FXE |

## Accessibility and phone

The checker ran its axe sweep, but its report was not collected before the workflow was
stopped. The check was folded into the closing sweep, A11Y, which keeps its own receipt.

## Corrections the fix packages made

Every gap held up. Five packages corrected the checker's cause or fix:

- **FXE.** The push-source miss came from the default source, not the field mapping: with no
  source named, the route searched only the primary pull source.
- **FXC.** `outline-none` paints a box in forced colours, so the heading uses `[outline:none]`;
  the empty recovery-code field says "Enter a recovery code.".
- **FXA1.** A lane a person settled is named Decision, not Analyst, which would read "Analyst
  Analyst" beside its tag; the Events columns join at 44, 56 and 80rem.
- **FXD2.** The routing score keeps two decimals and is never rounded, because the gate
  compares it unrounded.
- **FXB.** The phone chip says "AI", not "AI working", which would not fit the phone strip.

What the packages left as limits is in SPEC §8.3 and the Help Center's known limitations.
