---
title: "Runbook: Privileged Group Membership Added Investigation"
type: "runbook"
category: "security_operations"
status: "active"
platform: "active_directory"
siem: "any"
schema: "ocsf"
access: "read_only"
attack_technique: "Privileged Group Manipulation (Guest / low-privilege principal added to Administrators)"
mitre:
  - "T1098 (Account Manipulation)"
  - "T1078 (Valid Accounts)"
  - "T1548 (Abuse Elevation Control Mechanism)"
rules:
  - privileged_group_addition
tags:
  - privileged_group_addition
  - group_membership
  - active_directory
  - privilege_escalation
  - persistence
  - guest_account
  - 4732
  - 4728
  - 4756
summary: "A principal is added to a privileged group; the added member is a built-in low-privilege account (Guest, Network Service, Anonymous) that should never hold administrative rights."
---

# Runbook: Privileged Group Membership Added Investigation

## Purpose

Decide whether a group-membership change is a **privilege-escalation / persistence backdoor** —
an attacker adding a principal to a privileged group so it gains administrative rights. The
sharpest case is a **built-in low-privilege account** (the Guest account, Network Service,
Anonymous Logon, Everyone) being placed into **Administrators** or **Domain Admins**: those
principals exist for un-privileged or anonymous contexts and are never legitimately made
administrators.

The tell is not volume — it is **which principal was added to which group**. One membership
change is the whole compromise. A well-known low-privilege SID landing in an admin group is the
signature; the actor grants themselves (or an anonymous foothold) durable admin access.

## Operating Constraint — No Tool Calls

You have no SIEM query, no live directory lookup, no threat-intel tool. Every fact must come
from the events attached to this case.

- A fact you cannot read from the attached events is UNRESOLVED — never guessed.
- You cannot query current group membership or confirm a change-ticket exists. Reason from the
  events you can see, and state what you cannot confirm.
- Reporting an event, account, group, or SID not present in the evidence is a Critical Failure.

## The Signal

| Event | What it means | Why it matters |
|---|---|---|
| 4732 | a member was added to a **security-enabled local group** | Local Administrators backdoor (e.g. on a workstation or member server) |
| 4728 | a member was added to a **security-enabled global group** | Domain Admins / other domain group escalation |
| 4756 | a member was added to a **security-enabled universal group** | Enterprise Admins / forest-wide escalation |

For each, the added principal is in `member_sid` (and sometimes `member_name`); the group is in
`user` (TargetUserName carries the GROUP name on these events); the actor is `subject_user`.

### Well-known low-privilege principals that should never be administrators

| SID / RID | Principal | Why it is never a legitimate admin |
|---|---|---|
| RID ending **-501** | Guest | disabled-by-default, low/anonymous-trust account |
| **S-1-5-20** | Network Service | a machine service context, not an operator |
| **S-1-5-7** | Anonymous Logon | unauthenticated |
| **S-1-1-0** | Everyone | grants the right to every principal |
| **S-1-5-11** | Authenticated Users | grants the right to every domain user |
| RID ending **-513** | Domain Users | grants the right to every domain user |

### Privileged target groups

Administrators (`S-1-5-32-544`), Domain Admins (RID `-512`), Enterprise Admins (RID `-519`),
Schema Admins (RID `-518`), Backup Operators (`S-1-5-32-551`), Account/Server/Print Operators.

## Field Bindings

| Logical name | Meaning | Field |
|---|---|---|
| `event_code` | Windows Event ID (4732 / 4728 / 4756) | `event_code` |
| `actor` | who performed the addition | `subject_user` (SubjectUserName) |
| `group` | the group that was modified | `user` (TargetUserName) |
| `added_member` | the principal added to the group | `member_sid` (MemberSid), `member_name` |

The actor is `subject_user`, not `user`. On these events `user` is the group. Attributing the
action to the group name instead of the actor is a Critical Failure.

## Workflow

> Reason first: what benign change would add the Guest account, Network Service, or Anonymous
> Logon to Administrators? If you cannot name one, none exists — that addition is the finding.

1. Identify the group. Read `user` (the TargetUserName). Is it a privileged group
   (Administrators, Domain Admins, Enterprise Admins, an Operators group)? A change to a
   non-privileged group is far lower-stakes.

2. Identify the added member. Read `member_sid` (and `member_name` if present). Match the SID
   against the low-privilege table above — a trailing **-501** (Guest), **S-1-5-20**
   (Network Service), **S-1-5-7** (Anonymous), **S-1-1-0**/**S-1-5-11** (Everyone / all users).
   Any of these in an admin group is the smoking gun.

3. Name the actor. Read `subject_user`. State who performed the addition. Note if the same actor
   made several such additions in the window (a batch backdoor).

4. Rule out the benign case. Legitimate escalation adds a **named human admin** to a privileged
   group, usually by an existing admin, ideally with a change record. It does **not** add the
   built-in Guest, Network Service, or Anonymous principals — those additions have no benign form.

## Verdict Precedence Rules

Evaluate in order; the first match wins. Emit the system verdict — one of exactly
`TRUE_POSITIVE`, `FALSE_POSITIVE`, `NEEDS_HUMAN` — as your `verdict`.

| # | Condition | Verdict | Severity note |
|---|---|---|---|
| 1 | A **well-known low-privilege principal** (Guest -501, Network Service S-1-5-20, Anonymous S-1-5-7, Everyone S-1-1-0, Authenticated Users S-1-5-11, Domain Users -513) added to a **privileged group** (Administrators / Domain Admins / Enterprise Admins / Operators) | `TRUE_POSITIVE` | Critical — a low-trust or universal principal was made an administrator; name the principal, group and actor. Assume persistence/backdoor |
| 2 | Any principal added to **Domain Admins / Enterprise Admins / Schema Admins** where the actor is not an established directory-admin, or the addition is otherwise unexplained | `TRUE_POSITIVE` | High — domain-level escalation |
| 3 | A **named user** account added to a privileged group by an existing admin, no other anomaly | `NEEDS_HUMAN` | Could be legitimate admin onboarding; escalate to confirm against change control |
| 4 | Addition to a **non-privileged** group, or a routine principal added by an admin to a routine group | `FALSE_POSITIVE` | Ordinary group management |

Rule 1 outranks Rule 3: a named-user addition might be legitimate, but adding Guest or an
anonymous/universal principal to Administrators never is.

## Required Output

| Output | Content |
|---|---|
| **Verdict** | The precedence rule number that matched, with the evidence |
| **The change** | State it plainly: *"`<principal>` was added to `<group>` on `<host>` by `<actor>`"* |
| **Why the member is dangerous** | If it matched the low-privilege table, name the SID and why that principal is never a legitimate administrator |
| **Actor** | `subject_user` — who performed the addition (not the group name) |
| **Visibility statement** | What you could not confirm (current membership, whether a change ticket exists) |
| **Containment recommendation** | Recommendations only, never executed |

Produce structured output only. Facts only, no internal monologue.

## Critical Failures (Automatic)

- Reporting `FALSE_POSITIVE` on the Guest account, Network Service, or Anonymous Logon being
  added to Administrators — that addition has no legitimate form.
- Concluding benign because "only one event" occurred — one membership change is the compromise.
- Attributing the action to the group (`user`) instead of the actor (`subject_user`).
- Failing to name which principal was added and which group it landed in.
- Reporting an event, account, group, or SID not present in the attached evidence.
