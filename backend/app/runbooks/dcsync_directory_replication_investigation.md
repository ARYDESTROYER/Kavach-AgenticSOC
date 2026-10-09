---
title: "Runbook: DCSync / Directory Replication Investigation"
type: "runbook"
category: "security_operations"
status: "active"
platform: "active_directory"
siem: "any"
schema: "ocsf"
access: "read_only"
attack_technique: "DCSync / T1003.006"
mitre:
  - "T1003.006 (OS Credential Dumping: DCSync)"
  - "T1078.002 (Valid Accounts: Domain Accounts)"
rules:
  - dcsync_directory_replication
tags:
  - dcsync
  - active_directory
  - credential_access
  - replication
  - 4662
  - directory_service
summary: "A non-DC principal exercises directory-replication rights on a Domain Controller to pull secrets."
---

# Runbook: DCSync / Directory Replication Investigation

## Purpose

Decide whether an Event **4662** (directory-service object access) on a Domain
Controller is a **DCSync** attack — an account abusing AD replication rights to pull
password hashes for the domain — or legitimate replication traffic.

**This attack has no volume and no failure.** It can be **three log lines** with a
success outcome. The signal is not *how much* happened; it is **which right was
exercised, and by whom**. A verdict built on event count or status will always miss it.

## Tools & Constraints

You have **one relevant read-only tool: `decode_acl`.** You have no SIEM query, no live
directory lookup, and no threat-intel tool.

- **When an event carries an `attribute_value` that looks like SDDL** (it starts with
  `O:` or `D:` and is the `nTSecurityDescriptor`), you **must call `decode_acl`** on it,
  passing that event's **`id`** as `event_id`. The SDDL shown to you is **truncated** —
  do NOT parse it yourself and do NOT pass the visible (partial) string; pass the
  `event_id` and the tool reads the FULL descriptor server-side.
- **Reason over the DELTA, not the full ACL.** When the case captured the object before
  and after (paired 5136 delete-old/add-new), `decode_acl` returns **`added_privileges`**
  (what changed — the abuse) separately from **`existing_privileges`** (the legitimate
  baseline). **Base your verdict on `added_privileges`.** This is the false-positive
  guard: a Domain-Controller object *legitimately* holds replication rights for DCs and
  admins, so a replication grant that was **already present** is NOT the attack — only a
  **newly ADDED** one is. If `added_replication` is empty (rights only pre-existed), this
  is **not** an ACL-abuse DCSync from these events.
- Every other fact must come from the attached events. A value you cannot read (or decode)
  is **UNRESOLVED** — never guessed.
- You **cannot** confirm whether an actor is a real Domain Controller, list group
  memberships, or baseline history. Say so; do not assume it.
- Reporting an event, account, SID, GUID, or right not present in the evidence (or the
  decoded ACL) is a Critical Failure.

## The Two-Stage Shape — Grant (5136) then Use (4662)

DCSync via ACL abuse has two halves, and the ACL grant is the precursor:

1. **The grant — Event `5136`** on `nTSecurityDescriptor`: an attacker adds an ACE to the
   **domain object** giving a principal the replication rights. The `attribute_value` is
   the raw SDDL — **call `decode_acl` on it** and read **`added_privileges`**. DCSync via
   ACL abuse is confirmed when the ADDED privilege is a **replication right**
   (`DS-Replication-Get-Changes` / `Get-Changes-All`) granted to a **plain USER SID**
   (RID ≥ 1000). No user account should be *given* `Get-Changes-All`.
2. **The use — Event `4662`**: the granted principal then performs the replication read
   (see the 4662 guidance below).

Seeing the 5136 grant of a replication right to a user SID is sufficient on its own; the
paired 4662 confirms the rights were exercised.

**5136 is a family, not just DCSync.** Event 5136 fires for *any* directory-object change,
so classify by the ADDED privilege: a **replication right** → DCSync (this runbook); an
added **`Write-DACL` / `Write-Owner` / `Generic-All`** → object takeover; an added
privileged-group membership → group escalation. All three are read the same way — decode
the descriptor, look at what was **added**, name the right. If the added privilege is none
of these (a routine attribute or an ordinary read grant), it is likely benign — do not
force a DCSync verdict onto an unrelated 5136.

## The Signal — Replication Rights (read this first)

Event 4662 fires for a great deal of routine directory activity. What makes it DCSync is
the **control-access right requested**, carried as a GUID in the event's `properties`
field. Match the GUIDs you see against this table.

| Right GUID | Name | Meaning |
|---|---|---|
| `1131f6aa-9c07-11d1-f79f-00c04fc2dcd2` | DS-Replication-Get-Changes | Replicate directory changes |
| `1131f6ad-9c07-11d1-f79f-00c04fc2dcd2` | DS-Replication-Get-Changes-**All** | **Replicate SECRETS (password hashes).** The definitive DCSync right |
| `89e95b76-444d-4c62-991a-0facbeda640c` | DS-Replication-Get-Changes-In-Filtered-Set | Replicate a filtered attribute set |

**`1131f6ad` (Get-Changes-All) is the tell.** Only Domain Controllers legitimately
replicate domain secrets. The classic Mimikatz/`lsadump::dcsync` fingerprint is a request
for **both** `1131f6aa` and `1131f6ad` together.

Supporting fields:

