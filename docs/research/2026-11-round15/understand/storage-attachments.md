# Round 15 map: storing case screenshots (image attachments) within the storage rules

Reader scope: how to store case screenshots safely under #12 (KV only, no new index or
table), using what exists today. READ ONLY; every claim cites the tree at `b49780c`
(branch `claude/round15`). Paths are repository-relative.

---

## 0. Executive summary

* There is **no binary-serving route today**. The only stored images are inline
  `data:image/...;base64` strings inside JSON documents: the user avatar (<= 64,000
  characters, inside the single `users` KV document) and the branding logo/favicon
  (<= 1,400,000 characters, inside the preferences config document). Neither pattern
  scales to case screenshots (MB-sized, many per case, listed in case payloads).
* The KV contract is `get`/`put`/`put_if` (+ `mutate` via `kv_mutate`), **no delete,
  no list-by-prefix**. Bundled backends add `get_strict`/`put_strict`/`put_if_strict`
  (ES) and `factory_purge_strict`. Deletion everywhere is a tombstone overwrite.
* The closest precedents are **chat reports** (one doc per report + a small index doc,
  opaque `report_`-prefixed fields, 512 kB cap, tombstone delete) and **runbook runs**
  (per-case doc `case:<case_id>`, `runbook_store` tag field so a cases reset can find
  every doc, 1 MiB cap, strict CAS).
* **Two hard blockers to fix before MB-sized blobs enter KV:**
  1. `factory_purge_strict` loads **every KV row's full value into memory and deep-copies
     it** on both backends (ES `_config_snapshot_strict`, SQL `select(KVRow)`); with
     image blobs this is an OOM path during factory reset.
  2. The Console's nginx proxy sets **no `client_max_body_size`** (nginx default 1 MiB),
     and the backend has **no global request body cap** (FastAPI reads the whole JSON
     body before any dependency runs).
* **Pillow is not available** in the backend image or venv (only on the sandbox's
  system Python). `python-multipart==0.0.9` is pinned but **no route parses multipart**;
  Starlette is 0.37.2. Do not introduce multipart parsing; use a bounded JSON (base64)
  body like the avatar.
* Filesystem job artifacts are **not** suitable: not replacement-safe on the supported
  standalone Compose profile, not in the PostgreSQL backup, count-pruned to 50, not
  exported, not multi-replica.
* Recommended design (section 7): namespace `case_files`, a per-case index doc plus one
  write-once content doc per image, PNG/JPEG/WebP only by magic bytes, stdlib structural
  validation + metadata stripping + dimension caps on the server, canvas re-encode in the
  browser, 2 MiB per image, 20 per case, audited add/delete via `audited_write`, served
  by a dedicated GET with strict headers, never on the `Case` document, never to a model.

---

## 1. The KV store API

### 1.1 Abstract contract, `backend/app/stores/base.py`

| Item | Lines | Facts |
|---|---|---|
| `KV_REV_FIELD = "_rev"` | 53-60 | CAS revision stamped **inside** the value dict; a doc without it reads as rev 0. |
| `_KV_MUTATE_RETRIES = 8` | 62-67 | bounded CAS retries. |
| `kv_mutate(kv, ns, key, mutator, *, lock)` | 70-163 | per-store `asyncio.Lock` + `_rev` CAS; prefers `put_if` (atomic) else put + verify-get. **Never raises**: on backend failure / exhausted retries it logs and returns the *computed* value (an unpersisted write can look successful). Mutator must be pure (may run more than once). |
| `kv_mutate_strict(...)` | 166-211 | durability variant: uses `get_strict`/`put_if_strict`/`put_strict` when present, propagates backend errors, raises `RuntimeError` after 8 conflicts. Use for anything whose success is reported to a user (reports, chat history, runbook runs do). |
| `_rev_of` | 214-221 | 0 when absent/malformed. |
| `class KVStore(ABC)` | 1116-1196 | `get(ns,key)` 1126, `put(ns,key,value)` 1129, `put_if(ns,key,value,expected_rev)` 1131-1148 (default non-atomic get→check→put), `factory_purge_strict()` 1150-1158 (abstract-ish: raises `NotImplementedError`), `_lock_for` 1172-1183, `mutate()` 1185-1196. **No `delete`, no `list`, no prefix scan.** |

### 1.2 Elasticsearch adapter, `EsKVStore`, `backend/app/stores/memory.py:62-242`

* Every (namespace, key) is ONE doc in the existing config index
  `CONFIG_INDEX = "tlsoc-agent-config"` (`backend/app/constants.py:22`); doc id
  `"<namespace>:<key>"` except six legacy singletons with readable ids (`_doc_id`,
  memory.py:75-91).
* `get` (93-98) and `put` (100-106) are **fail-soft** (log + `None`/no-op). Strict callers
  must use `get_strict` (108-112) / `put_strict` (114-120). `put_if` (122-136) is native
  ES OCC via `compare_and_set_doc` (`backend/app/es/client.py:309-369`: it `GET`s the
  full `_source`, compares `_rev`, then indexes with `if_seq_no`/`if_primary_term`;
  an absent doc is created with `op_type=create`). Every CAS therefore reads the **whole**
  document: big docs must not be CAS-mutated repeatedly.
* `_config_snapshot_strict` (148-200): PIT scan of the WHOLE config index, `size: 500`,
  **no `_source` filtering**, `rows[doc_id] = copy.deepcopy(source)` for every doc.
