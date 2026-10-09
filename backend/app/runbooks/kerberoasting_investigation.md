---
title: "Runbook: Kerberoasting Investigation (Standard & Targeted SPN Abuse)"
type: "runbook"
category: "security_operations"
status: "active"
platform: "active_directory"
siem: "any"
schema: "ocsf"
ocsf_version: "1.8.0"
mcp: "siem-mcp"
access: "read_only"
attack_technique: "Kerberoasting / T1558.003"
mitre:
  - "T1558.003 (Steal or Forge Kerberos Tickets: Kerberoasting)"
  - "T1098.003 (Account Manipulation: Service Principal Name)"
  - "T1078.002 (Valid Accounts: Domain Accounts)"
companion: "kerberoasting_investigation.eval.md (selection, tuning, rubric, provenance — not for you)"
---

# Runbook: Kerberoasting Investigation (Standard & Targeted SPN Abuse)

## Purpose

Execute a standardized investigation procedure for suspected **Kerberoasting**, in both its standard and targeted forms. Given the alert, you will **validate** the TGS request against Domain Controller telemetry, **baseline** the requester's history with the target SPN, **establish the provenance** of the SPN itself, **assess** the impact, and **produce a verdict with evidence — without executing containment actions.**

**Do not rely on signatures.** Rubeus `/opsec` sends the exact Ticket Options a genuine Windows client sends (`0x40810000`). Requesting AES-256 (`0x12`) defeats every "RC4 Kerberoast" rule. Throttling defeats volume thresholds. Each of these signals costs the attacker a single command-line flag to defeat, so none of them can carry a verdict. Two discriminators are durable: **the absence of established history**, and **provable SPN injection**. Signature checks corroborate those; they never exonerate.

## Scope

**In scope:**
- Standard Kerberoasting — TGS extraction against existing SPNs (Event 4769)
- Targeted Kerberoasting — fake SPN injection via `GenericWrite` or `GenericAll` (Event 5136)
- Behavioral baselining of the requester's history with the target SPN
- ACL corroboration over the modified object
- Decoy SPN detection, and RC4 downgrade against an AES-enforced account
- Identity correlation from SIEM-resident data, on any OCSF-normalized platform
- Verdict determination and handoff to the AD-abuse IRP for containment

**Out of scope:**
- AS-REP Roasting — abuse of Event 4768 when pre-authentication is disabled; see `asrep_roasting_investigation.md`. Note that 4768 is also generated for ordinary Kerberos TGT requests
- Golden and Silver Ticket forgery
- Password resets, account disablement, and SPN removal — the IRP owns these
- Any Active Directory write. `ad-mcp` is read-only here, and corroborates only; it is never the primary source of identity

## Inputs

| Parameter | Required | Description |
|---|---|---|
| `${ALERT_ID}` / `${CASE_ID}` | Yes | Triggering alert or case |
| `${REQUESTER_ACCOUNT}` | Yes | Account that requested the TGS (e.g. `GALACTIC\jdoe`) |
| `${TARGET_SPN}` | Yes | SPN requested (e.g. `MSSQLSvc/sql01.domain.local`) |
| `${T0}` | Yes | Alert timestamp — anchor for every relative window (derive in Step 1) |
| `${TIME_FRAME_HOURS}` | No | Correlation window either side of `${T0}` (default `24`) |
| `${LOG_SOURCE}` | No | Bind in Phase 0 |
| `${SERVICE_ACCOUNT}` | No | Account owning `${TARGET_SPN}`. Resolve in Step 5 — **not** the requester |
| `${DECOY_SPNS}` | No | Honeypot SPNs; a request for one is malicious by construction |
| `${SUPPRESS_ACCOUNTS}` | No | Known-noisy legitimate service accounts (volume analysis only) |
| `${BASELINE_DAYS}` | No | Established-history window (default `30`) |
| `${VOLUME_THRESHOLD}` | No | Unique SPNs per 4h indicating volumetric roasting (default `5`) |
| `${DC_HOSTNAME}` | No | Context only. **Never scope the 5136 precursor query by it** — the injection may have been written on a different DC |

## Tools

| Tool | Purpose | Access |
|---|---|---|
| `siem-mcp` | `list_sources`, `get_schema`, `search` | Read-only |
| `ad-mcp` | **Optional.** SPN→account, ACL read, `msDS-SupportedEncryptionTypes` | Read-only |
| `ti-mcp` | Optional enrichment | Read-only |
| `case-mgmt` | Comments, escalation, priority | Write (case metadata only) |
| `common_steps/*` | IOC enrichment, documentation, closure | Varies |

`search` must support filtering, field projection, time bounds, sorting, limits, and `COUNT` / `COUNT DISTINCT` / `MIN` aggregation with grouping.

`ad-mcp` is **optional**. Every step that uses it also declares a SIEM-only fallback, so its absence degrades a finding to UNRESOLVED but never blocks you.

## Rules

**Reasoning.** Each phase opens with a *Reason first* prompt. Answer it in the case comment **before** you run that phase's queries.

1. **Name what would change your mind** before each phase. If no result could falsify your hypothesis, you are confirming rather than investigating.
2. **Never infer a field you did not read.** A field you could not read is UNRESOLVED, not a value. A plausible reconstruction is a hallucination.
3. **Label every negative** as either *did not happen* or *cannot see*. That distinction separates a genuine false positive from a manufactured one.

**Query budget.** Phase 0: 4 · Phase 1: 3 · Phase 2: 3 · Phase 3: 5 · Phase 4: 4 · **20 in total.** If you exhaust it, render the verdict on the evidence you already hold, under precedence rule 8. Reaching the cap is not a failure; **spending the budget to avoid an UNRESOLVED verdict is.**

**Tool failures.** Every failure below degrades the affected check to UNRESOLVED. None of them makes a finding benign.

