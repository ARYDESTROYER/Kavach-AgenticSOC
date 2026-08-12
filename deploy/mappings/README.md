# Index templates (cases / audit / usage)

These are the Elasticsearch **composable index templates** for the three contract
indices the backend owns (Section 7 of the spec):

| File | Index pattern | Time field | Purpose |
|---|---|---|---|
| `tlsoc-agent-cases.template.json` | `tlsoc-agent-cases-*` | `created_at` | one document per investigation/case |
| `tlsoc-agent-audit.template.json` | `tlsoc-agent-audit-*` | `ts` | append-only audit of every agent action |
| `tlsoc-agent-usage.template.json` | `tlsoc-agent-usage-*` | `ts` | token & cost ledger (one doc per LLM call) |

> **Only relevant when `STATE_BACKEND=elasticsearch`.** These templates describe
> the suite's own bookkeeping indices on the Elasticsearch state backend. The
> agnostic stack (`deploy/docker-compose.agnostic.yml`) defaults to
> `STATE_BACKEND=postgres`, and a SQLite deployment needs no Elasticsearch at
> all — in either case, this whole directory is irrelevant and can be ignored.

## You normally do NOT need these

The backend **creates any missing templates and backing write indices/aliases on first
boot** (`app/es/indices.py :: bootstrap_indices`, using the management API key). It
does not overwrite an existing template or remap/reindex an existing index. These files
are provided for transparency and for operators who prefer to pre-create the templates,
e.g.:

```bash
curl -k -u elastic:$ELASTIC_PASSWORD -X PUT \
  https://localhost:9200/_index_template/tlsoc-agent-cases-template \
  -H 'Content-Type: application/json' \
  --data-binary @tlsoc-agent-cases.template.json
```

These JSON files are generated directly from the backend's source of truth
(`app/es/indices.py`), so they always match what the backend creates. The
single-doc bookkeeping indices `tlsoc-agent-config` and `tlsoc-agent-cursor` are
created with a dynamic mapping and need no template.

## Upgrade behavior

The current templates add record-producing build fields (`app_version`, `build_sha`),
the Case lifetime marker (`retrieval_history_status`), and the separate measurement
marker (`retrieval_observation_status`). A fresh Elasticsearch-state installation
receives them automatically. An existing installation does not: deploy the updated
templates and, where explicit field mappings are required, update or roll over/reindex
the existing Agentic SOC-owned indices using your normal controlled Elasticsearch
process. Dynamic mapping may accept newly written fields, but that is not the same as
applying this repository's template to an existing index.

There is intentionally no historical backfill. Legacy provenance stays `null`, legacy
`retrieval_history_status` remains `unavailable`, and the new observation marker starts
`unavailable` rather than being inferred from `knowledge_used`. A later fully measured
run may advance `retrieval_observation_status`, but cannot repair lifetime completeness.
PostgreSQL and SQLite store these additive fields inside existing JSON documents and
require no SQL migration. The change also does not bump the application version beyond
`0.1.13`.
