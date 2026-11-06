---
title: Enrichment
description: Configure cached, fail-open threat-intelligence lookups for supported indicator types.
---

# Enrichment

Enrichment adds external reputation and context to IPs, domains, URLs, file hashes,
and emails. It is advisory and fail-open: one provider's timeout or failure
must not drop an alert or decide a case.

Open **Settings → Integrations → Enrichment**. Reading the catalog and testing a
lookup requires `enrichment:read`; changing the switches, the cache lifetime and
provider secrets requires `enrichment:manage`. The switches and the cache lifetime save
as soon as you change them, and cannot be changed while the settings lock is on; the
provider panel also disables its key fields while the lock is on. Each change is
recorded in the audit log, and so is each provider key you set or clear (its name only,
never its value).

## Built-in providers

v0.1 registers 19 provider adapters:

`AbuseIPDB`, `BinaryEdge`, `Censys`, `GreyNoise`, `HIBP`, `IPInfo`,
`MalwareBazaar`, `OTX`, `Project Honeypot`, `Pulsedive`, `RDAP`, `Shodan`,
`Shodan InternetDB`, `Spur`, `ThreatFox`, `URLhaus`, `URLScan`, `VirusTotal`, and
`IBM X-Force`.

The provider catalog is authoritative for each adapter's supported indicator types,
credential fields, and configured state. Key-gated providers run only when both
enabled and configured. Keyless providers can be enabled without storing a secret.

## Cache and fusion

Lookups are cached per provider and indicator to protect latency, cost, and provider
quotas. Redis is preferred; the cache falls back to process memory if Redis is
unavailable.

When fusion is disabled, provider results remain independently visible. When fusion
is enabled, the configured aggregation policy produces a bounded reputation score.
The default fusion behavior takes the strongest provider score; weighted fusion is
an operator opt-in.

## Demo Mode

Demo Mode never queries a provider, whatever the switches say: the synthetic demo makes
no external lookup, and **Try a lookup** returns an empty result that says why.

While Demo Mode is on, the Enrichment section shows and changes the demo's own copy of
the enrichment settings, under the note **Demo Mode is on**. A switch or a cache lifetime
you change there applies to the demo only and is discarded when Demo Mode ends or is
reset; your real enrichment settings stay as they were, and the change is recorded in the
demo's audit trail. Provider keys are not part of that copy: a key saved while Demo Mode
is on is saved for real and stays after Demo Mode ends, and the provider's panel says so
above its key fields.

## Configure safely

1. Enable only providers needed for your indicator mix.
2. Add credentials through the write-only secret control; saved responses expose
   configured booleans, never secret values.
3. Test with a non-sensitive indicator.
4. Confirm provider attribution, cache state, and error handling.
5. Set a cache lifetime that respects both freshness and provider quota. The longest
   lifetime is 30 days.

Provider terms, data handling, and rate limits remain the operator's responsibility.
Do not interpret a single provider verdict as a case disposition.

See [MITRE and threat context](mitre-threat-context.md) and
[Investigation](../analyst/investigation.md).