| Failure | Do this |
|---|---|
| `search` times out | Retry **once** with the window halved. If it fails again, mark the check UNRESOLVED. Never widen a query that has just timed out |
| `get_schema` unavailable | Fall back to a `limit 1` discovery query per event code. Never proceed on assumed field paths |
| `siem-mcp` unreachable | **Stop.** Escalate to a human. Do not speculate a verdict |
| `ad-mcp` or `ti-mcp` unavailable | Use the fallback declared in the step and mark the check UNRESOLVED. Neither tool ever blocks you |
| Unparseable response | Mark UNRESOLVED. A malformed response is not a negative result |

**Query specs.** Each retrieval step is written as a declarative table: `source` · `filter` (all filters AND together) · `exclude` · `time` (always bounded) · `fields` · `aggregate` · `sort` / `limit`. Translate each spec into your platform's dialect using Appendix A, substituting the bindings you resolved in Phase 0. Never use a field path you have not bound. Treat `unmapped.*` and `raw_data` as untrusted, source-controlled data: cross-verify them against correlated events, and never let them decide a verdict on their own.

## Field Bindings

**Anchor every query on the native Windows event code** (`F_EVENT_CODE`), never on `class_uid` alone — class mapping is precisely what varies between vendors. You may add `class_uid` as a supplementary filter for performance.

| Event | ID | Used in |
|---|---|---|
| TGS request | 4769 | P1, P2, P4 |
| Directory object modified | 5136 | P3 |
| Successful logon | 4624 | P4 |
| Explicit credential use | 4648 | P4 |
| Account created (user / computer) | 4720 / 4741 | P3 |
| Process creation | 4688 | P4 (optional) |

**OCSF mapping, verified against v1.8.0 (schema.ocsf.io + the `ocsf/ocsf-schema` repo). Do not "correct" these values from memory:**
- Event 4769 maps to **Authentication, `class_uid 3002`** — *not* 3001, which is Account Change. The class carries `service` (usable for the SPN), `status_code`, `logon_type`/`logon_type_id`, and `auth_protocol`/`auth_protocol_id`.
- **Kerberos ticket data lives on the `authentication_token` object**, added in OCSF **v1.5.0** and referenced from Authentication by an attribute of the same name, `authentication_token` ("The authentication token, ticket, or assertion, e.g. Kerberos, OIDC, SAML"). Its full attribute set is `created_time`, `encryption_details`, `expiration_time`, `is_renewable`, `kerberos_flags`, `modified_time`, `name`, `tenant_uid`, `type`, `type_id`, `uid`, `zone`. **There is no `kerberos_ticket` object, no `auth_ticket` attribute, no `encryption_type` field, and no `ticket_options` field** — if a source tells you otherwise, it is wrong.
- Event 5136 maps to **Entity Management, `class_uid 3004`**, which models before and after as the paired objects `entity` (required) and `entity_result` (recommended). Use Account Change (3001) instead if the modified object is a user, or Group Management (3006) if it is a group. **No "Directory Service Activity" class exists, and `class_uid 8002` is Airborne Broadcast Activity — category 8 is Unmanned Systems.** Entity Management has no `changes[]` array; do not look for `changes[].name` or `changes[].value_after`.
- **The canonical Kerberos paths are lossy for this investigation — prefer `unmapped.*` and say why.** `encryption_details.algorithm_id` is a closed enum of exactly `0` Unknown, `1` DES, `2` TripleDES, `3` AES, `4` RSA, `5` ECC, `6` SM2, `99` Other. **It cannot express RC4 at all, and cannot distinguish AES128 (`0x11`) from AES256 (`0x12`).** Your entire Step 6 discriminator lives in a distinction that enum discards, so where both exist, `unmapped.TicketEncryptionType` is the *better* source, not merely the fallback. `kerberos_flags` does carry the ticket-options bitmask faithfully.
- 5136 attribute-level detail (`AttributeLDAPDisplayName`, `AttributeValue`) has **no canonical OCSF path** and normally lands in `unmapped.*`. Expect this; it is not a failure.

**Bind each logical name separately for each event class** — the same name resolves to different paths depending on the class. Probe the candidates in the order given, and record the bindings you chose in the case.

| Logical name | Class | Target | Candidates (in order) |
|---|---|---|---|
| `F_TIME` | all | Timestamp | `time` → `time_dt` *(only if the `datetime` profile is declared)* → `@timestamp` / `_time` / `TimeGenerated` |
| `F_EVENT_CODE` | all | Windows Event ID | `metadata.event_code` → `unmapped.EventID` → `EventCode` |
| `F_LOG_NAME` | all | Channel (`Security`) | `metadata.log_name` → `unmapped.Channel` |
| `F_HOST` | all | Host / DC | `device.hostname` → `unmapped.Computer` |
| `F_ACCOUNT` | 4769 | Ticket requester | `actor.user.name` → `user.name` → `unmapped.AccountName` |
| `F_ACCOUNT` | 4624 | Logged-on principal | `user.name` → `actor.user.name` → `unmapped.TargetUserName` |
| `F_ACCOUNT` | 4648 | Credential presented | `unmapped.TargetUserName` → `user.name` |
| `F_ACTOR` | 5136/4648/4720/4741 | Who acted | `actor.user.name` → `unmapped.SubjectUserName` |
| `F_SPN` | 4769 | SPN | `service.name` *(canonical — Authentication has a `service` attribute)* → `unmapped.ServiceName` |
| `F_ENC_TYPE` | 4769 | Encryption type | `unmapped.TicketEncryptionType` **first** *(the raw etype is what you need)* → `authentication_token.encryption_details.algorithm_id` *(lossy: no RC4 in the enum, no AES128/256 split — see the mapping note)* |
| `F_TICKET_OPTS` | 4769 | Ticket options | `authentication_token.kerberos_flags` *(canonical; hex or decimal bitmask)* → `unmapped.TicketOptions` |
| `F_CLIENT_IP` | 4769/4624 | Client address | `src_endpoint.ip` → `unmapped.ClientAddress` / `unmapped.IpAddress` |
| `F_STATUS` | 4769 | Status / failure code | `status_code` → `unmapped.Status` → `unmapped.FailureCode` |
| `F_ATTR_NAME` | 5136 | Modified attribute | `unmapped.AttributeLDAPDisplayName` → `entity.data.*` |
| `F_ATTR_VALUE` | 5136 | New value | `unmapped.AttributeValue` → `entity_result.data.*` |
| `F_OBJECT_DN` | 5136 | Target object DN | `entity.name` → `unmapped.ObjectDN` |
| `F_OP_TYPE` | 5136 | Operation | `activity_name` / `activity_id` → `unmapped.OperationType` |
| `F_LOGON_TYPE` | 4624 | Logon type | `logon_type` → `unmapped.LogonType` |
| `F_PROCESS` | 4688 | Process name | `process.file.name` → `unmapped.NewProcessName` |

