---
title: "Runbook: Persistence - Empire Scheduled Task Creation (Standard User)"
type: "runbook"
category: "security_operations"
status: "active"
platform: "windows"
siem: "any"
schema: "ocsf"
ocsf_version: "1.3.0"
mcp: "siem-mcp"
access: "read_only"
attack_technique: "Scheduled Task/Job: Scheduled Task / T1053.005"
mitre: "T1053.005"
---

# Runbook: Persistence - Empire Scheduled Task Creation (Standard User)

## Purpose
Execute a standardized investigation procedure for suspected Scheduled Task persistence (T1053.005), specifically focusing on creations by a standard user leveraging the Empire framework. Given the alert, you will validate the task creation, baseline the requester's history with task creation, establish the provenance of the parent process, assess the impact and payload, and produce a verdict with evidence — without executing containment actions.

Do not rely on static signatures. Standard users, software installers, and IT administrators legitimately create and update scheduled tasks as part of routine operations. Static threshold rules generate too much noise. The agent must use Contextual Baselining and Reverse Tracing to determine malicious intent.

## Scope
**In scope:**
- Scheduled task creation and modification by standard users (Event 4698, 4702).
- Sysmon process creation for `schtasks.exe` (Event 1, 4688).
- Behavioral baselining of the user's history of creating scheduled tasks on the target host.
- Reverse tracing to identify anomalous parent processes (e.g., PowerShell spawning `schtasks.exe`).
- Payload analysis (e.g., base64 encoded PowerShell cradles).
- Verdict determination and handoff for containment.

**Out of scope:**
- Immediate containment or task removal — the IRP owns these.
- Advanced API-based task creation that does not spawn `schtasks.exe` or generate 4698/4702 (requires file monitoring).

## Inputs
| Parameter | Required | Description |
| --- | --- | --- |
| `${ALERT_ID}` / `${CASE_ID}` | Yes | Triggering alert or case |
| `${USER_ACCOUNT}` | Yes | Account that created the scheduled task (e.g., `GALACTIC\jdoe`) |
| `${HOST_NAME}` | Yes | The target host where the task was created |
| `${TASK_NAME}` | No | The name of the scheduled task |
| `${T0}` | Yes | Alert timestamp — anchor for every relative window (derive in Step 1) |
| `${TIME_FRAME_HOURS}` | No | Correlation window either side of `${T0}` (default `4`) |
| `${LOG_SOURCE}` | No | Bind in Phase 0 |
| `${BASELINE_DAYS}` | No | Established-history window (default `30`) |

## Tools
| Tool | Purpose | Access |
| --- | --- | --- |
| `siem-mcp` | `list_sources`, `get_schema`, `search` | Read-only |
| `case-mgmt` | Comments, escalation, priority | Write (case metadata only) |
| `common_steps/*` | IOC enrichment, documentation, closure | Varies |

`search` must support filtering, field projection, time bounds, sorting, limits, and `COUNT` / `COUNT DISTINCT` / `MIN` aggregation with grouping.

## Rules
1. **Reasoning.** Each phase opens with a *Reason first* prompt. Answer it in the case comment before you run that phase's queries.
2. **Falsifiability.** Name what would change your mind before each phase. If no result could falsify your hypothesis, you are confirming rather than investigating.
3. **No Inference.** Never infer a field you did not read. A field you could not read is `UNRESOLVED`, not a value. Label every negative as either *did not happen* or *cannot see*.
4. **Query budget.** Phase 0: 4 · Phase 1: 3 · Phase 2: 3 · Phase 3: 5 · Phase 4: 4 · 19 in total.
5. **Tool failures.** Every failure below degrades the affected check to `UNRESOLVED`.
   - `search` times out: Retry once with halved window.
   - `get_schema` unavailable: Fall back to `limit 1` discovery query.
6. **Query specs.** Each retrieval step is written as a declarative table: `source` · `filter` · `exclude` · `time` · `fields` · `aggregate` · `sort` / `limit`. Translate each spec into your platform's dialect using Appendix A.

## Field Bindings
Anchor every query on the native Windows event code (`F_EVENT_CODE`). Do not anchor on `class_uid` alone.

| Event | ID | Used in |
| --- | --- | --- |
| Scheduled task created | 4698 | P1, P2 |
| Scheduled task updated | 4702 | P1, P2 |
| Process creation | Sysmon 1 / 4688 | P3, P4 |
| TaskScheduler Action Started | 200 | P4 |

**OCSF mapping, verified against v1.3.0 (schema.ocsf.io):**
- Event 4698 and 4702 map to **Scheduled Job Activity**, `class_uid 1006`.
- Process creation (Sysmon 1 / 4688) maps to **Process Activity**, `class_uid 1007`.

