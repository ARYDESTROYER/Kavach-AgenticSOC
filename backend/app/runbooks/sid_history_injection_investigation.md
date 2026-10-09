---
title: "Runbook: SID History Injection Investigation"
type: "runbook"
category: "security_operations"
status: "active"
platform: "active_directory"
siem: "any"
schema: "ocsf"
access: "read_only"
attack_technique: "SID History Injection / T1134.005"
mitre:
  - "T1134.005 (Access Token Manipulation: SID-History Injection)"
  - "T1078.002 (Valid Accounts: Domain Accounts)"
rules:
  - sid_history_injection
tags:
  - sid_history
  - active_directory
  - privilege_escalation
  - persistence
  - 4765
  - 4766
summary: "A privileged SID is written into another account's sIDHistory, granting its access invisibly."
---

# Runbook: SID History Injection Investigation

## Purpose

Decide whether an Event **4765** ("SID History was added to an account") is a
**privilege-escalation backdoor** or legitimate domain-migration activity.

`sIDHistory` is a real AD feature: when an account moves between domains, its old SID is
retained so it keeps access to resources in the old domain. **Abused**, it grafts a
privileged SID onto an ordinary account — and that account gains everything the SID can
do **without ever appearing in the group's membership**. Auditing "who is in Domain
Admins" will never show them. That invisibility is the point of the technique.

**One event is the whole compromise.** There is no volume, no failure, and no second
stage to wait for. A verdict that needs a burst will never fire here.

## Operating Constraint — No Tool Calls

**You have no SIEM, no directory lookup, and no threat-intel tool in this deployment.**
Every fact you report must come from the events attached to this case.

- A fact you cannot read from the attached events is **UNRESOLVED** — never a value.
- You **cannot** confirm whether a domain migration was underway, check change tickets, or
  read the target account's current group membership. Say so; do not assume it.
- Reporting a SID, account, or event not present in the evidence is a Critical Failure.

## The Signal — Read the RID

The decisive value is the **injected SID** (`source_sid`), specifically its **last
component (the RID)**. A Windows SID looks like `S-1-5-21-<domain>-<RID>`; the domain part
varies per environment, but the RID is **well-known and identical everywhere**.

| RID | Principal | Meaning if injected |
|---|---|---|
| `512` | **Domain Admins** | Full domain control, invisibly |
| `519` | **Enterprise Admins** | Forest-wide control — the most severe |
| `518` | Schema Admins | Schema modification rights |
| `516` | Domain Controllers | Impersonates a DC; enables replication attacks |
| `544` | Administrators (builtin) | Local admin across the domain |
| `502` | krbtgt | Ticket-forging capability |
| `500` | Administrator | The built-in domain administrator account |

**Match on the RID (the final `-NNN`), never on the whole SID string** — the domain
portion differs in every environment, so an exact-string comparison will silently miss it.

Supporting fields:

| Field | Meaning |
|---|---|
| `event_code` `4765` | SID History **added** (`4766` = add **failed**) |
| `source_sid` / `source_user` | **the SID being injected — the privilege granted** |
| `user` / `target_sid` | the account **receiving** the privilege (the beneficiary) |
| `subject_user` | the account that **performed** the write (the actor) |
| `host` | the DC or server where the write landed |

## Workflow

> **Reason first:** State what would make this benign. If nothing in the attached events
> could, name the missing check rather than confirming by default.

1. **Confirm the event class.** Expect `event_code = 4765`. A `4766` is a *failed* add —
   still report it as an attempt, and note that failure does not make intent benign.

2. **Resolve the injected SID.** Read `source_sid`, take its final RID, and name it from
   the table. Capture `INJECTED_RID` and `INJECTED_PRINCIPAL`. Cross-check `source_user`,
   which often carries the readable group name.
   - A **privileged RID** (512/519/518/516/544/502/500) → escalation, decisive.
   - A **non-privileged RID** (≥ 1000, an ordinary user/group) → plausible migration; still
     unusual, so continue rather than closing.

3. **Identify the beneficiary and the actor.** Capture `user`/`target_sid` (who gained the
   privilege) and `subject_user` (who granted it). **Name both explicitly** — the
   beneficiary is the account to contain, and it is *not* the account that acted.

4. **Rule migration in or out.** The only innocent explanation is a genuine domain
   migration or a supported AD-migration tool run. Against it:
   - Migration injects a SID from a **different (source) domain**. If `source_sid` and
     `target_sid` share the **same domain component**, no migration occurred — someone
     granted intra-domain privilege, which migration never does. **This is your strongest
     discriminator, and it is computable from the two fields in front of you.**
   - Migration does not selectively target admin groups.
   - **You cannot confirm a migration window without a change record you do not have.** If
     the RID is privileged, an unverified "migration" claim never outweighs it.

## Verdict Precedence Rules

**Evaluate in order; the first match wins.**

| # | Condition | Verdict |
|---|---|---|
| 1 | `INJECTED_RID` is `519` or `516` | **Confirmed Critical — Forest/DC-level SID Injection.** Name the beneficiary; assume forest compromise |
| 2 | `INJECTED_RID` is `512`, `518`, `544`, `502` or `500` | **Confirmed Critical — Privileged SID History Injection.** The beneficiary is now effectively that principal |
| 3 | `source_sid` and `target_sid` share a domain, RID not privileged | **True Positive — Intra-domain SID Injection.** No migration grants a same-domain SID; escalate |
| 4 | Non-privileged cross-domain SID, migration unverifiable | **Suspicious — Insufficient Visibility.** Escalate and name the gap. **Never close a visibility gap as a false positive** |
| 5 | Cross-domain, non-privileged RID, and every check resolved benign | **False Positive.** Document the SIDs and the checks that resolved |

Rule 4 sits above rule 5 deliberately: "I could not verify the migration" is not "a
migration happened."

## Required Output

| Output | Content |
|---|---|
| **Verdict** | The precedence rule number that matched, with supporting evidence |
| **Injected privilege** | `source_sid`, its RID, and the principal it names |
| **Beneficiary** | The account and `target_sid` that gained the access — the containment target |
| **Actor** | `subject_user`, the account that performed the write |
| **Same-domain check** | Whether `source_sid` and `target_sid` share a domain component |
| **Visibility statement** | What you could not check: migration records, current group membership, the account's history |
| **Containment recommendation** | Recommendations only, never executed |

Produce structured output only. Facts only, no internal monologue.

## Critical Failures (Automatic)

- Closing as a false positive when a **privileged RID** (512/519/518/516/544/502/500) was injected.
- Concluding benign because the event count is low or nothing "failed" — one 4765 **is** the compromise.
- Accepting "domain migration" as an explanation **without** the cross-domain SID check.
- Naming the actor as the compromised account: the account to contain is the **beneficiary**.
- Comparing whole SID strings instead of the RID, then reporting no match.
- Reporting a SID or account not present in the attached events.