**Value encodings vary as well as paths.** `F_OP_TYPE` may read `"Value Added"` or `"Value Deleted"`, or the unresolved message IDs `%%14674` and `%%14675`, or an OCSF activity name. `F_ENC_TYPE` may be the raw Kerberos etype as `"0x17"`, `23`, or `"rc4-hmac"` — **or, if it bound to `encryption_details.algorithm_id`, a small integer from a different scale entirely (`3` = AES, `99` = Other), which is not an etype and cannot be compared to one.** Success in `F_STATUS` may be `"0x0"` or `0`. **Confirm the actual values with a Phase 0 discovery query** and match what the data contains, not what this table shows.

## Noise Filtering (`EXCLUDE_NOISE`)

Event 4769 is generated for **every** Kerberos service ticket in the domain, and the overwhelming majority of it is routine machine traffic. Any query that discovers or counts SPNs must therefore exclude the following:

| Exclude | Why |
|---|---|
| `F_SPN` equal to `krbtgt` or `Dns` | Universal built-in service traffic, and never roastable |
| `F_SPN` ending in `$` | Machine-account SPNs. Routine, and machine account passwords are 120 characters and randomly generated |
| `F_ACCOUNT` ending in `$` | Machine accounts requesting tickets, which is routine domain operation |
| `F_ACCOUNT` listed in `${SUPPRESS_ACCOUNTS}` | Known-legitimate high-volume accounts such as backup, monitoring, and load balancers |

Two constraints govern this filter:

1. **It applies to discovery and volume queries only** (Steps 8 and 14). **Never** apply it to the named alert target in Steps 4 and 7. If the alert's own target is a `$`-account SPN, investigate it — do not filter away the thing you were asked to triage.
2. **`${SUPPRESS_ACCOUNTS}` suppresses evidence.** Name every account you suppress in the case comment. Suppressing one silently is a Critical Failure.

## Workflow

### Phase 0 — Context & Binding

> **Reason first:** Which bindings, if you got them wrong, would silently produce a false negative?

1. **Load the alert context.** Call `case-mgmt.get_case_full_details(${ALERT_ID})` and extract `${REQUESTER_ACCOUNT}`, `${TARGET_SPN}`, `${DC_HOSTNAME}`, and `${T0}`.

2. **Check the decoy list first; it is decisive.** If `${TARGET_SPN}` appears in `${DECOY_SPNS}`, set `DECOY_HIT = true`. No legitimate process ever authenticates to a decoy, so the verdict is already Confirmed Critical under rule 1. Continue the investigation regardless, in order to scope the blast radius. If `${DECOY_SPNS}` is not configured, record the absence of deception coverage as a recommendation for the IRP.

3. **Bind the fields. This is mandatory.** Call `list_sources` to bind `${LOG_SOURCE}`, then call `get_schema` and confirm each of the following: whether the 4769 identity fields sit at canonical OCSF paths or in `unmapped.*`; whether `F_ENC_TYPE` and `F_TICKET_OPTS` are present at all, **and if `F_ENC_TYPE` bound to `encryption_details.algorithm_id`, whether the raw etype also survives anywhere** (see the degradation rule); whether 5136 events exist, and where their SPN attribute detail lands; the **actual value encodings** for `F_STATUS`, `F_ENC_TYPE`, and `F_OP_TYPE`; and the source's **true retention**, meaning its earliest available timestamp, on which Phase 2 depends.

   **Gate:** do not proceed until every logical name is bound for every class you will query. A field you cannot bind is a documented gap, not a guess. If `get_schema` proves inconclusive, run a `limit 1` discovery query per event code and inspect the returned document.

   **Degradation — two distinct cases, and the second is the trap.**
   - **Absent:** if `F_ENC_TYPE` and `F_TICKET_OPTS` are missing altogether — a common thin-forwarder case — drop the encryption and options analysis, mark it UNRESOLVED, and proceed. Phases 2 and 3 carry the verdict without them. Never infer the value of an absent field.
   - **Present but lossy:** if `F_ENC_TYPE` bound *only* to `encryption_details.algorithm_id`, the field exists and returns values, but it cannot express RC4 and collapses AES128 and AES256 into `3`. **A populated field is not a usable field here.** Mark the encryption analysis UNRESOLVED exactly as if it were absent, and record *which* case you hit — a reader who sees "UNRESOLVED" needs to know whether the data was missing or merely unusable.

   **Selective ingest is invisible to `get_schema`.** Some environments drop AES 4769 events at the forwarder to save volume, or ingest only failed requests, which this attack does not generate. A source that *has* the right fields can still be missing the events. If `F_ENC_TYPE` shows an implausible distribution — no AES at all in a modern domain, for instance — treat the baseline as UNRESOLVED and flag the ingest pipeline for review.

### Phase 1 — Anchor on the Ticket Request

> **Reason first:** If the 4769 event is missing, is it genuinely absent, or did you bind the wrong field? Suspect your binding before you conclude absence.

