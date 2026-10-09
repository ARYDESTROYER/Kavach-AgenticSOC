---
title: "Runbook: noPac / sAMAccountName Spoofing Investigation"
type: "runbook"
category: "security_operations"
status: "active"
platform: "active_directory"
siem: "any"
schema: "ocsf"
access: "read_only"
attack_technique: "noPac / sAMAccountName Spoofing (CVE-2021-42278 & CVE-2021-42287)"
mitre:
  - "T1558 (Steal or Forge Kerberos Tickets)"
  - "T1078.002 (Valid Accounts: Domain Accounts)"
  - "T1068 (Exploitation for Privilege Escalation)"
rules:
  - nopac_samaccount_spoofing
tags:
  - nopac
  - samaccount_spoofing
  - active_directory
  - privilege_escalation
  - kerberos
  - CVE-2021-42278
  - CVE-2021-42287
  - 4741
  - 4742
  - 4781
summary: "A regular user creates a machine account and renames it to impersonate a Domain Controller, then requests a ticket as the DC."
---

# Runbook: noPac / sAMAccountName Spoofing Investigation

## Purpose

Decide whether a burst of account-management events on a Domain Controller is **noPac**
(CVE-2021-42278 + CVE-2021-42287) — a privilege-escalation chain that ends in full
domain compromise.

**Reason over the SEQUENCE, not any single event.** Every individual event here is
legitimate on its own — users *can* create machine accounts, accounts *can* be renamed,
tickets *are* requested constantly. It is a *true positive* only because of the **order**
in which they happen and **who** does them. A verdict from one event in isolation will be
wrong.

## Operating Constraint — No Tool Calls

**You have no SIEM query, no live directory lookup, no threat-intel tool.** Every fact
must come from the events attached to this case.

- A fact you cannot read from the attached events is **UNRESOLVED** — never guessed.
- You cannot confirm current group memberships, MachineAccountQuota, or whether a name
  legitimately belongs to a DC. Reason from the sequence you can see; name what you can't.
- Reporting an event, account, or name not present in the evidence is a Critical Failure.

## The Attack Chain — what to look for, in order

| Step | Event | What it looks like | Why it matters |
|---|---|---|---|
| 1 | **4741** | a **user** (`subject_user` not ending `$`) creates a **machine account** (`user` ends `$`) | MachineAccountQuota abuse — any authenticated user can add ~10 machine accounts (CVE-2021-42278 precursor) |
| 2 | **4722/4724** | same user enables it / sets its password | staging the new account |
| 3 | **4742 / 4781** | same user changes the machine account's **`sam_account_name` to a value that does NOT end in `$`** — typically matching a Domain Controller's name | **the spoof.** A machine account impersonating the DC by dropping its `$` |
| 4 | **4768** | a TGT is issued **for the spoofed name** | the ticket is granted as the DC (CVE-2021-42287) — game over |
| 5 | 4742/4781 (optional) | the name is changed back | cleanup to cover tracks |

**The decisive discriminator** is Step 3: a **computer account whose `sam_account_name`
was set to a name without a trailing `$`**, performed by a **non-machine (user)** account.
Legitimate machine accounts always end in `$`; dropping it to match a DC name is the
impersonation itself.

## Field Bindings

Read these from each attached event:

| Logical name | Meaning | Field |
|---|---|---|
| `event_code` | Windows Event ID | `event_code` |
| `actor` | who performed the action | `subject_user` (SubjectUserName) |
| `target_account` | the account being created/modified | `user` (TargetUserName) |
| `new_name` | the sAMAccountName it was set to | `sam_account_name` |

**The actor is `subject_user`, NOT `user`.** On account-management events `user` is the
*target* (the machine account); the *actor* (the attacker) is `subject_user`. Attributing
the action to the target machine account is a Critical Failure.

## Workflow

> **Reason first:** state what benign explanation would fit this exact sequence. If none
> fits both the actor and the order, say so.

1. **Find the machine-account creation (4741).** Capture `CREATOR` (`subject_user`) and the
   `CREATED_ACCOUNT` (`user`). Is the creator a **user** (no `$`) or a **machine/DC** (`$`)?
   A user creating a machine account is the chain's opening move.