* `factory_purge_strict` (202-242): snapshots everything (above), keeps the exact Jobs +
  Batch fence docs and every `system_update_operations:*` doc, strict-deletes the rest one
  by one (`delete_doc_strict(..., refresh=True)`), re-snapshots and compares.
  **Memory = size of the whole config index, twice.** With screenshots in KV this must
  change (section 6.1).
* Index creation: `bootstrap_indices` creates the config index with only
  `{"mappings": {"dynamic": True}}` (`backend/app/es/indices.py:405-408`). Bootstrap
  "creates what is missing and never remaps" (indices.py:1-19), with one Round 14 additive
  exception for the audit index (`extend_audit_mapping`).
* Consequences of the shared dynamic mapping (documented in the stores):
  - all namespaces share ONE mapping (default 1,000-field limit): store content as ONE
    opaque string under fixed, namespace-prefixed field names
    (`backend/app/stores/reports.py:15-19`, `chat_conversations.py:14-22,47-57`,
    `case_thread.py:25-33`, `engine/replay/fixtures.py:22-30`);
  - **date detection is on**: a top-level field whose first value looks like a date maps
    as `date` and refuses later writes, so never put a raw id in a top-level field
    (`backend/app/stores/runbook_runs.py:19-24`: `runbook_case_id` holds `case:<id>`);
  - a large base64 string in a dynamically mapped field becomes `text` (+ `keyword`
    `ignore_above: 256`): indexable, but its tokens bloat the inverted index. The branding
    logo already does this today (up to 1.4 MB in the preferences doc).

### 1.3 SQL adapter, `SqlKVStore`, `backend/app/stores/sql/repositories.py:1925-2050`

* Table `kv` (`backend/app/stores/sql/models.py:86-97`): `namespace String(64)` PK,
  `key String(128)` PK, `value JSON` (generic SQLAlchemy `JSON`; PostgreSQL `json`,
  SQLite text). **Key max 128 chars** (runbook_runs hashes longer case keys:
  `runbook_runs.py:255-265`, `KV_KEY_MAX_CHARS = 128` at 105).
* `get` (1932-1935) and `put` (1937-1944) are plain (they raise on failure, no
  `get_strict` method exists; strict helpers fall back to `get`).
* `put_if` (1946-1986): revision predicate inside the `UPDATE` (`readable_json(...)["_rev"]`),
  absent row with expected rev 0 → `INSERT` arbitrated by the PK (IntegrityError → False).
* `factory_purge_strict` (1990-2048): PostgreSQL `LOCK TABLE kv IN ACCESS EXCLUSIVE MODE`,
  `select(KVRow).with_for_update()` (2008) loading **every row value**, `copy.deepcopy`
  into `before`, `DELETE ... WHERE NOT keep`, re-select and compare. **Same OOM risk.**
* PostgreSQL rows are included in the updater's pre-update `pg_dump --format=custom`
  backup (`updater/agentic_soc_updater/runtime.py:900`), attachments in KV are backed up
  and rolled back with the data; backup time and disk grow with them.

### 1.4 Namespace registry

There is **no central registry**: namespaces are constants in `backend/app/constants.py`
(44-333; e.g. `CASE_THREAD_NS` 125, `REPORTS_NS` 299, `RUNBOOK_RUNS_NS` 333) or
module-level (`chat_feedback.py:35`, `rule_versions.py:52`, `chat_starters.py:42`,
`precedent_exclusions.py:58`, `update_operations.py:15`, `auth/oidc.py:48`,
`engine/case_id.py:34`). A new namespace needs a constant + every lifecycle hook in
section 4 wired by hand.

### 1.5 Size limits in force today (precedents)

| Doc | Limit | Where |
|---|---|---|
| avatar data URL | 64,000 chars | `models.py:612` `MAX_AVATAR_LEN` |
| branding logo/favicon data URL | 1,400,000 chars | `config.py:943,1074-1075` |
| chat report doc | 512,000 bytes | `constants.py:305` `MAX_REPORT_DOC_BYTES` |
| runbook runs per-case doc | 1,048,576 bytes (tables 512 KiB) | `models.py:5163`, `runbook_runs.py:6-9` |
| replay fixture body | default 131,072, max 1,048,576 bytes | `config.py:2507-2510` |
| chat conversation row | 256,000 bytes | `chat_conversations.py:184` |
| runbook request body | 512 KiB | `engine/runbook_catalog.py:153` |
| push ingest body | 25 MiB | `api/routes.py:1222` |

---

## 2. Binary data stored today

### 2.1 User avatar

* Model: `User.avatar: str = ""` (`backend/app/models.py`, `class User` at 662; profile block
  comment "The avatar is a bounded data-URL (see validate_avatar)").
* Validator `validate_avatar` (`models.py:624-660`): empty clears; else must match
  `^data:image/(png|webp|jpeg);base64,(.+)$` (`_AVATAR_RE` 621), length <= 64,000,
  `base64.b64decode(body, validate=True)`, non-empty, magic sniff: PNG
  `\x89PNG\r\n\x1a\n`, JPEG `\xff\xd8\xff`, WebP `RIFF....WEBP` (616-620, 651-658).
  **SVG rejected** by construction (comment 614-615). No EXIF stripping, no dimension
  check, no re-encode server-side.