4. **Retrieve the TGS request.** Apply no noise exclusions here — the target is named in the alert.

   | | |
   |---|---|
   | `source` | `${LOG_SOURCE}` |
   | `filter` | `F_EVENT_CODE` = `4769`; `F_LOG_NAME` = `Security` |
   | `filter` | `F_ACCOUNT` = `${REQUESTER_ACCOUNT}`; `F_SPN` matches `${TARGET_SPN}` |
   | `time` | `${T0} - ${TIME_FRAME_HOURS}h` → `${T0} + 1h` |
   | `fields` | `F_TIME`, `F_HOST`, `F_ACCOUNT`, `F_SPN`, `F_ENC_TYPE`, `F_TICKET_OPTS`, `F_CLIENT_IP`, `F_STATUS` |
   | `sort` / `limit` | `F_TIME` DESC / `50` |

   **Normalize the SPN.** SPNs are case-insensitive and may carry a port or instance suffix, so `MSSQLSvc/sql01.domain.local:1433` and `mssqlsvc/SQL01.domain.local` denote the same service as `MSSQLSvc/sql01.domain.local`. An exact, case-sensitive term match will miss them silently. Match case-insensitively on the `service/host` prefix, then confirm the full value in the returned document.

   **Capture:** `ISSUED` (true when `F_STATUS` indicates success, per the encoding you confirmed in Phase 0), `DC_REQUESTER`, `DC_SPN`, `CLIENT_IP`, `DC_ENCRYPTION_TYPE`, and `DC_TICKET_OPTIONS`. Mark the last two UNRESOLVED if you could not bind them.

   **Check for `0xE`; do not skip this.** An `F_STATUS` of `0xE` (`KDC_ERR_ETYPE_NOTSUPP`) means the requester asked for an encryption type the target account does not support. That is the fingerprint of a **failed RC4 downgrade** against an AES-enforced account, and a success-only filter will never see it. Record it, and treat the baseline as anomalous regardless of the access count.

   **If you find no 4769:** re-check your `F_ACCOUNT` and `F_SPN` bindings, then retry **once** using the next candidate path. A domain-qualified account name where the data holds a bare one, and an unnormalized SPN, are the two most common causes of a false negative here. If the result is still empty, document "no TGS request found for this SPN", then stop and escalate.

5. **Resolve `${SERVICE_ACCOUNT}`** — the account that owns `${TARGET_SPN}`, which is **not** the requester. Use the first source that resolves: (a) an `ad-mcp` lookup from SPN to account, which is authoritative; (b) the 5136 `F_OBJECT_DN` from Phase 3, since that DN *is* the owning account; or (c) the SPN's own host component, **which is a hypothesis only — flag it as unconfirmed**. If none resolve, set `${SERVICE_ACCOUNT}` to UNRESOLVED, record the gap, and skip Step 15a.

6. **Analyze the encryption type and ticket options.** Both checks corroborate; neither can exonerate.

   > **You need the raw etype here, not the OCSF enum.** If `F_ENC_TYPE` resolved to `encryption_details.algorithm_id`, you cannot run this table: that enum has no RC4 value and collapses AES128 and AES256 into a single `3` (AES). An `algorithm_id` of `3` tells you nothing this step needs, and `99`/`0` for an RC4 ticket is indistinguishable from a mapping failure. If only the canonical path is bound, mark the encryption analysis **UNRESOLVED** and let Phases 2 and 3 carry the verdict — do not infer RC4 from the absence of AES.

   | Observation | Meaning |
   |---|---|
   | `0x17` (RC4) | A classic roasting indicator on a modern domain |
   | `0x11` or `0x12` (AES) | **Proves nothing.** Requesting AES is the standard single-flag bypass of every RC4 rule |
   | Options `0x40800000`, or any non-default value | Non-standard tooling, or an attempt at OPSEC bypass |
   | Options `0x40810000` or `0x40810010` | **Proves nothing.** Rubeus `/opsec` injects these exact flags precisely so the request looks native |

   **Test for an RC4 downgrade.** If RC4 was issued *and* the `msDS-SupportedEncryptionTypes` attribute on `${SERVICE_ACCOUNT}` enforces AES — read it through `ad-mcp` — then the attacker forced a successful downgrade against a hardened account. Escalate: this is active exploitation of a misconfiguration, not routine legacy traffic. If `ad-mcp` is unavailable, mark the check UNRESOLVED.

   **Run the gMSA check against the TARGET, never the requester.** If `${SERVICE_ACCOUNT}` is a Group Managed Service Account, a roastable ticket for it should **never** occur, because a gMSA password is 240 characters, machine-generated, and not crackable. Its appearance therefore indicates either a misconfiguration or an attack, and you should escalate. A requester whose name ends in `$` is *not* this check — machine accounts requesting tickets are routine noise.

### Phase 2 — Behavioral Baselining

> **Reason first:** Is this account's relationship with this SPN **old**, meaning established, or merely **frequent**, which an attacker can manufacture in a couple of weeks?

7. **Establish the history for this requester and SPN pair.**

   | | |
   |---|---|
   | `source` | `${LOG_SOURCE}` |
   | `filter` | `F_EVENT_CODE` = `4769`; `F_LOG_NAME` = `Security` |
   | `filter` | `F_ACCOUNT` = `${REQUESTER_ACCOUNT}`; `F_SPN` matches `${TARGET_SPN}` |
   | `time` | full retention → `${T0}` |
   | `aggregate` | `access_count = COUNT()`, `first_seen = MIN(F_TIME)` group by `F_ACCOUNT`, `F_SPN` |

   **Capture:** `HISTORICAL_ACCESS_COUNT`, measured over `${BASELINE_DAYS}`; `FIRST_SEEN`; and `RETENTION_START`, which you established in Phase 0.

   **Set `BASELINE_ANOMALOUS = true` if any of the following hold:**
   - `access_count` is `0`.
   - `access_count` is below `3` across `${BASELINE_DAYS}`.
   - **`FIRST_SEEN` is later than `${T0} - ${BASELINE_DAYS}d`**, meaning the account has no history with this SPN predating the window. **This is your low-and-slow discriminator.** An attacker requesting one ticket per day for fifteen days accumulates an access count of 15 and passes any count threshold, but their first-seen timestamp is only fifteen days old, whereas a genuine consumer of the SPN would have months of history behind them. A count can be manufactured; a first-seen date cannot.
   - You observed `F_STATUS` = `0xE` in Step 4.

   **The retention caveat governs the rule above.** `FIRST_SEEN` is meaningful only when it falls materially later than `RETENTION_START`. If the two are close, the history is simply truncated by retention rather than genuinely absent, so fall back to the count rules and mark first-seen UNRESOLVED. **If retention is shorter than `${BASELINE_DAYS}`, `BASELINE_ANOMALOUS` cannot resolve to `false` at all** — it is UNRESOLVED. Record the true window alongside the finding.