2. **Find the rename (4742/4781) — state it as `FROM → TO`.** This is the crux, and your
   report must name it explicitly. Capture the **original** name (the `sam_account_name` at
   creation, or `old_name` on the 4781) and the **new** name (`new_name` / `sam_account_name`
   after the change), e.g. `WKS7$ → DC1`. **Does the new name end in `$`?** A
   machine account renamed to a value **without** a `$` — especially one matching a Domain
   Controller's hostname — is the impersonation. Do not report a vague "machine account
   manipulation"; report the exact rename and why it drops the `$`.

3. **Find the ticket request (4768) for the spoofed name.** If a TGT was issued for
   `NEW_NAME`, the impersonation succeeded and a ticket was obtained as the DC.

4. **Assemble the sequence.** Confirm the same `actor` performed steps 1–3 (or 1–2) within a
   short window on the same host. The chain — *user creates machine account → renames it to
   drop the `$` → gets a ticket as that name* — is noPac.

5. **Consider benign explanations.** Legitimate machine-account lifecycle is done by
   **Domain Controllers (`$` accounts)** or by admins through provisioning tooling, and does
   **not** rename a machine account to drop its `$`. If the actor is a `$`/DC account, or no
   `$`-dropping rename occurred, this is likely routine.

## Verdict Precedence Rules

**Evaluate in order; the first match wins.** Emit the **system verdict** — one of exactly
`TRUE_POSITIVE`, `FALSE_POSITIVE`, `NEEDS_HUMAN` — as your `verdict`.

| # | Condition | **Verdict** | Severity note |
|---|---|---|---|
| 1 | A **user** (`subject_user` not `$`) created a machine account **and** renamed its `sam_account_name` to a value **not ending in `$`** (Steps 1 + 3) | **`TRUE_POSITIVE`** | Critical — noPac spoofing; name the actor and the spoofed name |
| 2 | Rule 1 **and** a 4768 TGT was issued for the spoofed name (Steps 1 + 3 + 4) | **`TRUE_POSITIVE`** | Critical — full chain; domain compromise likely |
| 3 | A **user** created a machine account (4741) but **no `$`-dropping rename** is present | **`NEEDS_HUMAN`** | Suspicious MachineAccountQuota use; escalate to check whether it's abused |
| 4 | The actor is a **`$` / Domain Controller** account, only normal machine lifecycle | **`FALSE_POSITIVE`** | Routine machine-account management |

Rule 3 is `NEEDS_HUMAN`, not `TRUE_POSITIVE`: a lone machine-account creation by a user is
unusual but not proof of noPac without the rename — escalate rather than over-claim.

## Required Output

| Output | Content |
|---|---|
| **Verdict** | The precedence rule number that matched, with the sequence that supports it |
| **The chain** | The ordered events you found (creation → rename → ticket), with event IDs and timestamps |
| **Actor** | `subject_user` — the account that performed the actions (NOT the target machine account) |
| **The rename** | The machine account's name change as `original → new` (e.g. `WKS7$ → DC1`), and that the new name drops the `$` / matches a DC — the smoking gun. Lead your write-up with this |
| **Visibility statement** | What you could not confirm (DC inventory, MachineAccountQuota, group membership) |
| **Containment recommendation** | Recommendations only, never executed |

Produce structured output only. Facts only, no internal monologue.

## Critical Failures (Automatic)

- **Not stating the rename explicitly as `original → new`** (e.g. `WKS7$ → DC1`).
  The `old_name`/`new_name` on the 4781 event, and `sam_account_name` across 4741/4742, give
  you both ends — name them. A vague "renamed a machine account" is a failed report.
- Reaching a verdict from a **single event** instead of the sequence.
- Attributing the action to the **target machine account** (`user`) rather than the **actor** (`subject_user`).
- Reporting `FALSE_POSITIVE` when a user renamed a machine account to a **non-`$`** name matching a DC.
- Concluding benign because the events "succeeded" — noPac succeeds by design.
- Reporting an event, account, or name not present in the attached evidence.