* Routes (`backend/app/api/routes.py`): `PUT /api/account/me` (4675-4760, avatar at
  4694-4698) and `PUT /api/me/avatar` (4763-4790, body `AvatarBody {avatar: str}`
  4569-4573). Gate: an authenticated session (`_account_principal` 4588-4599; 400 when
  auth is disabled; 400 "managed via environment configuration" for the env admin).
  Audited first via `audited_write(sink="control", action="user.updated", ...)`; the
  audit change records only `"image"`/`None`, never the bytes (`_image_marker` 4641-4643,
  `_account_changes` 4646-4661). Copy: `"cleared avatar"` / `"updated avatar"`.
* Storage: inside the ONE `users` KV document (`USERS_NS="users"`, `USERS_KEY="entries"`,
  `constants.py:75-76`), every user's avatar shares one doc.
* Serving: **never as an image response**; the data URL travels inline in JSON
  (`user.public()`), rendered by `<img src="data:...">`. No `Content-Disposition`, no
  per-image CSP.
* Browser side `webui/src/lib/avatar.ts`: picked-file allowlist PNG/JPEG/WebP/GIF (35),
  8 MB input cap (23), center-crop to 256 px canvas, `encodeAvatarUnderLimit` tries WebP
  0.85/0.7/0.5, JPEG 0.85/0.7/0.5, then PNG, and trusts the **actual** emitted prefix
  (93-114), safe limit 60,000 under the 64,000 backend cap (31-32). Canvas re-encoding
  is what strips EXIF in practice. UI: `webui/src/soc/pages/Account.tsx:400-430`
  ("Photos are resized to 256 by 256 pixels in your browser before upload.").
* Tests pinning: `backend/tests/test_account_profile.py:44-81` (accepts PNG/JPEG/WebP,
  rejects SVG, oversize, malformed base64, wrong magic); `webui/src/lib/__tests__/avatar.test.ts`,
  `webui/src/lib/__tests__/account-profile.test.ts:75-77`.

### 2.2 Branding logo and favicon

* `BrandingConfig.logo_data_url` / `favicon_data_url` (`backend/app/config.py:904-905`),
  validator `_check_logo` (1068-1110): `data:image/` prefix, <= 1,400,000 chars, refuses
  `data:image/svg` (1082-1083), magic sniff for png/jpeg/jpg/webp/gif base64 bodies,
  "Non-base64 data-URLs and unrecognised image subtypes are left to the prefix + SVG
  checks" (back-compat).
* Stored in the preferences config document (pre-auth readable for the login screen).
* Inconsistency (pre-existing): `webui/src/soc/components/BrandingEditor.tsx:94,98-103`
  offers `image/svg+xml` for logo and favicon, which the backend refuses. Client cap 200 KB
  logo / 64 KB favicon (93, 97) keeps the body under nginx's default 1 MiB.

---

## 3. Upload handling

### 3.1 Dependencies

* `backend/requirements.txt:5,7`: `fastapi==0.110.1`, `python-multipart==0.0.9`
  (installed in `backend/.venv`, version 0.0.9). Starlette in the venv: 0.37.2.
* **No route uses `UploadFile`, `File(...)`, `Form(...)` or `request.form()`** (grep of
  `backend/app`): multipart is never parsed today. Known advisories affect this exact
  stack if multipart parsing were introduced (python-multipart < 0.0.18 malformed-boundary
  DoS, CVE-2024-53981; Starlette < 0.40.0 unbounded non-file form fields, CVE-2024-47874 -
  verify before relying on this note). Upgrading pinned packages is a deliberate decision;
  avoid by not using multipart.
* **Pillow**: not in `requirements*.txt`, not importable from `backend/.venv`
  (`ModuleNotFoundError`), not installed by `backend/Dockerfile` (35-41 installs only
  `requirements.txt`; the `full` target adds `requirements-connectors.txt`, none of which
  pull Pillow). It exists only on the sandbox's system Python
  (`/usr/lib/python3/dist-packages/PIL`, 10.2.0), irrelevant to the image. Adding it is a
  new native-code dependency with a frequent decoder CVE history; AGENTS §10 says version
  0.1 adds only explicitly pinned connector/SQL packaging deps.

### 3.2 How bodies are read today

* The webui request layer only sends JSON: `requestResponse` sets
  `Content-Type: application/json` and `JSON.stringify(body)` (`webui/src/lib/api.ts:657-713`),
  cookie auth `credentials: 'include'` (670). Binary download helper `requestBlob`
  (737-747) returns `{blob, contentDisposition, contentType}` through the same 401/step-up
  flow. Download helpers: `webui/src/lib/download-blob.ts`, `download.ts`.
* Avatar: plain Pydantic JSON body (no size gate other than the validator; FastAPI reads
  the whole body first).