8. **Measure the campaign shape across all SPNs, with noise filtering applied.** Step 7 is scoped to a single SPN and is therefore blind to spraying.

   | | |
   |---|---|
   | `filter` | `F_EVENT_CODE` = `4769`; `F_ACCOUNT` = `${REQUESTER_ACCOUNT}` |
   | `exclude` | `EXCLUDE_NOISE` |
   | `time` | `${T0} - ${BASELINE_DAYS}d` → `${T0}` |
   | `aggregate` | `COUNT()`, `COUNT DISTINCT F_SPN` group by day |

   **Capture:** `DISTINCT_DAYS`, the number of days on which at least one request occurred; `UNIQUE_SPNS_BASELINE`, the count of distinct SPNs requested; and `MAX_DAILY`, the largest single-day count.

   **The low-and-slow shape is** `DISTINCT_DAYS >= 3` **and** `UNIQUE_SPNS_BASELINE > ${VOLUME_THRESHOLD}` **and** `MAX_DAILY <= 3`: broad coverage of SPNs, a deliberately thin per-day rate, sustained over time. No single-window threshold can see it. Note that days and per-day rate are *different axes* — a predicate that measures both on the same axis can never fire.

9. **Decide the anomaly.**

   | Result | Do this |
   |---|---|
   | **MATCH** — established history, meaning a count of 3 or more *and* a first-seen date predating the window | Continue to Phases 3 and 4 regardless. An account with a legitimate relationship to *this* SPN may still be spraying others. **Do not short-circuit to a false positive here** |
   | **MISMATCH** — no established history | Treat as a Kerberoasting indicator and continue |
   | **UNRESOLVED** — a retention gap or selective ingest | Document the gap and continue. This state never resolves to benign |

### Phase 3 — Precursor Analysis: SPN Provenance (Targeted Kerberoasting)

A roastable SPN is a **precondition** of this attack, not a product of it. Where that SPN came from therefore decides the case: it either pre-existed, belonging to a service account and possibly misconfigured, or an attacker wrote it minutes beforehand, which is the deliberate T1098.003 → T1558.003 chain. Establish its **provenance** by correlating back to the antecedent 5136 write.

> **Reason first:** Before you hunt, ask whether this source could show you an SPN injection at all. Deciding that after a null result is how a visibility gap turns into an exoneration.

10. **Assess 5136 visibility before you trust any negative.** Event 5136 requires both the *Audit Directory Service Changes* subcategory **and a SACL on the object or attribute**. The subcategory can be enabled domain-wide and 5136 will still never fire for `servicePrincipalName` if no SACL covers it.

    Probe with `F_EVENT_CODE` = `5136`, a `time` window of `${T0} - 30d` to `${T0}`, and an `aggregate` of `COUNT()`, `COUNT DISTINCT F_ATTR_NAME`, and `COUNT DISTINCT F_OBJECT_DN`.

    | Probe result | `SPN_AUDIT_COVERAGE` |
    |---|---|
    | No 5136 events at all | `NONE` — a total visibility gap |
    | 5136 present, but never for `servicePrincipalName` | `NO_SPN_SACL` — the **partial-SACL case**; a Step 11 negative would be meaningless |
    | `servicePrincipalName` seen on other objects, but none in the target's OU | `PARTIAL` — a negative is weak; state which scope is uncovered |
    | `servicePrincipalName` covered across the target's scope | `COVERED` — a Step 11 negative is real evidence |

    **A Step 11 negative counts as evidence only when coverage is `COVERED`.** In every other state it is UNRESOLVED. "The attacker did not inject an SPN" and "we cannot see SPN injections" are different findings, and conflating them manufactures false negatives.

11. **Correlate to the antecedent SPN write.** **Do not scope by `${DC_HOSTNAME}`** — the write may have landed on a different DC than the one that issued the ticket.

    | | |
    |---|---|
    | `filter` | `F_EVENT_CODE` = `5136`; `F_LOG_NAME` = `Security` |
    | `filter` | `F_ATTR_NAME` = `servicePrincipalName`; `F_ATTR_VALUE` matches `${TARGET_SPN}` (Step 4 normalization) |
    | `time` | `${T0} - ${TIME_FRAME_HOURS}h` → `${T0}` |
    | `fields` | `F_TIME`, `F_ACTOR`, `F_OBJECT_DN`, `F_ATTR_NAME`, `F_ATTR_VALUE`, `F_OP_TYPE`, `F_HOST` |
    | `sort` / `limit` | `F_TIME` DESC / `50` |

    **Capture:** `SPOOF_ACTOR`, the account that performed the modification; `SPOOF_OBJECT_DN`, which Step 13 needs and which also identifies `${SERVICE_ACCOUNT}`; `SPOOF_VALUE`, the injected SPN; and `SPOOF_OPERATION`.

    **Account for paired events.** Windows typically emits an attribute change as a **pair**: a delete of the old value followed by an add of the new one. Do not read a lone delete as cleanup without checking for its paired add. Conversely, an add with no preceding delete is a genuinely new SPN on the object.

    **Targeted Kerberoasting is confirmed if** `servicePrincipalName` was added to a non-service account shortly before the TGS request, and especially if a delete followed.

    **If the result is negative,** document it and **qualify it with `SPN_AUDIT_COVERAGE`.** Only `COVERED` entitles you to write "no precursor found; this weakens the targeted hypothesis." In any other coverage state, write "UNRESOLVED — no SACL coverage; the hypothesis is untested."

12. **Corroborate the ACL. This is the strongest targeted signal available.** Proving that `SPOOF_ACTOR` — or `${REQUESTER_ACCOUNT}` — holds `GenericWrite`, `GenericAll`, or `WriteProperty` over `SPOOF_OBJECT_DN` turns "an SPN changed" into "this principal had the means to change it, and used them."
    - **Primary:** read the DACL on `SPOOF_OBJECT_DN` through `ad-mcp`, and capture `ACL_RIGHTS` together with the trustee.
    - **SIEM fallback:** hunt for 5136 modifications of `nTSecurityDescriptor` on `SPOOF_OBJECT_DN` within the window. An ACL grant immediately before the SPN write is itself evidence of privilege staging.
    - **If neither resolves,** set `ACL_RIGHTS` to UNRESOLVED. This **weakens but never negates** an injection finding: the injection is the proof, and the ACL only explains the mechanism.

