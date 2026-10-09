---
title: "Runbook: Kerberos Password Spray Investigation"
type: "runbook"
category: "security_operations"
status: "active"
platform: "active_directory"
siem: "any"
schema: "ocsf"
access: "read_only"
attack_technique: "Password Spraying / T1110.003"
mitre:
  - "T1110.003 (Brute Force: Password Spraying)"
  - "T1087.002 (Account Discovery: Domain Account)"
  - "T1078.002 (Valid Accounts: Domain Accounts)"
rules:
  - kerberos_password_spray
tags:
  - kerberos
  - password_spray
  - active_directory
  - credential_access
  - 4768
  - 4771
  - 1102
summary: "One source authenticating against many distinct domain accounts in a short window."
---

# Runbook: Kerberos Password Spray Investigation

## Purpose

Decide whether a burst of Kerberos authentication failures from a single source is a
**password spray** — one attacker trying a few passwords against **many** accounts — and
whether it **succeeded**.

**Spray is defined by fan-out, not by volume.** Many distinct target accounts with few
attempts each is a spray. One account with many attempts is brute force, a different
finding. Counting total failures without counting *distinct accounts* cannot tell them
apart.

## Operating Constraint — No Tool Calls

**You have no SIEM, no directory lookup, and no threat-intel tool in this deployment.**
Every fact you report must come from the events already attached to this case.

- Do **not** describe a query you did not run, or a lookup you could not perform.
- A fact you cannot read from the attached events is **UNRESOLVED** — never a value.
- Historical baselining, account-existence confirmation, and IP reputation are all
  **unavailable**. Say so explicitly; do not substitute an assumption for them.

Reporting an event, account, or status code that is not present in the attached
evidence is a Critical Failure.

## Field Bindings

Read these from each attached event. Probe candidates in order; record what you used.

| Logical name | Meaning | Candidates (in order) |
|---|---|---|
| `F_EVENT_CODE` | Windows Event ID | `metadata.event_code` → `unmapped.EventID` → `event.module` |
| `F_TARGET` | Account being authenticated | `user.name` → `unmapped.TargetUserName` |
| `F_SRC_IP` | Source address | `src_endpoint.ip` → `unmapped.IpAddress` |
| `F_HOST` | Domain controller | `device.hostname` → `unmapped.Computer` |
| `F_STATUS` | Kerberos result code | `status_code` → `unmapped.Status` |
| `F_TIME` | Timestamp | `time` → `@timestamp` |

## Status Code Reference

`F_STATUS` is the highest-value field in this investigation. It separates *enumeration*
from *password guessing* from *success*.

**Match on the numeric value, not the string.** The same code appears as `0x18` or
zero-padded as `0x00000018`, and occasionally as decimal `24`. A literal string
comparison against the short form will silently miss every padded event — normalize
before you compare, and state which encoding this source used.

| Code | Meaning | What it tells you |
|---|---|---|
| `0x0` | Success | **A credential worked.** Decisive — see precedence rule 1 |
| `0x6` | `KDC_ERR_C_PRINCIPAL_UNKNOWN` | The account **does not exist**. Attacker is guessing usernames — enumeration |
| `0x12` | `KDC_ERR_CLIENT_REVOKED` | Account disabled or locked out — often the *result* of spraying |
| `0x17` | `KDC_ERR_KEY_EXPIRED` | Expired password. Common benign cause after a policy change |
| `0x18` | `KDC_ERR_PREAUTH_FAILED` | Wrong password, but **the account exists**. Real guessing against a real target |
| `0x25` | `KRB_AP_ERR_SKEW` | Clock skew. Infrastructure fault, not an attack |

A mix of `0x6` and `0x18` from one source is the signature of a spray run against a
**wordlist**: the `0x6` entries are the attacker's misses, the `0x18` entries are the
accounts that actually exist.

## Workflow

> **Reason first:** State what result would change your mind, before you compute anything.

1. **Measure the shape.** From the attached events compute, and report, all four:
   - `TOTAL_ATTEMPTS` — count of authentication events
   - `DISTINCT_TARGETS` — count of distinct `F_TARGET` values
   - `ATTEMPTS_PER_TARGET` = `TOTAL_ATTEMPTS` / `DISTINCT_TARGETS`
   - `WINDOW_SECONDS` — last `F_TIME` minus first `F_TIME`

   | Shape | Reading |
   |---|---|
   | `DISTINCT_TARGETS` ≥ 5 **and** `ATTEMPTS_PER_TARGET` ≤ 3 | **Spray** |
   | `DISTINCT_TARGETS` = 1 **and** `TOTAL_ATTEMPTS` high | **Brute force** — wrong runbook, say so |
   | `DISTINCT_TARGETS` ≥ 5 **and** `ATTEMPTS_PER_TARGET` > 3 | Hybrid; continue as spray, note the deviation |

