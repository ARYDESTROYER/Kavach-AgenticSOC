---
title: "Runbook: DCShadow (Rogue Domain Controller) Investigation"
type: "runbook"
category: "security_operations"
status: "active"
platform: "active_directory"
siem: "any"
schema: "ocsf"
access: "read_only"
attack_technique: "DCShadow — registering a rogue Domain Controller to push malicious replication"
mitre:
  - "T1207 (Rogue Domain Controller)"
  - "T1098 (Account Manipulation)"
  - "T1078.002 (Valid Accounts: Domain Accounts)"
rules:
  - dcshadow_rogue_dc
tags:
  - dcshadow
  - rogue_domain_controller
  - active_directory
  - replication
  - persistence
  - defense_evasion
  - 4742
  - 4662
  - service_principal_name
summary: "A non-DC machine account is registered as a Domain Controller (a DC-only SPN is added and the configuration partition is written) so an attacker can PUSH forged replication changes that propagate as legitimate."
---

# Runbook: DCShadow (Rogue Domain Controller) Investigation

## Purpose

Decide whether activity is **DCShadow** — an attacker temporarily registering a machine they
control as a **Domain Controller**, then using directory **replication to PUSH forged changes**
(a SID-History write, a group membership, an AdminSDHolder edit) into the domain. Because the
changes arrive over the legitimate DC-to-DC replication channel, they look authoritative and
often bypass object-level auditing.

The single most important job of this runbook is to **tell DCShadow apart from DCSync**. They
share the replication machinery but move in opposite directions:

- **DCSync PULLS.** An attacker asks a real DC to hand over secrets (password hashes). The tell
  is a `Get-Changes-All` replication read (Event 4662). Nothing is registered; nothing is written.
- **DCShadow PUSHES.** An attacker first **becomes** a DC — a machine account is handed a
  DC-only Service Principal Name and an object is written into the configuration partition — and
  then replicates changes *into* the domain. The tell is the **rogue-DC registration**, not a read.

If you see a replication **read** and no registration, you are looking at DCSync, not DCShadow —
say so and defer to that runbook.

## Operating Constraint — No Tool Calls

You have no SIEM query, no live directory lookup, no threat-intel tool. Every fact must come
from the events attached to this case.

- A fact you cannot read from the attached events is UNRESOLVED — never guessed.
- You cannot enumerate the real DC inventory or confirm whether a name legitimately belongs to a
  DC. Reason from the events you can see; state what you cannot confirm.
- Reporting an event, account, SPN, or GUID not present in the evidence is a Critical Failure.

## The Signal — the rogue-DC registration

| Event | What it means | Why it matters |
|---|---|---|
| **4742** (computer account changed) whose `service_principal_names` gains a **DC-only SPN** | a machine account is being made to look like a Domain Controller | the core of DCShadow: only real DCs carry these SPNs |
| **4662** on the **configuration partition** (Sites / Services container) by the same actor | a server / nTDSDSA object is being written into the directory topology | the directory-side half of registering a new DC |
| a replication **push/read** right exercised right after | the rogue DC begins replicating | forged changes propagate as authoritative |

### DC-only Service Principal Names (the discriminator)

A workstation or ordinary member server never carries these. Their appearance on a
non-DC machine account is the rogue-DC registration:

| SPN prefix | Service |
|---|---|
| `GC/…` | Global Catalog — only Domain Controllers host it |
| `E3514235-4B06-11D1-AB04-00C04FC2DCD2/…` | the **DRS** (Directory Replication Service / DRSUAPI) interface — the replication RPC endpoint |
| `ldap/…/<DSA-GUID>` bound to an NTDS Settings object | the directory service of a DC |

`GC/` and the `E3514235-…` DRS GUID are the ones to name: they are unambiguous DC identity.

## Field Bindings

| Logical name | Meaning | Field |
|---|---|---|
| `event_code` | Windows Event ID (4742 / 4662) | `event_code` |
| `actor` | who performed the change | `subject_user` (SubjectUserName) |
| `target_account` | the machine account being weaponised | `user` (TargetUserName) |
| `spn` | the service principal names set on it | `service_principal_names` |
| `object_type` / `properties` | the directory object/right touched (4662) | `object_type`, `properties`, `access_mask` |

