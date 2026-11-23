"""Round 15 WP4 (SPEC D5.7): the screenshot content field is mapped ``binary`` on the
Elasticsearch config index: at creation on a fresh install, additively at bootstrap on
an upgrade, never changing a field that already exists, never failing the boot."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.constants import CONFIG_INDEX
from app.es.base import BaseESClient
from app.es.client import RealESClient
from app.es.fake import InMemoryESClient
from app.es.indices import CASE_FILE_DATA_FIELD, bootstrap_indices, extend_config_mapping
from tests.test_factory_storage_primitives import _HTTPError, _real_client


def _field(es: InMemoryESClient) -> dict | None:
    name = es._resolve(CONFIG_INDEX)
    return (es.index_mappings.get(name, {}).get("properties") or {}).get(CASE_FILE_DATA_FIELD)


@pytest.mark.asyncio
async def test_fresh_install_creates_the_config_index_with_the_binary_field() -> None:
    es = InMemoryESClient()
    await bootstrap_indices(es)
    assert _field(es) == {"type": "binary"}
    assert es.index_mappings[CONFIG_INDEX]["dynamic"] is True
    assert await extend_config_mapping(es) == "present"
    # A second start changes nothing.
    await bootstrap_indices(es)
    assert _field(es) == {"type": "binary"}


@pytest.mark.asyncio
async def test_an_upgraded_config_index_gains_the_field_at_bootstrap() -> None:
    es = InMemoryESClient()
    await es.create_index(CONFIG_INDEX, {"mappings": {"dynamic": True}})
    await bootstrap_indices(es)
    assert _field(es) == {"type": "binary"}
    assert es.index_mappings[CONFIG_INDEX]["dynamic"] is True


@pytest.mark.asyncio
async def test_a_field_already_mapped_as_text_is_left_as_it_is() -> None:
    es = InMemoryESClient()
    text = {"type": "text", "fields": {"keyword": {"type": "keyword", "ignore_above": 256}}}
    await es.create_index(CONFIG_INDEX, {"mappings": {"dynamic": True, "properties": {CASE_FILE_DATA_FIELD: text}}})
    assert await extend_config_mapping(es) == "kept_text"
    assert _field(es) == text


class _Compat(BaseESClient):
    """A compatibility client that inherits the base defaults (no mapping support)."""

    async def ping(self): return True  # noqa: E704
    async def search_logs(self, index, body): return {}  # noqa: E704
    async def index_template_exists(self, name): return False  # noqa: E704
    async def put_index_template(self, name, body): return None  # noqa: E704
    async def index_exists(self, name): return True  # noqa: E704
    async def create_index(self, name, body=None): return None  # noqa: E704
    async def index_doc(self, index, doc, doc_id=None, refresh=False): return doc_id or "x"  # noqa: E704
    async def get_doc(self, index, doc_id): return None  # noqa: E704
    async def update_doc(self, index, doc_id, doc, refresh=False): return None  # noqa: E704
    async def search(self, index, body): return {"hits": {"hits": []}}  # noqa: E704
    async def count(self, index, body): return 0  # noqa: E704
    async def close(self): return None  # noqa: E704


@pytest.mark.asyncio
async def test_clients_that_cannot_map_are_reported_and_never_fail_the_boot() -> None:
    assert await extend_config_mapping(_Compat()) == "unsupported"
    assert await extend_config_mapping(SimpleNamespace()) == "unsupported"

    class _Broken(InMemoryESClient):
        async def get_index_mapping(self, index):
            raise RuntimeError("cluster red")

    assert await extend_config_mapping(_Broken()) == "failed"

    class _NoPut(InMemoryESClient):
        async def put_index_mapping(self, index, body):
            raise RuntimeError("forbidden")

    es = _NoPut()
    await es.create_index(CONFIG_INDEX, {"mappings": {"dynamic": True}})
    assert await extend_config_mapping(es) == "failed"


@pytest.mark.asyncio
async def test_base_defaults_raise_not_implemented() -> None:
    with pytest.raises(NotImplementedError):
        await _Compat().get_index_mapping(CONFIG_INDEX)
    with pytest.raises(NotImplementedError):
        await _Compat().put_index_mapping(CONFIG_INDEX, {})


@pytest.mark.asyncio
async def test_real_client_reads_and_extends_mappings_through_the_management_key() -> None:
    mgmt = SimpleNamespace(indices=SimpleNamespace(
        get_mapping=AsyncMock(return_value={CONFIG_INDEX: {"mappings": {"dynamic": True}}}),
        put_mapping=AsyncMock(return_value={"acknowledged": True}),
    ))
    client = _real_client(mgmt)
    assert await extend_config_mapping(client) == "added"
    mgmt.indices.get_mapping.assert_awaited_once_with(
        index=CONFIG_INDEX, ignore_unavailable=True, allow_no_indices=True,
    )
    mgmt.indices.put_mapping.assert_awaited_once_with(
        index=CONFIG_INDEX, properties={CASE_FILE_DATA_FIELD: {"type": "binary"}},
    )

    mgmt.indices.get_mapping.side_effect = _HTTPError(404)
    assert await client.get_index_mapping(CONFIG_INDEX) == {}
    mgmt.indices.get_mapping.side_effect = _HTTPError(503)
    with pytest.raises(_HTTPError):
        await client.get_index_mapping(CONFIG_INDEX)


def test_the_audit_upgrade_path_stays_as_it_was_on_the_real_client() -> None:
    """Round 15 adds the two mapping methods only; the real client still has no
    ``get_index_template``, so the Round 14 audit upgrade keeps its operator step."""
    assert getattr(RealESClient, "get_index_template", None) is None
