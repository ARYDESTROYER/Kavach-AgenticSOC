---
title: Logs and search
description: Browse recent normalized events and find cases, sources, and destinations without changing source data.
---

# Logs and search

Open **Triage → Logs** to inspect recent events across enabled, browse-capable
sources. This surface is read-only and requires `sources:read` when RBAC is enabled.

## Unified logs

The unified view fans out to each source and merges rows newest first. Every row
includes `source_id` and source name so identical-looking events remain attributable.

- Pull connectors perform a bounded search with the source's own field mapping,
  index scope, TLS settings, and read-only credential.
- Push, queue, and object-store receivers show their recent in-process browse buffer.
- A source timeout or read error is returned as a per-source failure; successful
  sources still render.
- The result is capped at 200 rows per source and 200 merged rows.

Filter by free text and a from/to time range. The displayed row normalizes timestamp,
source and destination IP, user, host, rule, severity, and message while preserving a
raw payload view for provenance.

!!! warning "Recent push logs are not an archive"

    The push browse buffer is volatile. Restarting the backend clears it. Cases keep
    selected identifiers and evidence, but the authoritative raw event should remain
    in the sending system, broker, or object store.

## Browse one source

From **Platform → Sources**, open a source and choose its log view when available.
This runs the same bounded source-specific search or buffer read. An empty result can
mean a quiet source, an overly narrow time range, a mapping mismatch, or a source that
has not received data; check source health and coverage before concluding that the
pipeline is broken.

## Global search and command palette

Use the command palette to find:

- cases by ID, title, entity, tag, or source;
- configured sources by name, type, or ID;
- navigation and Settings destinations; and
- your saved chat conversations by their content.

The palette also offers **New chat**, **Open Reports**, and **Ask AI**, which opens a new
Workspace Chat with what you typed in the composer, ready to review and send. Chat
entries are listed after pages and settings, so pressing Enter on a page name still
opens that page.

Global search is bounded and requires `cases:read`. It is a navigation aid, not an
unbounded raw-event search engine.

**Open in Logs** on a Workspace Chat result opens this page with the exact query,
source, and absolute time window behind that result, so you can inspect the events
yourself. It is offered only when the Logs page can apply the same filter.

## Treat log content as data

Log messages, field names, entities, and raw payload values can be attacker
controlled. Agentic SOC renders them as plain data and fences them before model use. Do not
copy an instruction embedded in a log into a trusted runbook or memory entry without
independent verification.

Continue with [Investigation](investigation.md) or the
[source support matrix](../sources/support-matrix.md).