13. **Detect cleanup and pivot account creation.**
    - **Cleanup:** re-run the Step 11 spec with `F_OP_TYPE` set to value-deleted, a `time` window of `${T0}` to `${T0} + ${TIME_FRAME_HOURS}h`, sorted ascending. Capture `CLEANUP_ACTOR` and `CLEANUP_TIME`. If a delete follows the TGS request within minutes, and it is not merely the delete half of a paired modification, the attacker covered their tracks: treat as Confirmed Critical at the highest priority.
    - **Pivot:** if `SPOOF_OBJECT_DN` is a recently created object, hunt for its creation event — 4720 for a user, 4741 for a computer — by the same `SPOOF_ACTOR` within the window. A standard user who creates an account and immediately adds an SPN to it is a strong indicator of targeted Kerberoasting.

### Phase 4 — Impact & Scope Assessment

> **Reason first:** There are two questions here, and conflating them loses one of them. **Breadth:** how many *other* SPNs did this principal touch? **Depth:** was the credential actually used?

14. **Measure volume and encryption. `EXCLUDE_NOISE` is mandatory here** — without it you are measuring ordinary workstation traffic, and the threshold below becomes meaningless.

    | | |
    |---|---|
    | `filter` | `F_EVENT_CODE` = `4769`; `F_ACCOUNT` = `${REQUESTER_ACCOUNT}` |
    | `exclude` | `EXCLUDE_NOISE` |
    | `time` | `${T0} - 4h` → `${T0} + 4h` |
    | `fields` | `F_TIME`, `F_ACCOUNT`, `F_SPN`, `F_ENC_TYPE`, `F_TICKET_OPTS`, `F_CLIENT_IP` |
    | `aggregate` | `COUNT()`, `COUNT DISTINCT F_SPN` — prefer platform-side counting |
    | `sort` / `limit` | `F_TIME` ASC / `1000` |

    **Capture:** `TOTAL_TICKETS`; `UNIQUE_SPNS`, counted **over the densest 4-hour window** rather than the full 8-hour span; and `RC4_COUNT` and `AES_COUNT`, classified using the encoding you confirmed in Phase 0. **If `F_ENC_TYPE` is the lossy `algorithm_id`, `RC4_COUNT` is not computable** — that enum has no RC4 value. Report both counts UNRESOLVED rather than reporting `RC4_COUNT = 0`, which would read as "no RC4 seen" when it means "RC4 is unrepresentable here." `TOTAL_TICKETS` and `UNIQUE_SPNS` are unaffected and still carry rule 4.

    **The volumetric indicator is** `UNIQUE_SPNS > ${VOLUME_THRESHOLD}` **within any 4-hour window**, requested by an account that neither ends in `$` nor appears in the suppression list. The ±4-hour span exists to give you context; the threshold itself is a 4-hour measure, so do not evaluate it across the full span.

    **Watch the limit.** If the result set reaches `limit`, your volume finding is a **floor, not a total**. Say so explicitly, and use the platform-side aggregate to obtain the true count.

15. **Confirm downstream credential use.**
    - **15a — the cracked service account.** Skip this if `${SERVICE_ACCOUNT}` is UNRESOLVED, and note the gap. Query `F_EVENT_CODE` = `4624` with `F_ACCOUNT` (**using the 4624 binding**) = `${SERVICE_ACCOUNT}`, over `${T0}` to `${T0} + ${TIME_FRAME_HOURS}h`, projecting `F_TIME`, `F_ACCOUNT`, `F_CLIENT_IP`, `F_HOST`, and `F_LOGON_TYPE`, limit `200`. **Impact threshold:** a successful logon as `${SERVICE_ACCOUNT}` after the TGS request — particularly from `CLIENT_IP` or from a host associated with the requester — means the ticket was cracked offline and the credential used. **Escalate to Critical.**
    - **15b — the requester.** Run the same spec with `F_ACCOUNT` = `${REQUESTER_ACCOUNT}` to map the attacker's own sessions and source hosts.
    - **15c — explicit credential use (4648).** A cracked account is typically used *from* a session that is already logged on, which surfaces as 4648 rather than as a fresh 4624. Query with `F_ACCOUNT` (using the 4648 binding) = `${SERVICE_ACCOUNT}`, projecting `F_TIME`, `F_ACTOR`, `F_HOST`, and `F_CLIENT_IP`. **`F_ACTOR` is your pivot:** it names whoever wielded the credential — frequently the requester, and occasionally a third account, which widens the scope of the campaign.
    - **15d — Pass-the-Ticket.** Re-run the Step 7 spec for `${TARGET_SPN}` with **no requester filter**, over `${T0}` to `${T0} + ${TIME_FRAME_HOURS}h`. A different principal requesting the same SPN shortly afterwards suggests the ticket was reused across accounts. Treat this as corroboration and scope expansion only, since shared consumption of a service is also routine.

16. **Corroborate against endpoint telemetry.** This step is optional; run it if 4688 is available. Query `F_EVENT_CODE` = `4688` on the hosts identified from `CLIENT_IP` and Step 15b, over `${T0} - 4h` to `${T0} + 1h`, projecting `F_TIME`, `F_HOST`, `F_ACTOR`, and `F_PROCESS`. Look for roasting and enumeration tooling — Rubeus, Orpheus, `Invoke-Kerberoast`, `setspn.exe -Q` — and for renamed binaries. **A negative here carries little weight**, because tooling is routinely renamed, run in memory, or executed from an unmanaged host. Use this as corroboration only; it is never exculpatory.

    **Note the early-warning signals.** Roasting is preceded by an enumeration phase: LDAP queries for accounts carrying a `servicePrincipalName`, or `setspn.exe -Q */*`. Where those events are available, they place the campaign's start earlier than `${T0}`. Record whether they are present or absent, and if they are absent, recommend LDAP-enumeration monitoring in the handoff.