**Important Note:** Command line arguments, raw XML definitions, and process paths often lack canonical mapping across SIEMs. You must rely on `unmapped.*` or `raw_data` if standard OCSF fields (like `cmd_line` or `process.cmd_line`) are empty or unavailable. For 4698, the payload is in the XML `<Command>` and `<Arguments>` nodes. For Sysmon 1, it is in the `/tr` parameter.

Bind each logical name separately for each event class:

| Logical name | Class | Target | Candidates (in order) |
| --- | --- | --- | --- |
| `F_TIME` | all | Timestamp | `time` → `time_dt` → `@timestamp` |
| `F_EVENT_CODE` | all | Windows Event ID | `metadata.event_code` → `unmapped.EventID` → `EventCode` |
| `F_LOG_NAME` | all | Channel | `metadata.log_name` → `unmapped.Channel` |
| `F_HOST` | all | Host | `device.hostname` → `unmapped.Computer` |
| `F_ACCOUNT` | 4698/4702 | Task Creator | `actor.user.name` → `user.name` → `unmapped.SubjectUserName` |
| `F_ACCOUNT` | Sysmon 1 | Process User | `actor.user.name` → `user.name` → `unmapped.User` |
| `F_TASK_NAME` | 4698/4702 | Task Name | `job.name` → `unmapped.TaskName` |
| `F_TASK_XML` | 4698/4702 | Task Definition | `unmapped.TaskContent` → `raw_data` |
| `F_PROCESS` | Sysmon 1 | Process name | `process.name` → `unmapped.Image` |
| `F_PARENT_PROCESS` | Sysmon 1 | Parent Process | `process.parent.name` → `unmapped.ParentImage` |
| `F_COMMAND_LINE` | Sysmon 1 | Command Line | `process.cmd_line` → `unmapped.CommandLine` |

## Noise Filtering (`EXCLUDE_NOISE`)
Scheduled tasks are heavily used for routine operations. When assessing volume or baseline, exclude known administrative tasks.

| Exclude | Why |
| --- | --- |
| `F_ACCOUNT` ending in `$` | Machine accounts creating tasks is routine system noise |
| `F_ACCOUNT` is `SYSTEM` or `NT AUTHORITY\*` | Routine system maintenance tasks |
| `F_PARENT_PROCESS` is `msiexec.exe` or `trustedinstaller.exe` | **(Process Activity only)** Legitimate software installations |
| `F_TASK_NAME` matches `\Microsoft\Windows\*` or `\OneDrive*` | **(Scheduled Job Activity only)** Built-in OS and common app tasks |
| `F_TASK_XML` contains paths to legitimate known installers | **(Scheduled Job Activity only)** Legitimate software updates |

---

## Workflow

### Phase 0 — Context & Binding
**Reason first:** Which bindings, if you got them wrong, would silently produce a false negative?
1. Load the alert context. Call `case-mgmt.get_case_full_details(${ALERT_ID})` and extract `${USER_ACCOUNT}`, `${HOST_NAME}`, and `${T0}`.
2. Bind the fields. Call `list_sources` to bind `${LOG_SOURCE}`, then call `get_schema` and confirm where the process arguments or XML definitions are stored in the OCSF data (especially for `F_TASK_XML` and `F_COMMAND_LINE`).
**Gate:** Do not proceed without confirming the exact unmapped field paths for `CommandLine` and XML payloads. Run a `limit 1` discovery query if necessary.

### Phase 1 — Anchor on the Scheduled Task Creation
**Reason first:** Was the scheduled task actually created or updated by this user? Did you bind the correct XML or Command Line field to read the payload?

Retrieve the Task Creation/Update event.
| | |
| --- | --- |
| source | `${LOG_SOURCE}` |
| filter | `F_EVENT_CODE IN ('4698', '4702')` AND `F_LOG_NAME = 'Security'` |
| filter | `F_ACCOUNT = '${USER_ACCOUNT}'` AND `F_HOST = '${HOST_NAME}'` |
| time | `${T0} - 1h` → `${T0} + 1h` |
| fields | `F_TIME`, `F_HOST`, `F_ACCOUNT`, `F_TASK_NAME`, `F_TASK_XML` |
| sort / limit | `F_TIME DESC` / `5` |

**Capture:** `DC_TASK_NAME`, `DC_TASK_XML`. If 4698/4702 is absent, query Sysmon 1/4688 for `schtasks.exe /create`. If neither exists, document "no task creation found", stop and escalate.
**Analyze the Payload:** Extract the `<Command>` and `<Arguments>` from `F_TASK_XML` (or `/tr` from `F_COMMAND_LINE`). Look for encoded PowerShell cradles (`-enc`, `-ep bypass`), obscure LOLBins, or hidden window styles.

### Phase 2 — Behavioral Baselining
**Reason first:** Is this user routinely scheduling tasks on this host, or is this the first time?

