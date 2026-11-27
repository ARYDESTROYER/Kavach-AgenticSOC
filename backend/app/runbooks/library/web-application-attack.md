---
id: web-application-attack
title: Web application attack
summary: A request against one of our web applications looks like an attack. Find out whether any request succeeded and whether the component is exposed.
use_when: A WAF, web server or application detection reports injection, path traversal, session abuse, a dangerous upload or a web shell.
prerequisites: WAF and web server logs with status codes and response sizes; the owner of the application.
version: 1
priority: 80
review_every_days: 180
mitre: [T1190]
applies_when:
  rule_ids: [modsecurity, modsec_audit_log, nginx, apache, web_app_endpoint_abuse, web_app_session_token_reuse, web_app_dangerous_file_upload, web_app_path_enumeration, web_app_privileged_admin_action, web_app_sensitive_data_access, suspicious_web_shell_execution]
retrieval_queries:
  - web application incident response
  - application session abuse
  - application administrative activity
references:
  - https://attack.mitre.org/techniques/T1190/
  - https://csrc.nist.gov/pubs/sp/800/61/r3/final
---

## Triage

### Requests from this source to the application {#source-requests kind=lookup}
Focus: which paths the source requested and which status codes it got back.

```lookup
tool: log_stats
filter:
  ip: "{{entity.ip}}"
group_by: [url.path, http.response.status_code]
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

Paths and status codes come from the ECS fields `url.path` and `http.response.status_code`. A source that names them differently shows the count without them.

### Did any request succeed (2xx or unusual size)? {#request-succeeded kind=check evidence=note}
Focus: status codes, response sizes and paths that differ from the blocked requests.
Escalate if: an attack request returned 2xx with an unusual size, or a file was written or run on the server.
Benign if: every request was blocked or returned an error, with normal response sizes.

## Investigate

### Reputation of the source {#source-reputation kind=lookup}
Focus: known scanners, hosting providers and hostile addresses.

```lookup
tool: enrich
indicator: "{{entity.ip}}"
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

### Is the targeted component vulnerable to this attack? {#component-vulnerable kind=check evidence=note}
Focus: the application, version and patch level behind the targeted path.
Escalate if: the component is unpatched for the technique, or the request reached an admin or upload endpoint.
Benign if: the component is not affected, or a WAF rule blocks the technique.

### Exploited, attempted or benign? {#decide kind=decision}
Escalate if: confirmed account misuse, destructive administration, an executable upload or lasting impact on the service.
Benign if: automation or scanning with no successful request and no impact.
Options:
- exploited: Exploited
- attempted: Attempted, not successful | skips: patch-component
- benign: Benign | skips: block-source, patch-component

Recording a decision does not change the verdict or close the case.

## Contain

### Block the source or request a WAF rule {#block-source kind=action optional react=RA3101}
Block the source, or ask for a WAF rule against the technique. Record the change reference.

### Patch or take the component offline when exploited {#patch-component kind=action}
Patch the component, or take it offline with the application owner until it is fixed.

## Close and learn

### Record the outcome and what you would change {#record-outcome kind=record}
Write what was attempted, what worked, and what would have stopped it earlier.