### Phase 5 — Enrichment, Verdict & Handoff

17. **Enrich the indicators.** Run `common_steps/enrich_ioc.md` against `${REQUESTER_ACCOUNT}`, the requesting host, and `CLIENT_IP`. Check for related cases through `common_steps/find_relevant_soar_case.md`.

18. **Render the verdict** using the precedence rules below, where the **first matching rule wins**. Document every query in its resolved dialect form, together with the bindings you used. Label every negative result as either a true negative or a visibility gap.

19. **Hand off.**

    > **⚠ STOP — the AD-abuse IRP (`ad_abuse_response.md`) does not exist.** There is no procedure and no human-approval gate standing behind the recommendations below. **Execute none of them.** Post the package to the case, escalate it, and assign it to a **named human analyst**. Because the IRP is missing, so is the approval gate that would authorize containment — which makes acting on these recommendations yourself *more* dangerous, not less.

    **Containment package — recommendations only.** Reset the `${SERVICE_ACCOUNT}` password; review and remove unauthorized SPNs; audit `GenericWrite` and `GenericAll` permissions on `SPOOF_OBJECT_DN`; enforce AES-only encryption through `msDS-SupportedEncryptionTypes`; migrate to gMSAs where possible; and close the visibility gaps you found, which may include enabling SACLs for `servicePrincipalName`, deploying decoy SPNs, and monitoring LDAP enumeration.

20. **Complete the case.** Emit a Mermaid sequence diagram of the actions you actually took. Record the execution date and time, and the token usage or runtime if it is available.

## Verdict Precedence Rules

**Evaluate these in order; the first matching rule is your verdict.** Several of the conditions are individually decisive, and must not be averaged against one another.

| # | Condition | Verdict |
|---|---|---|
| 1 | `DECOY_HIT` is true | **Confirmed Critical — Decoy SPN Access.** There is no false-positive path here; invoke the IRP immediately |
| 2 | An SPN injection **and** a cleanup were found | **Confirmed Critical — Targeted Kerberoasting with Cleanup.** Highest priority |
| 3 | An SPN injection was found | **Confirmed Critical — Targeted Kerberoasting** |
| 4 | `UNIQUE_SPNS` exceeds `${VOLUME_THRESHOLD}` within any 4-hour window, noise-filtered | **True Positive — Volumetric Kerberoasting** |
| 5 | The low-and-slow shape from Step 8 is present | **True Positive — Throttled Kerberoasting** |
| 6 | An RC4 downgrade against an AES-enforced account, or `0xE`, or a gMSA target | **True Positive — Encryption Abuse** |
| 7 | `BASELINE_ANOMALOUS` is true, with no injection and no volume | **Suspicious — Anomalous Access.** Escalate to T2 |
| 8 | Any input above is UNRESOLVED (retention, `SPN_AUDIT_COVERAGE` other than `COVERED`, selective ingest, an unbindable field, **or an encryption analysis that was lossy rather than absent**) | **Suspicious — Insufficient Visibility.** Escalate to T2 and record the specific gap. **Never close a gap as a false positive** |
| 9 | `BASELINE_ANOMALOUS` is false, and every check resolved and came back negative | **False Positive.** Close as NOT_MALICIOUS and document the checks that resolved |

**The order carries meaning.** Rules 2 and 3 outrank the baseline, so a confirmed injection is never downgraded by a matching or unresolved baseline. Rules 4 and 5 do the same, because an account with a legitimate history against `${TARGET_SPN}` that is simultaneously spraying fifty others is compromised, not a false positive. Rule 8 deliberately sits above rule 9: an unresolved check is not a passed check.

## Quality Gates

| Phase | Gate | Stop condition |
|---|---|---|
| 0 | `${LOG_SOURCE}`, per-class bindings, value encodings, and retention all confirmed; decoy list checked | You cannot proceed without the bindings |
| 1 | 4769 found; `${SERVICE_ACCOUNT}` resolved or the gap recorded; gMSA checked **against the target** | If no 4769 survives the binding and normalization re-check, stop and escalate |
| 2 | `FIRST_SEEN` and the count resolved against true retention; campaign shape computed | If retention is shorter than `${BASELINE_DAYS}`, the result is UNRESOLVED, never `false` |
| 3 | `SPN_AUDIT_COVERAGE` assessed **before** the hunt; ACL corroboration attempted | A negative is acceptable only when qualified by the coverage state |
| 4 | Volume measured **with `EXCLUDE_NOISE`**; downstream authentication checked on `${SERVICE_ACCOUNT}` | Negatives are acceptable, but you must document them |
| 5 | Verdict rendered by precedence; queries, bindings, and suppressions documented | An incomplete audit trail means an incomplete investigation |

## Required Output

| Output | Content |
|---|---|
| **Verdict** | The number of the precedence rule that matched, with the supporting evidence |
| **Field bindings** | Your per-class map from logical name to concrete path, with the value encodings |
| **Visibility statement** | The retention window, `SPN_AUDIT_COVERAGE`, any unbindable fields, and any suppressed accounts — everything the verdict could not see |
| **Timeline** | The ordered chain: ACL grant, 5136 injection, 4769 TGS request, 5136 cleanup, 4624 or 4648 credential use |
| **Key entities** | `SPOOF_ACTOR`, `SPOOF_OBJECT_DN`, `${REQUESTER_ACCOUNT}`, `${SERVICE_ACCOUNT}`, `${TARGET_SPN}`, the encryption type, and `CLIENT_IP` |
| **Blast radius** | The accounts and services touched using the cracked credential |
| **Containment recommendation** | As listed in Step 19 — recommendations only, never executed |
| **Sequence diagram** | A Mermaid diagram of the actions you actually took |
| **Execution metadata** | Date and time, plus token usage or runtime if available |

Produce structured output only. No internal monologue. Facts only.

## Critical Failures (Automatic)