2. **Classify the outcomes.** Tally `F_STATUS` across the cluster. Capture `SUCCESS_COUNT`
   (`0x0`), `UNKNOWN_PRINCIPAL_COUNT` (`0x6`), `BAD_PASSWORD_COUNT` (`0x18`), and
   `LOCKOUT_COUNT` (`0x12`).

3. **Identify which accounts succeeded.** List every `F_TARGET` whose event carried `0x0`.
   **Name them individually** — this is the blast radius and the single most important
   output of this runbook.

4. **Inspect the target list for enumeration intent.** Report whether the targets include
   high-value names (`Administrator`, `admin`, service accounts) or names suggesting a
   wordlist rather than a real directory. Accounts returning `0x6` did not exist — their
   presence proves guessing.

5. **Check for anti-forensics in the same cluster.** Event **`1102`** ("the audit log was
   cleared") or `517` appearing alongside the authentication burst means log destruction
   accompanied the attack. This is never routine. Escalate under precedence rule 2.

6. **Consider benign causes before concluding.** A spray shape has a small number of
   innocent explanations — rule each in or out explicitly:
   - A **vulnerability scanner** or pen-test appliance authenticating broadly. Supports a
     benign reading only if the source is an identified scanner; you cannot confirm that
     without an asset lookup, so mark it UNRESOLVED rather than assuming it.
   - A **stale service credential** after a password rotation — but that fails against
     *one* account repeatedly, not many, and yields `0x18`, never `0x6`.
   - **Domain-wide password expiry** — yields `0x17`, not `0x18`/`0x6`.

   A benign explanation must fit **both** the fan-out shape *and* the status-code mix.
   One that explains only the volume is not an explanation.

## Verdict Precedence Rules

**Evaluate in order; the first match wins.** These conditions are individually decisive
and must not be averaged together.

| # | Condition | Verdict |
|---|---|---|
| 1 | `SUCCESS_COUNT` ≥ 1 in a confirmed spray shape | **Confirmed Critical — Successful Password Spray.** A credential is compromised; name every account that succeeded |
| 2 | Event `1102`/`517` present in the cluster | **Confirmed Critical — Spray with Log Clearing.** Anti-forensics; highest priority |
| 3 | Spray shape **and** `UNKNOWN_PRINCIPAL_COUNT` ≥ 1, no success | **True Positive — Password Spray with Account Enumeration** |
| 4 | Spray shape, all failures, no enumeration | **True Positive — Password Spray (unsuccessful)** |
| 5 | `LOCKOUT_COUNT` ≥ 3 across distinct accounts | **True Positive — Spray causing lockouts.** Availability impact even without compromise |
| 6 | Shape is brute force, not spray | **Suspicious — Wrong Classification.** Re-triage under the brute-force runbook |
| 7 | Any required field unbindable, or the source cannot be attributed | **Suspicious — Insufficient Visibility.** Escalate and name the specific gap. **Never close a visibility gap as a false positive** |
| 8 | Every check resolved, shape does not match, and a benign cause fits both shape and status mix | **False Positive.** Close and document which checks resolved |

Rule 7 sits above rule 8 deliberately: **an unresolved check is not a passed check.**

## Required Output

| Output | Content |
|---|---|
| **Verdict** | The precedence rule number that matched, with its supporting evidence |
| **Shape metrics** | `TOTAL_ATTEMPTS`, `DISTINCT_TARGETS`, `ATTEMPTS_PER_TARGET`, `WINDOW_SECONDS` |
| **Status breakdown** | Counts per `F_STATUS` code observed |
| **Compromised accounts** | Every account with a `0x0`, named individually — or "none observed" |
| **Source** | `F_SRC_IP` and the targeted domain controller |
| **Visibility statement** | What you could not check: no historical baseline, no account-existence lookup, no IP reputation |
| **Containment recommendation** | Recommendations only, never executed |

Produce structured output only. Facts only, no internal monologue.

## Critical Failures (Automatic)

- Reporting an account, event, or status code **not present** in the attached events.
- Closing as a false positive when `SUCCESS_COUNT` ≥ 1.
- Reporting total failure volume **without** `DISTINCT_TARGETS` — that cannot distinguish
  spray from brute force.
- Treating a **visibility gap** as a true negative, or claiming a baseline you could not read.
- Describing a query, lookup, or enrichment you did not perform.
- Ignoring event `1102` when it is present in the cluster.