* Bounded readers that exist:
  - `_read_capped_body` (`backend/app/api/routes.py:1224-1245`, 25 MiB, checks
    `Content-Length` then streams with a running cap) used by `POST /api/ingest/{source_id}`.
  - `_bounded_request` + `_RunbookRoute` (`backend/app/api/routes_runbooks.py:101-159`,
    router at 162): a custom `APIRoute` that bounds POST/PUT/PATCH bodies **before**
    FastAPI parses them ("FastAPI reads the whole body before it solves any dependency,
    so a dependency cannot bound it", 140-143) and replays the body; 413
    `runbook_body_too_large`. **This is the pattern an upload router should copy.**
* No global request-size middleware: middleware stack is `MutationAdmission`, optional
  CSRF, optional rate limit, security headers, request id (`backend/app/main.py:125-147`).

### 3.3 nginx (`webui/nginx.conf`, shipped in the `tlsoc-webui` image)

* `location /api/` (58-68): `proxy_read_timeout 300s`; **no `client_max_body_size`**
  anywhere in the file → nginx default **1 MiB**; an over-limit body gets nginx's HTML 413,
  which the webui cannot parse as JSON.
* No CSP is sent for the SPA document (only `nginx-security-headers.conf`:
  `X-Content-Type-Options nosniff`, `X-Frame-Options DENY`, `Referrer-Policy no-referrer`,
  `Permissions-Policy camera=(), microphone=(), geolocation=()`). `data:` and `blob:`
  images therefore render today; a future SPA CSP must allow `img-src 'self' blob: data:`.
* `scripts/check_version.py:246-290` pins nginx markers (docs/examples/release.json
  boundaries, `server_tokens off;`, the security-header include); adding a location is
  compatible. The updater's frozen base (`deploy/update-base-v1.sha256`) covers the
  Compose file, **not** nginx.conf, so nginx can change per release.
* The backend port 8088 is published directly in the standalone Compose
  (`deploy/docker-compose.agnostic.yml`, `ports: "8088:8088"`), so the backend must
  enforce its own body cap; nginx is not the only path.

### 3.4 Rate limits

* `RateLimitMiddleware` (`backend/app/middleware/rate_limit.py`): per-client-IP token
  bucket, capacity 120, refill 2/s, LRU 50,000 buckets; **off by default**
  (`Secrets.rate_limit_enabled = False`, `backend/app/config.py:250-252`).
* Per-route, per-user, process-local limiter precedent: chat starters events
  `EVENTS_PER_MINUTE = 30` → `429 chat_suggestions_busy` with `Retry-After`
  (`backend/app/api/routes_chat_starters.py:70-77,263-279`). Chat concurrency 12/48
  (`routes_chat.py`, `429 chat_busy`).
* CSRF double-submit is off by default (`config.py:249`); the session cookie is
  `samesite="lax"` (`routes.py:3462,3476`), so a cross-site POST carries no cookie. A JSON
  or `image/*` body is not a CORS-simple request; `multipart/form-data` is, one more
  reason not to accept multipart.

### 3.5 Security headers on backend responses

* `SecurityHeadersMiddleware` (`backend/app/middleware/security_headers.py:18,58-69`):
  `setdefault` of `Content-Security-Policy: default-src 'self'; frame-ancestors 'none';
  object-src 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, HSTS over HTTPS. **Env-toggleable**
  (`security_headers_enabled = True` default, `config.py:248`; Compose
  `SECURITY_HEADERS_ENABLED`), and `setdefault` means a route's own headers win, so an
  image route must set its own headers explicitly (the job artifact route does).
* Pinned by `backend/tests/test_auth_primitives.py:178`.

---

## 4. Lifecycle hooks a new KV namespace must be wired into

### 4.1 Data export (`backend/app/api/routes_export.py`)

* Scopes `cases, audit, usage, configuration, automation, knowledge` (53-63).
  `_collect_scope` (822-896) / `_collect_segment_page` (899-956). Cases carry their runbook
  runs as `case_runbook_runs` (825-843, 906-916) with manifest keys `case_runbook_runs`,
  `case_runbook_runs_steps`, `case_runbook_runs_consistency`.
* **Case thread, activity and tasks are NOT exported today** (no reference in the file).
* `_EXCLUDED` (95-102) is emitted in every manifest/segment (1106, 1368, 1462): add a line
  if image bytes are excluded.
* `_plain` (335-364) **truncates every string to `_MAX_TEXT_CHARS = 250_000`** (66,
  `_redact_text` 323-327) and regex-redacts secret patterns, base64 must never go through
  it (silent corruption). `_MAX_EXPORT_BYTES = 25 MiB` per payload/segment (65).
* Tests: `backend/tests/test_export_archive.py`, `test_discounted_inference_export.py`,
  `test_audit_export.py`.

### 4.2 Tiered reset (`backend/app/engine/reset.py`)

* Docstring tiers (1-50). Cases tier clears `_CASES_KV` single docs (121-134:
  campaigns, baseline, noise, case_thread, case_activity, case_tasks) with
  `put(ns, key, {})` (`_clear_kv` 421-442), runbook runs by enumeration
  (`_clear_runbook_runs` 460-506: SQL `DELETE FROM kv WHERE namespace = 'runbook_runs'`;
  ES `term` on `runbook_store` **and** `runbook_store.keyword`, `_source: False`, delete
  each id with prefix `runbook_runs:`), replay fixtures via the store's own purge
  (196-210), batch jobs, inbox, live tail. Factory tier skips per-store clears and relies
  on `kv.factory_purge_strict()` (269-286).
* A per-case image namespace needs the runbook-runs treatment: a fixed tag field on every
  doc (ES) + namespace delete (SQL), receipt entry `kv:case_files:<n>`.
* Tests pinning receipts: `backend/tests/test_runbook_stores.py:1194-1195`
  (`"kv:runbook_runs:3" in receipt["cleared"]`), `test_replay_fixtures.py:288`,
  `test_round4_wave4_reset.py`, factory purge `test_factory_storage_primitives.py:109-203`.
* UI copy: `webui/src/soc/components/DangerZone.tsx:95-150` (cases tier "Per-case
  collaboration, ordinary inbox items and activity"; pinned by
  `webui/src/soc/__tests__/danger-zone.test.tsx`); docs `docs/administration/reset.md`.

### 4.3 User deletion

* `DELETE /api/users/{username}` (`backend/app/api/routes.py:5972-6037`) →
  `AuthService.purge_user_side_state` (`backend/app/auth/service.py:289-361`): inbox,
  notif_prefs, user_prefs, custom_roles, chat_conversations, chat_feedback, chat_starters,
  reports, **per-user** buckets only; "the authoritative audit / case feed is untouched
  (it intentionally retains the actor's historical rows, #2)".
* Case screenshots are case evidence, not personal state: keep them on user deletion
  (like thread messages, whose `author` stays). No hook needed; document it.

### 4.4 Case deletion / retention

* There is **no case deletion route**. `delete_case` exists on case_thread (322-333),
  case_activity (127), case_tasks (210) and runbook_runs (651) but has no production
  caller (grep).
* `backend/app/engine/storage_lifecycle.py:1-12`: lifecycle never moves or deletes cases;
  only audit/usage ledgers get ILM. **Naming clash:** this module and its API use
  `attachments` for ILM policy attachment state (`attachment_detail` 139-191, response key
  `"attachments"` 291; webui `StorageLifecycleAttachmentStatus`, `webui/src/lib/types.ts:1777-1793`).
  "Attachment" is also the runbook verb (`engine/runbook_runs.py:1089-1209`,
  `run.attached` audit action, `StepEvidenceRule "note_or_attachment"` = "A note or a
  link", `webui/src/soc/runbooks/shared/labels.ts:258`). Prefer `case_files` / "Files" /
  "Screenshots" for the new feature.
* So screenshots live exactly as long as their case: until a cases, sources or factory
  reset.

### 4.5 Rollback forward compatibility

* Contract: `docs/operations/upgrades.md:861-890` (unknown job kinds kept, unknown
  preference keys kept, corpus-migration marker). Lane `scripts/rollback_lane.py`
  (`_plant_future` 452-505 plants future data through `SqlKVStore`), offline tests
  `backend/tests/test_rollback_forward_compat.py`, PostgreSQL `test_postgres_rollback_compat.py`;
  docs `docs/development/testing.md:377-399`.
* A brand-new KV namespace is invisible to the previous build (it only addresses its own
  `(ns, key)`s): safe. But:
  - the previous build's **cases reset does not clear it** (orphans survive a reset made
    while rolled back; reads must verify the case still exists, and the next reset on this
    build removes them);
  - the previous build's **factory purge does delete it** (wholesale purge);
  - adding a field to `Case` is dropped by the previous build's next full overwrite of the
    case (`CaseStore.save` is a full `index_doc`, `backend/app/stores/cases.py:105-125`,
    no CAS), **do not put attachment state on the Case document**;
  - adding a new `StepEvidence.kind` literal (`models.py:5229`) would make the previous
    build fail validating run documents: do not link screenshots into runbook step evidence
    in Round 15.
  - new `Preferences` keys survive the previous build's saves (R3).
* The rollback lane should plant a screenshot index + content doc and assert they survive
  N-1 and are readable after returning.

### 4.6 Opaque KV doc examples to copy

* Reports (`backend/app/stores/reports.py:1-47`): one doc per item + small index doc;
  every field `report_`-prefixed; strict CAS + confirming read; `ReportStoreUnavailable`
  → 503; tombstone delete then index removal; cap refusal instead of eviction.
* Chat history (`chat_conversations.py:1-170`): fixed `chat_`-prefixed fields holding one
  opaque string; keys are SHA-256 digests (<= 43 chars); "The KV contract has no delete,
  so a removed document is overwritten by an empty one (`{"schema": 1}`)" (127-130).
* Runbook runs (`runbook_runs.py:1-55,103-115,255-266,363-377,651-668`): `STORE_FIELD =
  "runbook_store"` tag, `runbook_case_id = "case:<id>"` (never a raw id, date detection),
  hashed key past 128 chars, tombstone `{..., runbook_deleted: True, runbook_runs_json: None}`.
* Replay fixtures (`engine/replay/fixtures.py:1-40`): catalog + body slots, write order
  self-healing (catalog then body), strict content-hash check on every read, oversize
  skipped whole.

### 4.7 Demo Mode

* Demo stack builds its own stores over a Demo `EsKVStore(self.es)` (in-memory fake ES)
  (`backend/app/engine/demo_runtime.py:236-268`); `AppState` properties swap
  (`case_threads` 687-688, `case_tasks` 704-705, `runbook_runs` 540-546 in
  `backend/app/state.py`). Real stores are built over the shared KV in
  `state.py:1660-1690` (`self._kv` set at 1600 for SQL, 1613 for ES).
* Case work audits to the execution audit (`engine/runbook_runs.py:848-860`:
  `state.execution_audit or state.audit`). Screenshots should be Demo-swapped the same way.

---

## 5. Existing serving patterns (for the content route)

* Job artifacts on disk (`backend/app/engine/jobs.py:2187-2330`): root from
  `Secrets.jobs_artifact_dir = "./data/job-artifacts"` (`config.py:214-217`), 0700 dir,
  0600 files, opaque 32-hex ids (`_ARTIFACT_ID` 46), suffix allowlist
  `{".zip", ".csv", ".ndjson"}` (`stores/jobs.py:70`), symlink/containment checks
  (`artifact_path` 2217-2227), SHA-256 + size verified on download (2229-2244).
* Download route `GET /api/jobs/{job_id}/artifact` (`backend/app/api/routes_jobs.py:1195-1252`):
  owner-scoped, permission-alive check, verify → 410 on mismatch, **audited before
  streaming**, `FileResponse` with `Cache-Control: no-store`, `X-Content-Type-Options:
  nosniff`, `Content-Length`; OpenAPI declares binary content types (`_ARTIFACT_BINARY`
  1193).
* **Why the filesystem is not suitable for case screenshots** (docs/operations/deployment.md:141-155,
  background-jobs.md:248-270, configuration.md:44-51): the supported standalone Compose
  keeps `./data/job-artifacts` inside the container ("survive a backend process or ordinary
  container restart, but not container replacement") and its base file is byte-pinned by
  the updater protocol (`deploy/update-base-v1.sha256`), so a volume cannot be added
  without a new bootstrap path; artifacts are not in the PostgreSQL backup, not in the
  export, pruned to the newest 50, and process-local. Screenshots are durable case
  evidence: they belong in the StateStore (KV).

---

## 6. Must-fix prerequisites and risks

### 6.1 Factory purge memory (blocker)

`EsKVStore._config_snapshot_strict` (memory.py:148-200) and `SqlKVStore.factory_purge_strict`
(repositories.py:2004-2016) materialise and deep-copy every KV value. With N screenshots of
up to ~2.8 MB base64 each, a factory reset holds all of them in memory (twice on ES).
Fix while keeping the privacy proof:
* ES: scan ids with `"_source": false` (plus the doc id), strict-get only the protected
  ids (Jobs, Batch, `system_update_operations:*`) for the byte comparison; after-delete
  verification by ids + protected bytes.
* SQL: `select(KVRow.namespace, KVRow.key)` for the census, values only for protected
  rows; keep the table lock and single transaction.
* Update `backend/tests/test_factory_storage_primitives.py` and add a "large values are
  never loaded" test (a fake that fails on full-source reads of non-protected docs).

### 6.2 Body caps (blocker)

* Add a bounded route class for the upload router (copy `_RunbookRoute`), e.g. 3 MiB.
* Add an nginx location for the upload path with a matching `client_max_body_size`
  (regex location `~ ^/api/cases/[^/]+/files$` wins over the `/api/` prefix; keep the same
  proxy headers and timeouts). Keep the browser below the cap so nginx's HTML 413 never
  reaches the user.

### 6.3 Other risks

* `kv_mutate` (fail-soft) returns success for unpersisted writes: use strict variants.
* `EsKVStore.get` returns `None` on outage: content reads must use `get_strict` so an
  outage is 503, not 404.
* ES CAS reads the whole doc: keep content docs write-once; mutate only the small index.
* Dynamic mapping/date detection: fixed `case_file_`-prefixed top-level fields; raw case
  ids only inside opaque JSON or as `case:<id>`.
* ES text-indexing of base64: acceptable (logo precedent) but wasteful; optional additive
  mapping `{"case_file_data": {"type": "binary"}}` on the config index at bootstrap
  (precedent: `extend_audit_mapping`), which must run before the first write; otherwise
  the field is mapped `text` forever. This is a deliberate exception to "bootstrap never
  remaps" and needs a SPEC decision.
* In-memory ES fallback (`Secrets.es_store_enabled`, `config.py:268`) keeps images in
  process memory: the per-case and global caps bound it.
* Existing GETs in `routes_cases_collab.py` (`/activity` 411, `/thread` 461) rely only on
  the mount-level `require_auth`, not `cases:read`; the new GETs should declare
  `require_permission("cases", "read")` explicitly.
* The users KV doc already holds every avatar inline (64 KB each): it shows why per-image
  docs are required; not a Round 15 change.

---

## 7. Recommended design

### 7.1 Storage shape (KV only, #12)

Namespace `case_files` (constant in `constants.py`, <= 64 chars). Keys (<= 128 chars):

| Key | Content | Mutation |
|---|---|---|
| `case:<case_id>` (or `case:~<sha256>` when > 128, copy `runbook_runs.case_key`) | per-case index: `case_file_store: "case_files"`, `case_file_schema: 1`, `case_file_case: "case:<id>"`, `case_file_index_json` (opaque canonical JSON list of entries), `case_file_deleted: false`, `_rev` | strict CAS (`kv_mutate_strict`), small (<= 20 entries, ~600 B each) |
| `blob:<file_id>` (`file_id` = 32 hex, server-minted) | content: `case_file_store`, `case_file_schema`, `case_file_case`, `case_file_type` (`png`/`jpeg`/`webp`), `case_file_sha256`, `case_file_bytes`, `case_file_data` (base64, no `data:` prefix), `case_file_deleted` | write-once (`put_if(..., expected_rev=0)` = create-only), then a tombstone overwrite on delete |
| optional `usage` | org totals `{bytes, count}` for a global budget | strict CAS on add/delete |

Index entry (opaque JSON): `{id, type, bytes, width, height, sha256, caption (<= 200, plain
text), filename (sanitised, <= 120), uploaded_by, uploaded_at, deleted_at?, deleted_by?}`.

Write order (self-healing, replay-fixture style): pre-checks (grant, case exists, caps,
validation, dedup by sha256 on the case) → `audited_write` action row → content create →
index CAS append (re-checks caps atomically; on refusal tombstone the content doc) →
`case.activity` SSE frame + a `CaseActivity` entry after save. A content doc not listed in
its case index is never served; the cases-tier clear finds orphans by tag.

Delete: uploader or a moderator (`cases:close`, mirroring `_require_author_or_moderator`,
`routes_cases_collab.py:577-605`, which records an Access denied row on refusal) → audit
row → index CAS marks the entry deleted (metadata tombstone kept for the timeline) →
content tombstone overwrite (bytes gone). Do not touch the `Case` document at any point.

### 7.2 Limits (constants in v1; optionally a `Preferences.case_files` block later)

* Types: PNG, JPEG, WebP only, decided by magic bytes; the client-declared type must
  agree or 415. Everything else refused: SVG (`<svg`, `<?xml`), GIF, BMP, TIFF, HEIC,
  ICO, PDF, polyglots with trailing data.
* Max 2 MiB decoded per image after stripping (2,097,152 B → ~2.8 MB base64; request cap
  3 MiB in the route class and nginx).
* Max 8,192 px per side and 40 megapixels total (parsed from IHDR / SOFn / VP8X/VP8/VP8L
  without decoding pixels), defends every viewer's browser against decompression bombs.
* Max 20 live images and 20 MiB per case; optional org budget (e.g. 2 GiB) via the
  `usage` doc → `409 case_files_storage_full`.
* Per user: 30 uploads per minute and 2 concurrent (process-local, chat-starters pattern)
  → `429 case_files_busy` with `Retry-After`.
* Caption <= 200 chars, filename <= 120 chars, both plain text (UI-escaped).

### 7.3 Validation and sanitising without a new dependency

Server (stdlib `struct`, `zlib`, `hashlib`, `base64`), in a pure module (e.g.
`backend/app/engine/case_images.py`) with exhaustive offline tests:
* **PNG**: signature, chunk walk with CRC check, first chunk IHDR (dims), must end with
  IEND and **no trailing bytes**; keep IHDR, PLTE, IDAT, IEND, tRNS, gAMA, cHRM, sRGB,
  sBIT, pHYs, bKGD, iCCP (<= 64 KiB); drop eXIf, tEXt, zTXt, iTXt, tIME and every other
  ancillary chunk (dropping acTL/fcTL/fdAT turns APNG into its static image); refuse an
  unknown critical chunk.
* **JPEG**: SOI, marker walk; keep APP0 (JFIF), APP14 (Adobe), APP2 only when
  `ICC_PROFILE\0`, DQT, DHT, DRI, SOFn (dims), SOS and the entropy data to EOI; drop APP1
  (Exif/XMP), APP3-APP13/15 (incl. IPTC), COM; refuse trailing bytes after EOI.
  (EXIF orientation is lost for direct API uploads; Console uploads are already
  orientation-normalised by the canvas.)
* **WebP**: `RIFF<size>WEBP`, chunk walk; keep VP8/VP8L/VP8X/ALPH/ICCP; drop EXIF and XMP,
  clear the VP8X EXIF/XMP flag bits, recompute the RIFF size; refuse ANIM/ANMF (animated).
* Recompute SHA-256 and size on the stored (stripped) bytes; serve the sniffed type only.
* Refactor the shared magic table with `validate_avatar` only if behaviour stays identical
  (pinned by `test_account_profile.py`).

Browser (no new npm dependency, extend the `avatar.ts` approach in a lazy chunk): accept
paste (clipboard `paste` event files), drag-and-drop and a file picker; decode with
`Image`/`createImageBitmap`, draw to a canvas (strips EXIF, applies orientation, turns
GIF/BMP/HEIC-on-Safari into a still), downscale to <= 3,840 px on the long edge, encode PNG
first (lossless for text), then WebP 0.92, JPEG 0.9, then shrink by 0.75 and retry;
trust the emitted type; keep under 2 MiB. Optional client thumbnail (<= 48 KiB WebP) as a
second write-once doc `thumb:<file_id>` for the gallery strip.

The server does not decode pixels (no image library): a crafted image targeting a browser
decoder is mitigated by the type allowlist, structure validation, dimension caps,
authenticated case-collaborator-only uploads, and audit, state this limitation in the
SPEC and docs.

### 7.4 API and serving (a new feature router, e.g. `backend/app/api/routes_case_files.py`, auto-discovered)

* `GET /api/cases/{case_id}/files`, `cases:read`; metadata only (no bytes).
* `POST /api/cases/{case_id}/files`, `cases:comment` (Tier 1, Tier 2, responder,
  manager, super admin hold it; auditor does not: `backend/app/rbac/policy.py:434-520`);
  JSON `{data_base64 | data_url, declared_type, filename?, caption?}`; bounded route
  class; 201 with the entry; dedup returns the existing entry (idempotent retries).
* `DELETE /api/cases/{case_id}/files/{file_id}`, `cases:comment` + uploader-or-`cases:close`.
* `GET /api/cases/{case_id}/files/{file_id}/content`, `cases:read`; 404 unless listed
  and live; `get_strict` (503 on outage); OpenAPI binary content types (job-artifact
  pattern). Headers set by the route itself: `Content-Type` = sniffed type,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="<case-number>-<n>.<ext>"`
  (server-generated ASCII name; `?download=1` → `attachment`), `Content-Security-Policy:
  default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox`,
  `Cache-Control: private, no-store`, `Cross-Origin-Resource-Policy: same-origin`,
  `Content-Length`. Optional `?variant=thumb`.
* Viewing: fetch through `requestBlob` → `URL.createObjectURL` (revoke on unmount) so the
  401/step-up flow applies; lazy-load only visible images. A plain `<img src>` would also
  work (cookie, same origin) but bypasses the error flow.
* Demo Mode: swap the store to the Demo KV (`AppState.case_files` property like
  `runbook_runs`), audit to the execution sink.

### 7.5 Audit (#2) and events

* `audited_write` (`backend/app/audit/write.py:218-330`) with `target={"type": "case",
  "id": case_id, "label": case_number}`, `changes=[{"field": "files", "before": null,
  "after": "<filename> (PNG, 812 KB)"}]`, never bytes. Actions that use existing base verbs
  (`_BASE_VERBS` 70-80 has `attached` and `deleted`): `case.file_attached`
  (failure `case.file_attach_failed`) and `case.file_deleted`
  (`case.file_delete_failed`). New action entries must be added to
  `backend/app/audit/event_categories.json` **and** `webui/src/soc/components/audit/events.ts`
  (contract test `webui/src/soc/components/audit/__tests__/events.contract.test.ts`).
  `ActionType.COLLAB` (constants.py:552) or `THREAD_POST` fits the legacy column.
* Views are not audited in v1 (case reads are not); a coalesced `case.file_viewed` is an
  option if the SPEC wants it.

### 7.6 Lifecycle wiring checklist

1. Constant `CASE_FILES_NS` + store `backend/app/stores/case_files.py` (strict, opaque).
2. `AppState` real + Demo stores; `DemoStack` builds one over its KV.
3. Reset cases tier: `_clear_case_files` (SQL namespace delete; ES tag term +
   `.keyword`, `_source: False`, id prefix `case_files:`), receipt `kv:case_files:<n>`;
   DangerZone copy and `docs/administration/reset.md`.
4. Factory purge: memory-safe census (6.1); the wholesale purge then covers the namespace.
5. Export: cases scope gains `case_files` metadata per case (id, type, bytes, dims,
   sha256, caption, uploaded_by/at); bytes excluded with a new `_EXCLUDED` line ("case
   screenshot image contents (metadata and SHA-256 are included)"); never through `_plain`.
   Archive members for the bytes are a possible later step.
6. User deletion: nothing (case evidence stays; attribution kept).
7. Rollback lane + `test_rollback_forward_compat.py`: plant and preserve.
8. nginx location + route body cap; OpenAPI regenerated (`npm run gen:types`,
   `check:types`), `webui/src/lib/types.ts` mirror.
9. Docs: `docs/administration/reset.md`, `docs/operations/health-backup.md` (backup size),
   USAGE, known limitations (no server-side pixel re-encode).

### 7.7 #9 and #3: screenshots never reach a model and never decide anything

* Keep screenshots off the `Case` model: chat tools project whitelisted case fields only
  (`backend/app/agents/chat_tools/cases.py:1-12` "No observation ever carries
  member_event_ids, history, verdict_history, comments or notification records"); the
  resolved-case RAG chunk is an allowlist (`backend/app/tools/rag.py:3875-3936`,
  `_resolved_case_text`); the investigator renders the cluster only.
* Never post a thread message for an upload (case-chat history and Ask AI read
  conversation text); use the `CaseActivity` feed for the friendly timeline entry.
* Captions and filenames are user text: plain-text rendering, never in a prompt, report
  digest, standup or starter; counts at most (#7).
* Tests: a sentinel caption/filename/bytes never appear in any gateway prompt after an
  upload followed by an investigation, a case chat turn, a report summary and a standup;
  a static test that `app/agents/**`, `app/engine/report_digest.py` and
  `app/engine/chat_starters.py` never import the case-files store.
* No route here imports `case_manager` or touches `decide()`; uploads on closed cases are
  allowed and change no status.

---

## 8. Tests that pin current behaviour (update or extend)

* Avatar validator: `backend/tests/test_account_profile.py:44-81`; `webui/src/lib/__tests__/avatar.test.ts`.
* Security headers: `backend/tests/test_auth_primitives.py:178`.
* Factory purge: `backend/tests/test_factory_storage_primitives.py:109-203`.
* Reset receipts: `backend/tests/test_runbook_stores.py:1194-1195`,
  `test_replay_fixtures.py:288`, `test_round4_wave4_reset.py`; `webui/src/soc/__tests__/danger-zone.test.tsx`.
* KV CAS: `backend/tests/test_es_kv_cas.py`.
* Export: `backend/tests/test_export_archive.py`, `test_discounted_inference_export.py`.
* Rollback: `backend/tests/test_rollback_forward_compat.py`, `test_postgres_rollback_compat.py`,
  `scripts/test_rollback_lane.py`.
* Audit table: `webui/src/soc/components/audit/__tests__/events.contract.test.ts`.
* nginx markers: `scripts/check_version.py:246-290`.
* RBAC vocabulary (only if a new action were added; the recommendation reuses
  `cases:read`/`comment`/`close`): `backend/tests/test_account_permissions_effective.py:33-256`.
