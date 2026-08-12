"""Stable idempotency authority for the rolling Elasticsearch ledgers.

Elasticsearch document ids are unique only inside one concrete index.  Audit and
usage rows live behind rollover aliases, so ``op_type=create`` on the current write
index cannot by itself prevent the same logical id from appearing again after a
rollover.  This module reserves each keyed append in the existing, non-rolling
``CONFIG_INDEX`` and treats the rolling ledger row as a recoverable projection.

The claim is written before the projection and contains the first writer's complete
JSON payload.  A retry never treats a pending (or even committed) claim as proof that
the projection exists: it searches the full read pattern, creates the missing row
atomically when necessary, verifies the exact stored payload, and only then finalises
the claim with compare-and-set.  Thus an interruption at either side of the write is
recoverable without changing the first timestamp/build provenance.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from typing import Any

from ..constants import CONFIG_INDEX
from ..es.base import BaseESClient

logger = logging.getLogger("tlsoc.stores.ledger_claims")

_CLAIM_KIND = "ledger_claim"
_CLAIM_SCHEMA = 1
_CLAIM_PREFIX = "ledger-claim"
_CLAIM_FINALISE_ATTEMPTS = 8
_CLAIM_LEASE_SECONDS = 60.0
_CLAIM_WAIT_ATTEMPTS = 20
_CLAIM_WAIT_SECONDS = 0.01


def ledger_claim_doc_id(scope: str, logical_id: str) -> str:
    """Return a bounded, domain-separated CONFIG_INDEX id for one ledger key."""

    digest = hashlib.sha256(
        f"{scope}\0{logical_id}".encode("utf-8", errors="strict")
    ).hexdigest()
    return f"{_CLAIM_PREFIX}:{scope}:{digest}"


async def append_keyed_ledger_row(
    es: BaseESClient,
    *,
    scope: str,
    logical_id: str,
    payload: dict[str, Any],
    write_alias: str,
    read_pattern: str,
    reject_conflicting_retry: bool,
    retry_metadata: frozenset[str] = frozenset(),
) -> None:
    """Append one keyed row exactly once across the lifetime of a rolling ledger.

    ``reject_conflicting_retry`` is enabled for deterministic audit event ids: the
    same id with different semantic evidence fails closed.  Usage idempotency keys
    deliberately retain the first bill even if a later retry reconstructs different
    metering fields, so their later payload is ignored after the claim is acquired.
    """

    if not scope or not logical_id:
        raise ValueError("a keyed ledger append requires a scope and logical id")

    proposed = dict(payload)
    claim_id = ledger_claim_doc_id(scope, logical_id)
    owner_token = uuid.uuid4().hex

    # Backwards compatibility for rows written before stable claims existed.  Adopt
    # the existing immutable row verbatim (including absent/partial provenance) rather
    # than attributing it to the build which first happens to retry it after upgrade.
    projection = await _find_projection(es, read_pattern, logical_id)
    if projection is not None:
        _validate_retry(
            logical_id,
            proposed,
            projection["payload"],
            reject_conflicting_retry=reject_conflicting_retry,
            retry_metadata=retry_metadata,
        )
        authoritative = projection["payload"]
    else:
        authoritative = proposed

    candidate = _new_claim(scope, logical_id, authoritative, owner_token)
    created = await es.create_doc_strict(
        CONFIG_INDEX,
        claim_id,
        candidate,
        refresh=True,
    )
    claim = candidate if created else await es.get_doc_strict(CONFIG_INDEX, claim_id)
    if claim is None:
        raise RuntimeError(
            f"{scope} ledger claim conflicted but could not be read: {logical_id}"
        )

    claimed_payload = _claim_payload(claim, scope, logical_id)
    _validate_retry(
        logical_id,
        proposed,
        claimed_payload,
        reject_conflicting_retry=reject_conflicting_retry,
        retry_metadata=retry_metadata,
    )

    try:
        # Claim state is never used as a shortcut.  A crash after claim creation, a
        # lost response after the append, or a manually recreated rolling index all
        # converge by confirming the full read pattern.  Only the current claim-lease
        # owner may create a missing projection: without that fence, two recovery
        # callers could create in different backing indices if ILM rolled the alias
        # between their create operations.
        owns_lease, projection = await _projection_or_lease(
            es,
            claim_id=claim_id,
            scope=scope,
            logical_id=logical_id,
            claimed_payload=claimed_payload,
            read_pattern=read_pattern,
            owner_token=owner_token,
        )
        if projection is None:
            if not owns_lease:
                raise RuntimeError(
                    f"{scope} ledger projection lease was not acquired: {logical_id}"
                )
            await es.create_doc_strict(
                write_alias,
                logical_id,
                claimed_payload,
                refresh=True,
            )
            projection = await _find_projection(es, read_pattern, logical_id)
            if projection is None:
                raise RuntimeError(
                    f"{scope} ledger projection was not globally confirmed: {logical_id}"
                )

        if _canonical_json(projection["payload"]) != _canonical_json(claimed_payload):
            raise RuntimeError(f"{scope} ledger projection collision: {logical_id}")

        await _finalise_claim(
            es,
            claim_id=claim_id,
            scope=scope,
            logical_id=logical_id,
            claimed_payload=claimed_payload,
            projection_index=projection["index"],
        )
    except Exception:
        # An ordinary backend failure releases immediately so the next retry need not
        # wait for the crash-safety lease. A hard process/container loss cannot run
        # this path; its lease expires and is then acquired by a later retry.
        try:
            await _release_claim_lease(
                es,
                claim_id=claim_id,
                scope=scope,
                logical_id=logical_id,
                owner_token=owner_token,
            )
        except Exception as release_exc:  # noqa: BLE001
            # Preserve the persistence failure which made the operation ambiguous.
            # A failed release remains safe because its bounded lease expires.
            logger.warning(
                "%s ledger projection lease release failed for %s: %s",
                scope,
                logical_id,
                release_exc,
            )
        raise


async def clear_ledger_claims(es: BaseESClient, scope: str) -> int:
    """Delete all CONFIG_INDEX claims for ``scope`` and verify each deletion.

    Factory audit reset is the one supported exception to append-only history.  Its
    stable claims must be cleared with the ledger; otherwise retrying a pre-reset id
    would silently recreate the erased evidence from a stale pending claim.
    """

    deleted = 0
    while True:
        response = await es.search(
            CONFIG_INDEX,
            {
                "size": 500,
                "query": {
                    "bool": {
                        "filter": [
                            {"term": {"ledger_claim_kind": _CLAIM_KIND}},
                            {"term": {"ledger_claim_scope": scope}},
                        ]
                    }
                },
                "_source": False,
            },
        )
        hits = response.get("hits", {}).get("hits", [])
        if not hits:
            return deleted

        progressed = 0
        for hit in hits:
            claim_id = str(hit.get("_id") or "")
            if not claim_id:
                raise RuntimeError(f"{scope} ledger claim search returned no document id")
            remove = getattr(es, "delete_doc", None)
            if remove is None:
                raise RuntimeError("Elasticsearch client cannot clear ledger claims")
            removed = await remove(CONFIG_INDEX, claim_id, refresh=True)
            if not removed and await es.get_doc_strict(CONFIG_INDEX, claim_id) is not None:
                raise RuntimeError(f"could not clear {scope} ledger claim: {claim_id}")
            progressed += 1
            deleted += 1

        if progressed == 0:
            raise RuntimeError(f"{scope} ledger claim cleanup made no progress")


async def _find_projection(
    es: BaseESClient, read_pattern: str, logical_id: str
) -> dict[str, Any] | None:
    response = await es.search(
        read_pattern,
        {
            "size": 2,
            "track_total_hits": True,
            "query": {"ids": {"values": [logical_id]}},
        },
    )
    hits = response.get("hits", {}).get("hits", [])
    total_raw = response.get("hits", {}).get("total", len(hits))
    total = (
        int(total_raw.get("value", len(hits)))
        if isinstance(total_raw, dict)
        else int(total_raw or 0)
    )
    if total > 1 or len(hits) > 1:
        indices = sorted(str(hit.get("_index") or "") for hit in hits)
        raise RuntimeError(
            f"ledger id exists in multiple rollover indices: {logical_id} ({indices})"
        )
    if not hits:
        return None
    source = hits[0].get("_source")
    if not isinstance(source, dict):
        raise TypeError(f"ledger row has no object payload: {logical_id}")
    return {"index": str(hits[0].get("_index") or read_pattern), "payload": source}


async def _projection_or_lease(
    es: BaseESClient,
    *,
    claim_id: str,
    scope: str,
    logical_id: str,
    claimed_payload: dict[str, Any],
    read_pattern: str,
    owner_token: str,
) -> tuple[bool, dict[str, Any] | None]:
    """Return an existing projection or exclusively lease creation of a missing one."""

    for attempt in range(_CLAIM_WAIT_ATTEMPTS):
        projection = await _find_projection(es, read_pattern, logical_id)
        if projection is not None:
            return False, projection

        current = await es.get_doc_strict(CONFIG_INDEX, claim_id)
        if current is None:
            raise RuntimeError(f"{scope} ledger claim disappeared: {logical_id}")
        current_payload = _claim_payload(current, scope, logical_id)
        if _canonical_json(current_payload) != _canonical_json(claimed_payload):
            raise RuntimeError(f"{scope} ledger claim changed payload: {logical_id}")

        now = time.time()
        current_owner = str(current.get("ledger_projection_owner") or "")
        try:
            lease_until = float(current.get("ledger_projection_lease_until", 0.0) or 0.0)
        except (TypeError, ValueError):
            lease_until = 0.0

        if current_owner == owner_token and lease_until > now:
            return True, None

        if not current_owner or lease_until <= now:
            revision = _claim_revision(current, scope, logical_id)
            leased = {
                **current,
                "ledger_projection_owner": owner_token,
                "ledger_projection_lease_until": now + _CLAIM_LEASE_SECONDS,
                "_rev": revision + 1,
            }
            if await es.compare_and_set_doc(
                CONFIG_INDEX,
                claim_id,
                leased,
                expected_rev=revision,
                refresh=True,
            ):
                return True, None
            continue

        if attempt + 1 < _CLAIM_WAIT_ATTEMPTS:
            await asyncio.sleep(_CLAIM_WAIT_SECONDS)

    raise RuntimeError(f"{scope} ledger projection is already in progress: {logical_id}")


async def _release_claim_lease(
    es: BaseESClient,
    *,
    claim_id: str,
    scope: str,
    logical_id: str,
    owner_token: str,
) -> None:
    """Best-effort immediate handoff after a recoverable projection failure."""

    for _attempt in range(_CLAIM_FINALISE_ATTEMPTS):
        current = await es.get_doc_strict(CONFIG_INDEX, claim_id)
        if current is None:
            return
        _claim_payload(current, scope, logical_id)
        if current.get("ledger_projection_owner") != owner_token:
            return
        revision = _claim_revision(current, scope, logical_id)
        released = {
            **current,
            "ledger_projection_owner": None,
            "ledger_projection_lease_until": 0.0,
            "_rev": revision + 1,
        }
        if await es.compare_and_set_doc(
            CONFIG_INDEX,
            claim_id,
            released,
            expected_rev=revision,
            refresh=True,
        ):
            return


def _new_claim(
    scope: str,
    logical_id: str,
    payload: dict[str, Any],
    owner_token: str,
) -> dict[str, Any]:
    payload_json = _canonical_json(payload)
    return {
        "ledger_claim_kind": _CLAIM_KIND,
        "ledger_claim_schema": _CLAIM_SCHEMA,
        "ledger_claim_scope": scope,
        "ledger_logical_id": logical_id,
        # JSON text avoids dynamically mapping attacker-controlled audit tool_input
        # keys inside the shared config index while retaining an exact recovery image.
        "ledger_payload_json": payload_json,
        "ledger_payload_sha256": hashlib.sha256(
            payload_json.encode("utf-8")
        ).hexdigest(),
        "ledger_claim_state": "pending",
        "ledger_projection_index": None,
        "ledger_projection_owner": owner_token,
        "ledger_projection_lease_until": time.time() + _CLAIM_LEASE_SECONDS,
        "_rev": 0,
    }


def _claim_payload(
    claim: dict[str, Any], scope: str, logical_id: str
) -> dict[str, Any]:
    if (
        claim.get("ledger_claim_kind") != _CLAIM_KIND
        or int(claim.get("ledger_claim_schema", 0) or 0) != _CLAIM_SCHEMA
        or claim.get("ledger_claim_scope") != scope
        or claim.get("ledger_logical_id") != logical_id
        or claim.get("ledger_claim_state") not in {"pending", "committed"}
    ):
        raise RuntimeError(f"{scope} ledger claim collision: {logical_id}")
    payload_json = claim.get("ledger_payload_json")
    if not isinstance(payload_json, str):
        raise TypeError(f"{scope} ledger claim has no recovery payload: {logical_id}")
    fingerprint = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
    if claim.get("ledger_payload_sha256") != fingerprint:
        raise RuntimeError(f"{scope} ledger claim recovery payload is corrupt: {logical_id}")
    try:
        payload = json.loads(payload_json)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(
            f"{scope} ledger claim recovery payload is invalid: {logical_id}"
        ) from exc
    if not isinstance(payload, dict):
        raise TypeError(
            f"{scope} ledger claim recovery payload is not an object: {logical_id}"
        )
    return payload


def _validate_retry(
    logical_id: str,
    incoming: dict[str, Any],
    authoritative: dict[str, Any],
    *,
    reject_conflicting_retry: bool,
    retry_metadata: frozenset[str],
) -> None:
    if not reject_conflicting_retry:
        return
    incoming_semantic = {
        key: value for key, value in incoming.items() if key not in retry_metadata
    }
    authoritative_semantic = {
        key: value for key, value in authoritative.items() if key not in retry_metadata
    }
    if incoming_semantic != authoritative_semantic:
        raise RuntimeError(f"audit event id collision: {logical_id}")


def _claim_revision(claim: dict[str, Any], scope: str, logical_id: str) -> int:
    try:
        return int(claim.get("_rev", 0) or 0)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(
            f"{scope} ledger claim has invalid revision: {logical_id}"
        ) from exc


async def _finalise_claim(
    es: BaseESClient,
    *,
    claim_id: str,
    scope: str,
    logical_id: str,
    claimed_payload: dict[str, Any],
    projection_index: str,
) -> None:
    for _attempt in range(_CLAIM_FINALISE_ATTEMPTS):
        current = await es.get_doc_strict(CONFIG_INDEX, claim_id)
        if current is None:
            raise RuntimeError(f"{scope} ledger claim disappeared: {logical_id}")
        current_payload = _claim_payload(current, scope, logical_id)
        if _canonical_json(current_payload) != _canonical_json(claimed_payload):
            raise RuntimeError(f"{scope} ledger claim changed payload: {logical_id}")
        current_owner = str(current.get("ledger_projection_owner") or "")
        try:
            lease_until = float(
                current.get("ledger_projection_lease_until", 0.0) or 0.0
            )
        except (TypeError, ValueError):
            lease_until = -1.0
        if (
            current.get("ledger_claim_state") == "committed"
            and current.get("ledger_projection_index") == projection_index
            and not current_owner
            and lease_until == 0.0
        ):
            return
        revision = _claim_revision(current, scope, logical_id)
        committed = {
            **current,
            "ledger_claim_state": "committed",
            "ledger_projection_index": projection_index,
            "ledger_projection_owner": None,
            "ledger_projection_lease_until": 0.0,
            "_rev": revision + 1,
        }
        if await es.compare_and_set_doc(
            CONFIG_INDEX,
            claim_id,
            committed,
            expected_rev=revision,
            refresh=True,
        ):
            return
    raise RuntimeError(f"{scope} ledger claim could not be finalised: {logical_id}")


def _canonical_json(payload: dict[str, Any]) -> str:
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