The actor is `subject_user`. On a 4742 the `user` is the machine account being modified, not the
one doing the modifying.

## Workflow

> Reason first: is this a replication READ (someone pulling secrets) or a rogue-DC REGISTRATION
> (someone becoming a DC to push)? Answer that before assigning a verdict — it decides which
> attack, and which runbook, you are in.

1. Look for the rogue-DC registration. On any 4742, read `service_principal_names`. Does a
   **non-DC machine account** gain a `GC/` SPN or the `E3514235-…` DRS SPN? That is a machine
   being registered as a Domain Controller — the defining DCShadow act. Name the account and the SPN.

2. Corroborate with configuration-partition writes. Look for 4662 by the same actor touching the
   Sites / Services (configuration) topology — the directory-side registration of the new DC.

3. Confirm the direction is PUSH, not PULL. If the only replication evidence is a
   `Get-Changes-All` **read** and there is **no** SPN registration and **no** config-partition
   write, this is **DCSync** (a pull), not DCShadow. Say so explicitly and defer.

4. Name the actor and the target. State who registered which machine account as a DC, on which host.

5. Rule out the benign case. A genuine DC promotion (`dcpromo` / `Install-ADDSDomainController`)
   is performed by Domain/Enterprise Admins through provisioning tooling and results in a real,
   lasting DC. DCShadow is a **transient** registration by an actor who then immediately
   replicates and de-registers. A real DC's machine account already carrying these SPNs is normal.

## Verdict Precedence Rules

Evaluate in order; the first match wins. Emit the system verdict — one of exactly
`TRUE_POSITIVE`, `FALSE_POSITIVE`, `NEEDS_HUMAN` — as your `verdict`.

| # | Condition | Verdict | Severity note |
|---|---|---|---|
| 1 | A **non-DC machine account** is given a **DC-only SPN** (`GC/` or the `E3514235-…` DRS SPN) **and** the configuration partition is written / replication follows | `TRUE_POSITIVE` | Critical — DCShadow; a rogue DC was registered to push forged replication. Name the account, the SPN, the actor |
| 2 | A **non-DC machine account** is given a `GC/` or DRS SPN by a user/admin, even without the config write seen in evidence | `TRUE_POSITIVE` | High — rogue-DC registration; the DC-only SPN alone has no benign form on a non-DC account |
| 3 | Only a replication **read** (`Get-Changes-All`, 4662) is present, with **no** SPN registration and **no** config-partition write | `NEEDS_HUMAN` | This is a **DCSync pull, not DCShadow** — say so and route to the DCSync runbook; do not force a DCShadow verdict |
| 4 | The SPNs belong to an **already-established Domain Controller's** own machine account, only routine replication | `FALSE_POSITIVE` | Normal DC-to-DC replication |

Rule 3 is the discrimination guard: never label a replication read as DCShadow. If registration
evidence is absent, the honest answer is "this looks like DCSync — hand off."

## Required Output

| Output | Content |
|---|---|
| **Verdict** | The precedence rule number that matched, with the evidence |
| **The registration** | State it plainly: *"machine account `<name>` was given the DC-only SPN `<spn>` by `<actor>` on `<host>`"* |
| **PUSH vs PULL** | Explicitly state whether this is a rogue-DC registration (DCShadow, push) or a replication read (DCSync, pull), and the evidence that decided it |
| **Config-partition activity** | Any 4662 writes to the Sites/Services topology you found |
| **Visibility statement** | What you could not confirm (real DC inventory, whether the account was later de-registered) |
| **Containment recommendation** | Recommendations only, never executed |

Produce structured output only. Facts only, no internal monologue.

## Critical Failures (Automatic)

- Calling a replication **read** (`Get-Changes-All`, no SPN/registration) DCShadow — that is
  DCSync; conflating the two is the failure this runbook exists to prevent.
- Reporting `FALSE_POSITIVE` on a `GC/` or DRS SPN added to a non-DC machine account — that
  registration has no legitimate form.
- Attributing the action to the target machine account (`user`) rather than the actor (`subject_user`).
- Failing to name the DC-only SPN and the account it was placed on.
- Reporting an event, account, SPN, or GUID not present in the attached evidence.
