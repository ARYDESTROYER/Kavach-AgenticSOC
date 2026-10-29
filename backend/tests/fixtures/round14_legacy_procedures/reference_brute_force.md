---
id: brute_force
title: SSH / credential brute force
applies_to_rules: [sshd, linux_auth, postfix, winlogon]
applies_to_techniques: [T1110, T1078]
applies_to_entities: [ip, user]
keywords: [ssh, brute, failed password, auth, login, credential, 4625]
persona: identity_access
summary: A burst of failed authentications from one source against a host or user.
---
SIGNAL
A burst of failed authentications from one source, or failures against one account from many sources.

EVIDENCE REQUIRED
Authentication outcomes, source addresses, targeted accounts, timing, asset identity, and source reputation.

INVESTIGATION STEPS
1. Check for a successful login from the same source or account during and just after the failure window.
2. Count distinct targeted accounts to distinguish password spraying from targeted guessing.
3. Count distinct sources and compare them with known corporate addresses and approved scanners.
4. If any login succeeded, inspect new sessions, privilege use, and lateral movement by that account.

TRUE POSITIVE SIGNALS
A sustained burst from a hostile source, or a successful login followed by suspicious account activity, supports a true positive.

FALSE POSITIVE SIGNALS
A few failures followed by normal activity from a known user and expected host supports a benign typing error.

NEEDS HUMAN WHEN
Authentication success cannot be confirmed, identity context is missing, or the evidence conflicts.

RECOMMENDED NEXT ACTION
Escalate a likely compromise for account containment; otherwise consider blocking a confirmed hostile source.

LIMITATIONS
Partial authentication retention can hide the successful event that changes the investigation outcome.
