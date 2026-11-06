---
id: web_attack
title: Web application attack (WAF / ModSecurity)
applies_to_rules: [modsecurity, modsec_audit_log, nginx, apache]
applies_to_techniques: [T1190]
applies_to_entities: [ip]
keywords: [modsec, waf, sqli, xss, lfi, rfi, traversal, owasp, http, web, "941"]
persona: web_application
summary: A WAF/ModSec rule fired on a request to a public-facing web app.
---
SIGNAL
A web application firewall flags a request for injection, traversal, file inclusion, or another exploit pattern.

EVIDENCE REQUIRED
Request path and payload, response status and size, enforcement action, client history, target asset, and follow-on application activity.

INVESTIGATION STEPS
1. Confirm whether the firewall blocked the request or the application processed it.
2. Determine whether the payload is generic scanner traffic or crafted for the target.
3. Correlate the client across endpoints and measure the breadth and timing of attempts.
4. Inspect unusual responses, new files, error activity, and follow-on access to privileged endpoints.

TRUE POSITIVE SIGNALS
A crafted payload that reached the application or produced corroborated success behavior supports a true positive.

FALSE POSITIVE SIGNALS
Fully blocked generic reconnaissance with no follow-on activity and no application impact supports a false positive.

NEEDS HUMAN WHEN
Enforcement status, application processing, or follow-on evidence cannot be established.

RECOMMENDED NEXT ACTION
Escalate likely exploitation for application containment and evidence preservation; otherwise consider blocking a hostile client.

LIMITATIONS
Response status alone cannot prove that an exploit succeeded or failed.