Establish the history for this user by splitting the query into two logical retrievals to avoid mixing OCSF event classes (`class_uid` 1006 and 1007).

**Query A (Scheduled Job Activity):**
| | |
| --- | --- |
| source | `${LOG_SOURCE}` |
| filter | `F_EVENT_CODE IN ('4698', '4702')` AND `F_ACCOUNT = '${USER_ACCOUNT}'` |
| exclude | `EXCLUDE_NOISE` (Task Name / XML exclusions) |
| time | full retention → `${T0}` |
| aggregate | `task_access_count = COUNT()`, `first_seen_task = MIN(F_TIME)` group by `F_ACCOUNT`, `F_HOST` |

**Query B (Process Activity):**
| | |
| --- | --- |
| source | `${LOG_SOURCE}` |
| filter | `F_EVENT_CODE IN ('1', '4688')` AND `F_PROCESS = 'schtasks.exe'` AND `F_ACCOUNT = '${USER_ACCOUNT}'` |
| exclude | `EXCLUDE_NOISE` (Parent Process exclusions) |
| time | full retention → `${T0}` |
| aggregate | `proc_access_count = COUNT()`, `first_seen_proc = MIN(F_TIME)` group by `F_ACCOUNT`, `F_HOST` |

**Capture:** Sum both counts to derive `HISTORICAL_ACCESS_COUNT` over `${BASELINE_DAYS}`, and determine the earliest `FIRST_SEEN`. Document if either source has no retention.
Set `BASELINE_ANOMALOUS = true` if:
- `HISTORICAL_ACCESS_COUNT` < 3 across `${BASELINE_DAYS}`.
- `FIRST_SEEN` is later than `${T0} - ${BASELINE_DAYS}d` (meaning no prior history).

### Phase 3 — Reverse Trace: Provenance & Parent Process (Empire Execution)
**Reason first:** What process spawned the task creation? Does it look like an automated installer or a malicious framework (e.g., PowerShell)?

Identify the Parent Process and Command Line.
| | |
| --- | --- |
| filter | `F_EVENT_CODE IN ('1', '4688')` AND `F_PROCESS = 'schtasks.exe'` |
| filter | `F_ACCOUNT = '${USER_ACCOUNT}'` AND `F_HOST = '${HOST_NAME}'` |
| time | `${T0} - 1h` → `${T0}` |
| fields | `F_TIME`, `F_PARENT_PROCESS`, `F_COMMAND_LINE` |
| sort / limit | `F_TIME DESC` / `10` |

**Capture:** `SPOOF_PARENT_PROCESS`, `SPOOF_COMMAND_LINE`.
**Empire Signature Check:** Empire commonly leverages `powershell.exe` as the parent, executing `schtasks.exe /Create` with a `/TR` payload containing encoded cradles (e.g., `-ep bypass -w hidden -enc <Base64>`). If this matches, set `EMPIRE_SIGNATURE_HIT = true`.

### Phase 4 — Impact & Scope Assessment (Execution & Privilege Level)
**Reason first:** Did the task execute? What privilege level did it request?

**Determine Requested Privileges:** Analyze the command line for `/RU SYSTEM` or `/RL HIGHEST`. If a standard user successfully creates a task with these flags via a bypass or misconfiguration, they have achieved Privilege Escalation.

**Confirm Task Execution:**
| | |
| --- | --- |
| filter | `F_EVENT_CODE IN ('200', '1', '4688')` |
| filter | `F_HOST = '${HOST_NAME}'` AND `F_LOG_NAME IN ('Microsoft-Windows-TaskScheduler/Operational', 'Microsoft-Windows-Sysmon/Operational', 'Security')` |
| time | `${T0}` → `${T0} + ${TIME_FRAME_HOURS}h` |
| fields | `F_TIME`, `F_PROCESS`, `F_PARENT_PROCESS`, `F_COMMAND_LINE`, `F_TASK_NAME` |

**Analyze:** Look for TaskScheduler Event 200 (Action Started) followed immediately by Sysmon Event 1 for the payload process execution. If a reverse shell or anomalous process executes, the task was weaponized.

### Phase 5 — Enrichment, Verdict & Handoff
1. **Enrich:** Run `common_steps/enrich_ioc.md` against any external IPs or dropped binaries discovered in the payload.
2. **Render the verdict** using the precedence rules below.
3. **Hand off:** Make containment recommendations (disable user, isolate host, delete task). Post the package to the case and assign it. Do not execute containment.
4. **Complete the case:** Emit a Mermaid sequence diagram.

---

