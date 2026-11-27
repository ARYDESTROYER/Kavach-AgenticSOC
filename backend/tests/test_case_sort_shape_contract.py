"""SHAPE contract for the case-list sort allow-list.

A companion to ``test_portability_contract.py``, kept as its own module so the two can be
edited independently. Same discipline: SHAPE rules only. The portability contract forbids
a vocabulary blocklist by design — a list of forbidden product names is unmaintainable and
is obsolete the day someone ships a new connector — so what is asserted here is structural.

Two things have to hold, and neither is provable by the tests that exercise the endpoint:

* every allow-listed field is a UNIVERSAL ``Case`` field, so the sort menu a deployment
  is offered cannot name something only one estate's records carry; and
* every allow-listed field is really sortable on BOTH bundled backends. That has to be
  checked against the REAL Elasticsearch index mapping and the REAL SQL column
  derivation, because the in-memory Elasticsearch client accepts ANY sort key and
  resolves an unplaceable value to a sentinel — so a test that only exercised the offline
  double would pass on a field that returns a 400 from a real cluster.
"""

from __future__ import annotations

from app.api.routes import (
    CASE_SORT_FIELD_DEFAULT,
    CASE_SORT_FIELDS,
    CASE_SORT_ORDER_DEFAULT,
    CASE_SORT_ORDERS,
)
from app.es.indices import CASES_MAPPING
from app.models import Case
from app.stores.sql.models import CaseRow
from app.stores.sql.repositories import _case_sort_column

# Elasticsearch field types a ``sort`` clause can actually order by. ``text`` is
# deliberately absent: sorting a text field without fielddata is rejected outright, which
# is the failure mode an allow-list exists to make impossible.
SORTABLE_ES_TYPES = {"date", "float", "double", "long", "integer", "short", "byte", "keyword", "boolean"}


def test_the_allow_list_is_a_non_empty_closed_set() -> None:
    """Guard against a vacuous sweep: an empty allow-list would pass every rule below."""
    assert len(CASE_SORT_FIELDS) > 0
    assert len(set(CASE_SORT_FIELDS)) == len(CASE_SORT_FIELDS)
    assert CASE_SORT_FIELD_DEFAULT in CASE_SORT_FIELDS
    assert CASE_SORT_ORDER_DEFAULT in CASE_SORT_ORDERS
    # Exactly the two directions the query languages accept, and nothing else.
    assert set(CASE_SORT_ORDERS) == {"asc", "desc"}


def test_every_sortable_field_is_a_universal_case_field() -> None:
    """No deployer-invented field name, no estate-specific column, no raw log path.

    A sort option the console offers has to exist on every case in every deployment, or
    the menu promises an ordering that some estates cannot produce.
    """
    for field in CASE_SORT_FIELDS:
        assert field in Case.model_fields, field
        # A nested path would need a mapping and a column of its own on both backends.
        assert "." not in field and not field.startswith("_"), field


def test_every_sortable_field_is_orderable_on_the_real_elasticsearch_mapping() -> None:
    properties = CASES_MAPPING["properties"]
    for field in CASE_SORT_FIELDS:
        assert field in properties, f"{field} is not mapped, so a real cluster cannot sort it"
        spec = properties[field]
        assert spec.get("enabled", True) is not False, field
        assert spec.get("type") in SORTABLE_ES_TYPES, (field, spec.get("type"))


def test_every_sortable_field_has_its_own_sql_order_by_expression() -> None:
    """The SQL repository answers an unknown field in ``created_at`` order without
    raising, which is precisely why "it did not error" proves nothing. Each allow-listed
    field must resolve to a DISTINCT expression, or it is silently taking the fallback."""
    fallback = str(CaseRow.created_at)
    for field in CASE_SORT_FIELDS:
        rendered = str(_case_sort_column(field))
        if field == "created_at":
            assert rendered == fallback
        else:
            assert rendered != fallback, f"{field} silently falls back to created_at"


def test_a_field_outside_the_allow_list_is_not_orderable_on_both_backends() -> None:
    """The rule has teeth: at least one plausible-looking field is excluded for a reason.

    ``title`` is mapped ``text`` (a real cluster refuses to sort it) and the SQL
    repository has no expression for it. If a future change made the allow-list open, this
    is the assertion that notices.
    """
    assert "title" not in CASE_SORT_FIELDS
    assert CASES_MAPPING["properties"]["title"]["type"] == "text"
    assert str(_case_sort_column("title")) == str(CaseRow.created_at)
    # The read-time advisory band is stored, mapped and materialised nowhere at all, so
    # no store can order or filter by it — it must never appear in the allow-list.
    assert "severity_band" not in CASE_SORT_FIELDS
    assert "severity_band" not in CASES_MAPPING["properties"]
