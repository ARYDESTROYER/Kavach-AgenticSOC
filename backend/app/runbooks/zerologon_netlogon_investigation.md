---
title: "Runbook: Zerologon (Netlogon Elevation) Investigation"
type: "runbook"
category: "security_operations"
status: "active"
platform: "active_directory"
siem: "any"
schema: "ocsf"
access: "read_only"
attack_technique: "Zerologon / CVE-2020-1472"
mitre:
  - "T1210 (Exploitation of Remote Services)"
  - "T1068 (Exploitation for Privilege Escalation)"
  - "T1078.002 (Valid Accounts: Domain Accounts)"
rules:
  - zerologon
tags:
  - zerologon
  - netlogon
  - active_directory
  - privilege_escalation
  - CVE-2020-1472
  - 4742
  - 5827
  - 5828
  - 5829
summary: "A Domain Controller's own machine-account password is reset by an unauthenticated caller via the Netlogon protocol."
---

# Runbook: Zerologon (Netlogon Elevation) Investigation

## Purpose

Decide whether an event is **Zerologon** (CVE-2020-1472) — an attacker exploiting a flaw
in the Netlogon authentication protocol to **reset a Domain Controller's own machine-account
password to empty, without any credentials**. Success means instant, full domain
compromise (the attacker can then impersonate the DC, e.g. DCSync every hash).

**The tell is not volume or a tool — it is an impossible actor.** A DC's machine-account
password is only ever changed by the DC itself, authenticated. If it is changed by an
**anonymous / unauthenticated** caller, that is the exploit, full stop.

## Operating Constraint — No Tool Calls

**You have no SIEM query, no live directory lookup, no threat-intel tool.** Every fact must
come from the events attached to this case.

- A fact you cannot read from the attached events is **UNRESOLVED** — never guessed.
- You cannot confirm patch level or query Netlogon state; reason from the events you can see.
- Reporting an event, account, or value not present in the evidence is a Critical Failure.

## The Signal

| Event | What it means | Why it matters |
|---|---|---|
| **4742** (computer account changed) with `subject_user` = **`ANONYMOUS LOGON`** (or empty `-`), target a **machine account** (`$`), password changed | A machine account's password was reset by an unauthenticated caller | **The exploit result.** No legitimate operation changes a computer account anonymously. If the target is a **Domain Controller's** own account, this is domain compromise |
| **5827 / 5828** (System / Netlogon) | A vulnerable Netlogon connection was **denied** | A **patched** DC blocking a Zerologon *attempt* |
| **5829** (System / Netlogon) | A vulnerable Netlogon connection was **allowed** | A patched DC in audit mode logging an *attempt* that was permitted |

**Field bindings:** `event_code` (Event ID) · `subject_user` (SubjectUserName — the actor) ·
`user` / `target_account` (TargetUserName — the account whose password changed) · `host`
(the DC where it happened).

## Workflow

> **Reason first:** what benign event could change a Domain Controller's machine-account
> password *anonymously*? If you cannot name one, the answer is that none exists.

1. **Confirm the anomaly.** For a `4742`, read `subject_user`. Is it **`ANONYMOUS LOGON`**
   (or empty `-`)? A computer-account change by an unauthenticated caller is **not possible
   legitimately** — this is the Zerologon signature.

2. **Identify the target.** Read `user` / `target_account`. Does it end in `$` (a machine
   account)? **Is it a Domain Controller's own account** (its name matches the `host`)? A DC
   resetting *its own* password anonymously is the worst case — full domain compromise.

3. **Note the Netlogon audit events** if present. `5827`/`5828` mean a patched DC **blocked**
   an attempt (still report the attempt); `5829` means one was **allowed**. Their presence
   corroborates a Zerologon attempt regardless of the 4742.

4. **Rule out the benign case.** The only "normal" machine-account password change is the
   account changing **its own** password *authenticated* (`subject_user` is that machine or a
   DC, never anonymous), on the routine ~30-day rotation. **Anonymous is never that.**

## Verdict Precedence Rules

**Evaluate in order; the first match wins.** Emit the **system verdict** — one of exactly
`TRUE_POSITIVE`, `FALSE_POSITIVE`, `NEEDS_HUMAN` — as your `verdict`.

| # | Condition | **Verdict** | Severity note |
|---|---|---|---|
| 1 | `4742` on a **Domain Controller's** machine account with `subject_user` = `ANONYMOUS LOGON` / empty | **`TRUE_POSITIVE`** | Critical — Zerologon; the DC password was reset anonymously; assume domain compromise. Name the DC |
| 2 | `4742` on **any** machine account with `subject_user` = `ANONYMOUS LOGON` / empty | **`TRUE_POSITIVE`** | Critical — anonymous computer-account password reset; Zerologon pattern |
| 3 | `5829` present (vulnerable Netlogon connection **allowed**), no 4742 seen | **`TRUE_POSITIVE`** | A Zerologon attempt was permitted; escalate |
| 4 | Only `5827`/`5828` present (attempts **denied** by a patched DC) | **`NEEDS_HUMAN`** | Attempts were blocked, but someone is trying — escalate to hunt the source |
| 5 | `4742` where `subject_user` is the machine's **own account / a DC** (authenticated), no anonymous caller | **`FALSE_POSITIVE`** | Routine machine-account password rotation |

Rule 4 is `NEEDS_HUMAN`: blocked attempts are not a compromise, but they are an active
adversary probing the DC — do not close as benign.

## Required Output

| Output | Content |
|---|---|
| **Verdict** | The precedence rule number that matched, with the evidence |
| **The anomaly** | State it plainly: *"machine account `<name>` password changed by `ANONYMOUS LOGON`"* |
| **Target DC** | The `host` / machine account whose password was reset, and whether it is a DC |
| **Netlogon audit** | Any 5827/5828/5829 seen, and whether attempts were allowed or denied |
| **Visibility statement** | What you could not confirm (patch level, the source of the connection) |
| **Containment recommendation** | Recommendations only, never executed |

Produce structured output only. Facts only, no internal monologue.

## Critical Failures (Automatic)

- Reporting `FALSE_POSITIVE` on a computer-account password change by `ANONYMOUS LOGON` — that
  is the exploit, not a rotation.
- Concluding benign because "only one event" occurred — Zerologon **is** one event.
- Failing to state the anomaly as *actor = anonymous* changing a *DC machine-account* password.
- Reporting an event, account, or subject not present in the attached evidence.
