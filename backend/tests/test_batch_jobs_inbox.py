"""Durable, generation-safe Inbox alignment for existing LLM Batch work."""

from __future__ import annotations

import pytest

from app.config import RBACConfig
from app.constants import BatchJobState, UserRole
from app.engine.batch_inbox import (
    batch_inbox_job_id,
    eligible_batch_audience,
    filter_visible_batch_notes,
    reconcile_batch_inbox,
)
from app.models import BatchJob, User


def _batch(batch_id: str = "batch-visible") -> BatchJob:
    return BatchJob(
        id=batch_id,
        provider="openai",
        provider_batch_id="provider-secret-handle",
        state=BatchJobState.POLLING,
        model="gpt-test",
        submitted_at="2026-08-13T00:00:00+00:00",
        custom_ids={
            "case-secret-id": {"retrieved": False, "result_state": None}
        },
        requests=[{"custom_id": "case-secret-id", "params": {"secret": "never"}}],
        candidates={"case-secret-id": {"raw": "never"}},
        inbox_audience_state="pending",
    )


async def _save_users(state, *users: User) -> None:
    for user in users:
        await state.users.save(user)
    await state.refresh_users()


@pytest.mark.asyncio
async def test_new_batch_projects_one_safe_stable_note_and_terminal_update(app_state):
    batch = _batch()
    batch, created = await app_state.real_batch_job_store.create_if_absent(batch)
    assert created is True
    await reconcile_batch_inbox(app_state, batch)

    notes, total = await app_state.real_inbox.list_for_user(None)
    assert total == 1
    note = notes[0]
    stable_id = note.id
    assert note.job_id == batch_inbox_job_id(batch.id)
    assert note.job_status.value == "running"
    rendered = note.model_dump_json()
    assert "provider-secret-handle" not in rendered
    assert "case-secret-id" not in rendered
    assert '"raw":"never"' not in rendered

    await app_state.real_inbox.mark_read(None, note.id)
    batch.state = BatchJobState.RETRIEVED
    batch.custom_ids["case-secret-id"] = {
        "retrieved": True,
        "result_state": "succeeded",
        "reentry_state": "not_required",
    }
    batch = await app_state.real_batch_job_store.save(batch)
    assert batch.terminal_compacted is True
    assert batch.requests == [] and batch.custom_ids == {} and batch.candidates == {}
    await reconcile_batch_inbox(app_state, batch)

    notes, total = await app_state.real_inbox.list_for_user(None)
    assert total == 1 and notes[0].id == stable_id
    assert notes[0].state == "unseen"
    assert notes[0].job_status.value == "succeeded"
    assert notes[0].result is not None


@pytest.mark.asyncio
async def test_legacy_batch_is_list_only_and_never_guesses_audience(app_state):
    legacy = _batch("batch-legacy").model_copy(
        update={"inbox_audience_state": "legacy"}
    )
    await app_state.real_batch_job_store.create_if_absent(legacy)
    await reconcile_batch_inbox(app_state, legacy)
    notes, total = await app_state.real_inbox.list_for_user(None)
    assert total == 0 and notes == []


@pytest.mark.asyncio
async def test_auth_audience_honours_rbac_generation_and_permission_revocation(app_state):
    # Turn the existing fixture into an auth/RBAC-aware state without re-opening a
    # network/runtime. The AuthService's live enable flag and persisted registries are
    # the exact inputs the audience resolver uses.
    app_state.auth._enabled = True  # noqa: SLF001 - focused authorization fixture
    await _save_users(
        app_state,
        User(username="alice", role=UserRole.ANALYST_TIER1),
        User(username="bob", role=UserRole.ANALYST_TIER1),
    )
    app_state.prefs = app_state.prefs.model_copy(
        update={
            "rbac": RBACConfig(
                enabled=True,
                denies={"analyst_tier1": {"models": ["read"]}},
            )
        }
    )
    # Persisted users are denied; the environment admin remains eligible.
    audience = await eligible_batch_audience(app_state)
    assert [member.account_generation for member in audience] == ["env-admin"]

    app_state.prefs = app_state.prefs.model_copy(
        update={"rbac": RBACConfig(enabled=False)}
    )
    batch = _batch("batch-auth")
    await app_state.real_batch_job_store.create_if_absent(batch)
    await reconcile_batch_inbox(app_state, batch)
    stored = await app_state.real_batch_job_store.get_strict(batch.id)
    assert stored is not None and stored.inbox_audience_state == "ready"
    assert {member.username.lower() for member in stored.inbox_audience} >= {
        "alice",
        "bob",
    }
    alice_generation = next(
        member.account_generation
        for member in stored.inbox_audience
        if member.username.lower() == "alice"
    )
    alice_notes, _ = await app_state.real_inbox.list_for_user("alice")
    assert len(alice_notes) == 1

    # Delete/recreate the mutable username. The old generation's note is removed,
    # and the replacement is not added to the frozen snapshot.
    await app_state.users.delete("alice")
    await app_state.users.save(User(username="alice", role=UserRole.ANALYST_TIER1))
    await app_state.refresh_users()
    current = await app_state.real_batch_job_store.get_strict(batch.id)
    await reconcile_batch_inbox(app_state, current)
    alice_notes, _ = await app_state.real_inbox.list_for_user("alice")
    assert alice_notes == []
    current = await app_state.real_batch_job_store.get_strict(batch.id)
    old_member = next(
        member for member in current.inbox_audience if member.username.lower() == "alice"
    )
    assert old_member.account_generation == alice_generation
    assert old_member.state == "revoked"


@pytest.mark.asyncio
async def test_live_filter_fails_closed_on_wrong_generation(app_state):
    batch = _batch("batch-filter")
    await app_state.real_batch_job_store.create_if_absent(batch)
    await reconcile_batch_inbox(app_state, batch)
    notes, _ = await app_state.real_inbox.list_for_user(None)
    assert len(notes) == 1
    wrong = notes[0].model_copy(update={"audience_generation": "wrong"})
    assert await filter_visible_batch_notes(app_state, "default", [wrong]) == []


@pytest.mark.asyncio
async def test_batch_mutation_is_rejected_while_factory_fence_is_active(app_state):
    # A strict factory fence is authoritative across processes and namespaces.
    await app_state.kv.put_strict(
        "jobs",
        "jobs",
        {"jobs": {}, "idempotency": {}, "factory_fence": "factory-job"},
    )
    with pytest.raises(RuntimeError, match="factory reset"):
        await app_state.real_batch_job_store.create_if_absent(_batch("batch-fenced"))