| Field | DCSync value | Meaning |
|---|---|---|
| `event_code` | `4662` | Directory-service object access |
| `access_mask` | `0x100` | `ADS_RIGHT_DS_CONTROL_ACCESS` — an extended/control-access right |
| `properties` | contains a replication GUID above | the right actually exercised |
| `user` (SubjectUserName) | the actor | **the account that requested replication** |
| `host` | the DC | where the read landed |

## Workflow

> **Reason first:** State what would change your mind. If no attached field could make
> this benign, say which one is missing rather than confirming by default.

1. **Confirm the event class.** Every event should be `event_code = 4662` with
   `access_mask` including `0x100`. If not, this may be the wrong runbook — say so.

2. **Extract the replication right.** Read the GUID(s) from `properties` and name each
   against the table above. Capture `REPLICATION_RIGHTS_SEEN`.
   - **`1131f6ad` present → DCSync confirmed by right.** Secrets replication was requested.
   - Only `1131f6aa` present → replication of changes without the secrets right; still
     anomalous from a non-DC, treat as suspicious.
   - No replication GUID in `properties` → this is **not** DCSync. Re-triage.

3. **Identify the actor, and classify it into exactly one of three buckets.** Capture
   `user` (the `SubjectUserName`). The actor — not the host — decides this case.
   - **USER account** (`Administrator`, `svc-sql`, `jdoe`): no human replicates the
     directory by hand. Requesting replication rights is DCSync. → the TRUE_POSITIVE path.
   - **MACHINE account** (ends in `$`, e.g. `DC02$`): this is the **ambiguous** bucket, and
     it is a trap. A `$` account replicating is EITHER a legitimate Domain Controller doing
     its job OR **DCShadow** — an attacker who registered a rogue machine as a fake DC. The
     two are **indistinguishable from these events**: telling them apart needs a list of the
     domain's real DCs, which you do not have. A `$` actor is therefore **NOT automatically
     benign** — it is UNCONFIRMED. → the NEEDS_HUMAN path.
   - **Known directory-sync service account** (Azure AD Connect, etc.): legitimately holds
     these rights, but you cannot confirm the account is that service from the event alone.
     Treat as UNCONFIRMED. → the NEEDS_HUMAN path.

4. **Note the source host.** Capture `host`. Replication landing on a DC does not make it
   benign — a rogue-DC (DCShadow) read also lands on a real DC.

## Verdict Precedence Rules

**Evaluate in order; the first match wins.** Emit the **system verdict** in the final
column — one of exactly `TRUE_POSITIVE`, `FALSE_POSITIVE`, `NEEDS_HUMAN` — as your
`verdict` field. The named severity is context for the write-up, not the verdict value.

| # | Condition | **Verdict** | Severity note |
|---|---|---|---|
| 1 | `1131f6ad` (Get-Changes-All) requested by a **USER** (non-`$`) account | **`TRUE_POSITIVE`** | Critical — secret replication; name the actor |
| 2 | Both `1131f6aa` and `1131f6ad` requested by a **USER** account | **`TRUE_POSITIVE`** | Critical — Mimikatz DCSync signature |
| 3 | Only `1131f6aa` (Get-Changes) by a **USER** account | **`TRUE_POSITIVE`** | Anomalous replication; no user should replicate |
| 4 | Actor is a **MACHINE (`$`)** or **possible sync-service** account — legitimate DC vs DCShadow cannot be told apart here | **`NEEDS_HUMAN`** | Escalate to verify the actor against the domain's DC inventory. **Do NOT call this TRUE_POSITIVE — you cannot prove malice; do NOT call it FALSE_POSITIVE — you cannot prove benign** |
| 5 | No replication GUID in `properties` at all | **`FALSE_POSITIVE`** | Not DCSync; routine directory access |

**Rule 4 is the one most easily gotten wrong.** A `$` machine account is *unconfirmed*, not
*guilty*. Reporting it `TRUE_POSITIVE` claims a malice you cannot prove from the events;
reporting it `FALSE_POSITIVE` claims a legitimacy you also cannot prove. The honest verdict
is `NEEDS_HUMAN` — hand it to an analyst who can check whether the actor is a real DC.

## Required Output

| Output | Content |
|---|---|
| **Verdict** | The precedence rule number that matched, with supporting evidence |
| **Replication rights** | Each GUID seen, resolved to its name |
| **Actor** | The `SubjectUserName`, and whether it is a `$` machine account or a user |
| **Target DC** | The `host` the replication read landed on |
| **Visibility statement** | What you could not confirm: DC status of the actor, its group membership, its history |
| **Containment recommendation** | Recommendations only, never executed |

Produce structured output only. Facts only, no internal monologue.

## Critical Failures (Automatic)

- Reporting `FALSE_POSITIVE` when `1131f6ad` (Get-Changes-All) was requested by a **user** account.
- Reporting `TRUE_POSITIVE` for a **machine (`$`) account** — that claims a malice the events
  cannot prove (it may be a legitimate DC). The correct verdict there is `NEEDS_HUMAN`.
- Reporting `FALSE_POSITIVE` for a **machine (`$`) account** on the assumption it is a real DC —
  that claims a legitimacy the events cannot prove (it may be DCShadow). Also `NEEDS_HUMAN`.
- Concluding benign because the event **succeeded** or because there were **only a few events** —
  DCSync is low-volume and succeeds by design.
- Reporting a GUID, right, or account not present in the attached events.
- Treating a visibility gap (unconfirmable actor) as a true negative.