## Verdict Precedence Rules
| # | Condition | Verdict |
| --- | --- | --- |
| 1 | `EMPIRE_SIGNATURE_HIT` is true, or payload contains obfuscated reverse shell / malicious cradle. | **Confirmed Critical** — Malicious Persistence / Empire Deployment. |
| 2 | `BASELINE_ANOMALOUS` is true, and the task requests `/RU SYSTEM` or `/RL HIGHEST`. | **Confirmed High** — Attempted Privilege Escalation / Persistence. |
| 3 | `BASELINE_ANOMALOUS` is true, but parent process and payload point to a benign executable. | **Suspicious** — Anomalous Access. Escalate to T2. |
| 4 | Visibility fields (e.g., `CommandLine`, `ParentProcess`) are unmapped/missing, preventing intent verification. | **Suspicious** — Insufficient Visibility. Escalate to T2 and record the gap. |
| 5 | `BASELINE_ANOMALOUS` is false, the parent process is a known administrative tool, and payload is legitimate. | **False Positive**. Close as `NOT_MALICIOUS`. |

---

## Quality Gates
| Phase | Gate | Stop condition |
| --- | --- | --- |
| 0 | Bindings confirmed. | Do not proceed without confirming the exact unmapped field paths for `CommandLine` and XML payloads. |
| 1 | Task creation event located. | If no 4698/4702 or Sysmon 1 for `schtasks.exe` survives, stop and escalate. |
| 2 | Baseline measured against true retention. | You must document the exact historical task creation count (`access_count`). |
| 3 | Parent process resolved. | Stop and escalate if the parent process of `schtasks.exe` cannot be resolved. |
| 4 | Execution assessed. | Document explicitly whether the task executed successfully or failed. |

---

## Required Output
| Output | Content |
| --- | --- |
| **Verdict** | The number of the precedence rule that matched, with the supporting evidence |
| **Field bindings** | Your per-class map from logical name to concrete path |
| **Visibility statement** | Unbindable fields, retention gaps, or missing events |
| **Timeline** | The ordered chain: Parent process execution → Task creation → Payload execution |
| **Key entities** | `${USER_ACCOUNT}`, `${HOST_NAME}`, `SPOOF_PARENT_PROCESS`, the exact payload |
| **Containment recommendation** | Recommendations only, never executed |
| **Sequence diagram** | A Mermaid diagram of the actions you actually took |
| **Execution metadata** | Date and time |

---

## Critical Failures (Automatic)
- Closing a request containing Base64 encoded PowerShell cradles as a false positive.
- Declaring malicious persistence confirmed without verifying the parent process or payload.
- Closing as a false positive on a visibility gap (e.g., missing command lines) by treating it as a true negative.
- Executing any containment action from this read-only runbook.
- Using a vendor field path you did not bind in Phase 0.

---

## Appendix A: Query Spec → Dialect Translation

To maintain strict vendor agnosticism, the agent must translate the logical query specs into the native dialect of the connected SIEM. Below are examples for the Phase 3 Reverse Trace query.

### Elasticsearch / OpenSearch (ES|QL)
```sql
FROM ${LOG_SOURCE}
| WHERE ${F_EVENT_CODE} IN ("1", "4688")
| WHERE ${F_ACCOUNT} == "${USER_ACCOUNT}" AND ${F_HOST} == "${HOST_NAME}"
| WHERE ${F_PROCESS} == "schtasks.exe"
| WHERE ${F_TIME} >= TO_DATETIME("${T0}") - 1 hour
    AND ${F_TIME} <= TO_DATETIME("${T0}")
| KEEP ${F_TIME}, ${F_PARENT_PROCESS}, ${F_COMMAND_LINE}
| SORT ${F_TIME} DESC
| LIMIT 10
```

### Microsoft Sentinel (KQL)
```kusto
${LOG_SOURCE}
| where ${F_EVENT_CODE} in ('1', '4688')
| where ${F_ACCOUNT} == '${USER_ACCOUNT}' and ${F_HOST} == '${HOST_NAME}'
| where ${F_PROCESS} == 'schtasks.exe'
| where ${F_TIME} between (datetime("${T0}") - 1h .. datetime("${T0}"))
| project ${F_TIME}, ${F_PARENT_PROCESS}, ${F_COMMAND_LINE}
| order by ${F_TIME} desc
| take 10
```

### Splunk (SPL)
```splunk
index=${LOG_SOURCE} ${F_EVENT_CODE} IN ("1", "4688") 
    ${F_ACCOUNT}="${USER_ACCOUNT}" ${F_HOST}="${HOST_NAME}" 
    ${F_PROCESS}="schtasks.exe"
| eval _time_epoch=strptime("${T0}", "%Y-%m-%dT%H:%M:%S.%NZ")
| where ${F_TIME} >= (_time_epoch - 3600) AND ${F_TIME} <= _time_epoch
| table ${F_TIME}, ${F_PARENT_PROCESS}, ${F_COMMAND_LINE}
| sort - ${F_TIME}
| head 10
```