- Declaring Kerberoasting confirmed **without** demonstrating either the baseline anomaly or the 5136 modification.
- Closing a request for a **spoofed high-value SPN**, or for **any decoy SPN**, as a false positive.
- Closing as a false positive on the basis of **AES encryption alone**, or of **default-looking Ticket Options alone**. Both are single-flag bypasses.
- Closing as a false positive on a **visibility gap** — an absent field, missing SACL coverage, short retention, or selective ingest — by treating it as a true negative.
- Reporting a volume or discovery finding **without applying `EXCLUDE_NOISE`**, or suppressing an account without naming it in the case.
- Running the gMSA check against the **requester** rather than the target service account.
- Executing any containment action from this read-only runbook.
- Reporting a 5136 or 4769 event that is not present in the logs.
- **Using a vendor field path you did not bind in Phase 0.**

---

## Appendix A: Query Spec → Dialect Translation

The Phase 1 anchor spec (Step 4), translated. Substitute your Phase 0 bindings; the same shape applies to every spec in this runbook. **All windows anchor on `${T0}`, never on `now`** — that is the most common translation error.

**ES|QL**
```
FROM ${LOG_SOURCE}
| WHERE ${F_EVENT_CODE} == "4769" AND ${F_LOG_NAME} == "Security"
| WHERE ${F_ACCOUNT} == "${REQUESTER_ACCOUNT}"
| WHERE ${F_SPN} LIKE "${TARGET_SPN}*"
| WHERE ${F_TIME} >= TO_DATETIME("${T0}") - ${TIME_FRAME_HOURS} hours
    AND ${F_TIME} <= TO_DATETIME("${T0}") + 1 hour
| KEEP ${F_TIME}, ${F_HOST}, ${F_ACCOUNT}, ${F_SPN}, ${F_ENC_TYPE}, ${F_TICKET_OPTS}, ${F_CLIENT_IP}, ${F_STATUS}
| SORT ${F_TIME} DESC
| LIMIT 50
```

**SPL** — pass `${T0}`-relative bounds; `-24h` is relative to now.
```
index=${LOG_SOURCE} ${F_EVENT_CODE}=4769 ${F_LOG_NAME}="Security"
  ${F_ACCOUNT}="${REQUESTER_ACCOUNT}" ${F_SPN}="${TARGET_SPN}*"
  earliest=${T0_EPOCH}-${TIME_FRAME_HOURS}*3600 latest=${T0_EPOCH}+3600
| table ${F_TIME} ${F_HOST} ${F_ACCOUNT} ${F_SPN} ${F_ENC_TYPE} ${F_TICKET_OPTS} ${F_CLIENT_IP} ${F_STATUS}
| sort - ${F_TIME} | head 50
```

**KQL** — `=~` is case-insensitive equality; use it to honor the SPN/account normalization rule.
```
${LOG_SOURCE}
| where ${F_EVENT_CODE} == 4769 and ${F_LOG_NAME} == "Security"
| where ${F_ACCOUNT} =~ "${REQUESTER_ACCOUNT}"
| where ${F_SPN} startswith "${TARGET_SPN}"
| where ${F_TIME} between (datetime("${T0}") - ${TIME_FRAME_HOURS}h .. datetime("${T0}") + 1h)
| project ${F_TIME}, ${F_HOST}, ${F_ACCOUNT}, ${F_SPN}, ${F_ENC_TYPE}, ${F_TICKET_OPTS}, ${F_CLIENT_IP}, ${F_STATUS}
| sort by ${F_TIME} desc | take 50
```

**Query DSL (OpenSearch / Wazuh)**
```json
{ "size": 50,
  "query": { "bool": { "filter": [
    { "term":   { "${F_EVENT_CODE}": "4769" } },
    { "term":   { "${F_LOG_NAME}": "Security" } },
    { "term":   { "${F_ACCOUNT}": "${REQUESTER_ACCOUNT}" } },
    { "prefix": { "${F_SPN}": { "value": "${TARGET_SPN}", "case_insensitive": true } } },
    { "range":  { "${F_TIME}": { "gte": "${T0}||-${TIME_FRAME_HOURS}h", "lte": "${T0}||+1h" } } } ] } },
  "_source": ["${F_TIME}","${F_HOST}","${F_ACCOUNT}","${F_SPN}","${F_ENC_TYPE}","${F_TICKET_OPTS}","${F_CLIENT_IP}","${F_STATUS}"],
  "sort": [ { "${F_TIME}": "desc" } ] }
```

**`EXCLUDE_NOISE`** — required by Steps 8 and 14:

| Platform | Construct |
|---|---|
| ES\|QL | `\| WHERE NOT (${F_SPN} IN ("krbtgt","Dns") OR ${F_SPN} LIKE "*$" OR ${F_ACCOUNT} LIKE "*$")` |
| SPL | `NOT ${F_SPN} IN ("krbtgt","Dns") NOT ${F_SPN}="*$" NOT ${F_ACCOUNT}="*$"` |
| KQL | `\| where ${F_SPN} !in~ ("krbtgt","Dns") and ${F_SPN} !endswith "$" and ${F_ACCOUNT} !endswith "$"` |
| DSL | `"must_not": [ {"terms":{"${F_SPN}":["krbtgt","Dns"]}}, {"wildcard":{"${F_SPN}":"*$"}}, {"wildcard":{"${F_ACCOUNT}":"*$"}} ]` |

**Aggregation** — Step 7 (`COUNT()` + `MIN(F_TIME)` by `F_ACCOUNT`, `F_SPN`):

| Platform | Construct |
|---|---|
| ES\|QL | `\| STATS access_count = COUNT(), first_seen = MIN(${F_TIME}) BY ${F_ACCOUNT}, ${F_SPN}` |
| SPL | `\| stats count AS access_count, min(_time) AS first_seen BY ${F_ACCOUNT}, ${F_SPN}` |
| KQL | `\| summarize access_count = count(), first_seen = min(${F_TIME}) by ${F_ACCOUNT}, ${F_SPN}` |
| DSL | `"aggs": { "by_account": { "terms": {"field":"${F_ACCOUNT}"}, "aggs": { "first_seen": {"min":{"field":"${F_TIME}"}} } } }` |

If your platform is not listed, translate the spec using the same contract — the investigation logic is unchanged.
