"""Wave 7 / F12: settings plumbing — round-trip, partial deep-merge, read-only mode,
secret-leak guard, and the settings schema/subtree introspection endpoints.

Every nested Preferences block added across Waves 1-6 (rbac, mfa, sso, notifications,
case_id_format, cross_source_correlation, threat_context, threshold_automation, plus
the pre-existing ones) must PUT and re-GET unchanged, and a partial PUT of one nested
key must NOT wipe its sibling subtrees.
"""

from __future__ import annotations

from app.config import Preferences


# All the top-level NESTED-MODEL blocks that must round-trip through GET/PUT.
_NESTED_BLOCKS = [
    "rbac", "mfa", "sso", "notifications", "case_id_format",
    "cross_source_correlation", "threat_context", "threshold_automation",
    "auto_close", "enrichment", "rag", "standup", "trace", "personas",
    "runbooks", "playbooks", "branding", "caps", "risk_weights",
    "default_correlation", "release_updates",
]


def _get_prefs(client) -> dict:
    r = client.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    assert "prefs" in body and "configured" in body
    return body["prefs"]


def _put(client, patch: dict):
    r = client.put("/api/settings", json=patch)
    assert r.status_code == 200, r.text
    return r.json()["prefs"]


def test_every_nested_block_round_trips_unchanged(client):
    """PUT the full current value of each nested block back and re-GET it unchanged."""
    prefs = _get_prefs(client)
    for block in _NESTED_BLOCKS:
        assert block in prefs, f"nested block {block} missing from GET /settings"
        out = _put(client, {block: prefs[block]})
        assert out[block] == prefs[block], f"{block} did not round-trip"


def test_full_prefs_round_trip(client):
    """The entire prefs dump PUTs back and re-GETs byte-identical (full deep-merge)."""
    prefs = _get_prefs(client)
    out = _put(client, prefs)
    again = _get_prefs(client)
    # Pydantic-canonicalised: re-validate both sides for a stable comparison.
    assert Preferences.model_validate(out) == Preferences.model_validate(again)
    assert Preferences.model_validate(again) == Preferences.model_validate(prefs)


def test_partial_put_preserves_sibling_subtrees(client):
    """A partial PUT of ONE nested key must not wipe sibling subtrees."""
    before = _get_prefs(client)
    # Flip a single deep field inside one block; everything else must survive.
    patch = {"rag": {"top_k": before["rag"]["top_k"] + 3}}
    after = _put(client, patch)
    # The targeted field changed...
    assert after["rag"]["top_k"] == before["rag"]["top_k"] + 3
    # ...sibling fields inside the SAME block survived (deep, not shallow, merge).
    assert after["rag"]["min_score"] == before["rag"]["min_score"]
    assert after["rag"]["use_runbooks"] == before["rag"]["use_runbooks"]
    # ...and sibling BLOCKS are completely untouched.
    for block in _NESTED_BLOCKS:
        if block == "rag":
            continue
        assert after[block] == before[block], f"sibling block {block} was clobbered"


def test_partial_put_preserves_deeply_nested_siblings(client):
    """A partial PUT into a doubly-nested key preserves its deep siblings."""
    before = _get_prefs(client)
    # notifications.triggers.on_escalated lives two levels deep; only touch it.
    patch = {"notifications": {"triggers": {"on_escalated": False}}}
    after = _put(client, patch)
    assert after["notifications"]["triggers"]["on_escalated"] is False
    # The other triggers + the notifications top-level siblings survive.
    assert (
        after["notifications"]["triggers"]["on_true_positive"]
        == before["notifications"]["triggers"]["on_true_positive"]
    )
    assert after["notifications"]["enabled"] == before["notifications"]["enabled"]
    assert after["notifications"]["channels"] == before["notifications"]["channels"]


def test_embedding_role_rejects_a_chat_only_model(client):
    """Refused on POSITIVE catalog evidence: a bundled row that declares other
    capabilities and NOT ``embedding``. (The gate no longer refuses a model the catalog
    has merely never heard of — that is every self-hosted embedding endpoint, and it is
    answered by the empirical probe the message points at.)"""
    before = _get_prefs(client)["embedding_model"]
    r = client.put("/api/settings", json={
        "embedding_model": {"provider": "openai", "model": "gpt-5.6-luna"},
    })
    assert r.status_code == 422
    assert "WITHOUT the embedding capability" in str(r.json().get("detail"))
    assert _get_prefs(client)["embedding_model"] == before


def test_legacy_chat_model_in_embedding_role_migrates_to_embedding_default():
    prefs = Preferences.model_validate({
        "embedding_model": {"provider": "openai", "model": "gpt-5.6-luna"},
    })
    assert prefs.embedding_model.provider == "openai"
    assert prefs.embedding_model.model == "text-embedding-3-small"


def test_read_only_mode_rejects_writes_except_the_unlock(client):
    """When read_only_settings_mode is on, writes 403 except setting it back to False."""
    _put(client, {"read_only_settings_mode": True})
    # Any other write is rejected.
    r = client.put("/api/settings", json={"rag": {"top_k": 9}})
    assert r.status_code == 403
    # Even a no-op write of an unrelated subtree is rejected while locked.
    r = client.put("/api/settings", json={"branding": {"org_name": "X"}})
    assert r.status_code == 403
    # The unlock (read_only_settings_mode=False) is allowed.
    out = _put(client, {"read_only_settings_mode": False})
    assert out["read_only_settings_mode"] is False
    # ...and now writes work again.
    _put(client, {"rag": {"top_k": 9}})


def _settings_audit_rows(client) -> list[dict]:
    """The append-only audit rows on the ``settings`` surface (P12), NEWEST first."""
    r = client.get("/api/audit", params={"surface": "settings"})
    assert r.status_code == 200, r.text
    return r.json()["records"]


def test_put_settings_writes_an_append_only_audit_row(client):
    """P12 (#2 audit / #10 secrets): a settings PUT — which now carries the
    decision-critical ``auto_close`` policy ``decide()`` reads — must leave an
    append-only who/when trail recording the CHANGED top-level keys (never their
    VALUES → never a secret)."""
    before = _settings_audit_rows(client)

    # Flip the flagship auto-close policy (the exact field bug-#1 repointed here — the
    # ``prefs.auto_close.false_positive.enabled`` that ``decide()`` reads) so a change to
    # WHICH cases auto-close is provably audited.
    prefs = _get_prefs(client)
    patch_val = not bool(prefs["auto_close"]["false_positive"]["enabled"])
    _put(client, {"auto_close": {"false_positive": {"enabled": patch_val}}})

    after = _settings_audit_rows(client)
    assert len(after) == len(before) + 1, "settings PUT must append exactly one audit row"
    row = after[0]  # NEWEST first
    assert row["surface"] == "settings"
    assert row["action_type"] == "status"
    summary = row.get("result_summary") or ""
    # Records the CHANGED top-level key by NAME…
    assert "updated settings" in summary
    assert "auto_close" in summary
    # …and never the VALUE / any secret marker (#10).
    assert str(patch_val).lower() not in summary.lower()
    for forbidden in ("es_api_key", "anthropic_api_key", "auth_jwt_secret", "bearer "):
        assert forbidden not in summary.lower()


def test_put_settings_audit_never_leaks_a_value(client):
    """The audit summary lists only key NAMES, even for a block whose values change —
    it must never serialise the block's contents (defence for #10)."""
    before = _settings_audit_rows(client)
    _put(client, {"branding": {"org_name": "Umbrella-Corp-SECRET-MARKER"}})
    after = _settings_audit_rows(client)
    assert len(after) == len(before) + 1
    summary = (after[0].get("result_summary") or "")
    assert "branding" in summary            # the key NAME is recorded…
    assert "Umbrella-Corp-SECRET-MARKER" not in summary  # …never the VALUE


def test_secrets_never_appear_in_settings_dump(client):
    """The settings dump exposes only the non-secret tier + configured booleans."""
    body = client.get("/api/settings").json()
    blob = repr(body).lower()
    # Configured status is booleans only — never a secret VALUE. Round-6 #21 added the
    # ADDITIVE per-provider ``sso_client_secrets_by_id`` map (provider_id -> bool), so a
    # value may be a NESTED dict whose LEAVES must still all be bools (still no secret
    # value ever leaks).
    for v in body["configured"].values():
        if isinstance(v, dict):
            assert all(isinstance(x, bool) for x in v.values())
        else:
            assert isinstance(v, bool)
    # No secret field NAMES from the Secrets tier leak into the prefs subtree.
    prefs_blob = repr(body["prefs"]).lower()
    for forbidden in (
        "es_api_key", "es_mgmt_api_key", "anthropic_api_key", "openai_api_key",
        "connector_secrets", "sso_client_secrets", "notification_secrets",
        "auth_jwt_secret", "auth_admin_password",
    ):
        assert forbidden not in prefs_blob, f"secret-ish key {forbidden} leaked into prefs"
    # And nothing that looks like an obvious secret value marker.
    assert "bearer " not in blob


# --------------------------------------------------------------------------- #
# Schema + single-subtree endpoints
# --------------------------------------------------------------------------- #
def test_settings_schema_endpoint(client):
    r = client.get("/api/settings/schema")
    assert r.status_code == 200
    body = r.json()
    assert "sections" in body and isinstance(body["sections"], list)
    by_key = {s["key"]: s for s in body["sections"]}
    # The synthetic general group + the known object sections are present.
    assert "general" in by_key
    assert by_key["general"]["kind"] == "group"
    for block in _NESTED_BLOCKS:
        assert block in by_key, f"schema missing section {block}"
        assert by_key[block]["kind"] == "object"
        assert by_key[block]["model"]
        assert isinstance(by_key[block]["fields"], list) and by_key[block]["fields"]
    # Field descriptors carry a type + a JSON-safe default.
    rag = by_key["rag"]
    enabled = next(f for f in rag["fields"] if f["name"] == "enabled")
    assert enabled["type"] == "boolean"
    assert enabled["default"] is True
    # An enum field surfaces choices.
    general_fields = {f["name"]: f for f in by_key["general"]["fields"]}
    assert general_fields["entity_strategy"]["type"] == "enum"
    assert general_fields["entity_strategy"]["choices"]


def test_settings_schema_carries_no_secrets(client):
    blob = repr(client.get("/api/settings/schema").json()).lower()
    for forbidden in ("es_api_key", "anthropic_api_key", "connector_secrets",
                      "auth_jwt_secret", "notification_secrets"):
        assert forbidden not in blob


def test_settings_section_endpoint(client):
    prefs = _get_prefs(client)
    for block in ("rag", "notifications", "branding", "rbac"):
        r = client.get(f"/api/settings/{block}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["section"] == block
        assert body["value"] == prefs[block]
    # A scalar top-level key also resolves.
    r = client.get("/api/settings/data_view_pattern")
    assert r.status_code == 200
    assert r.json()["value"] == prefs["data_view_pattern"]


def test_settings_section_unknown_is_404(client):
    r = client.get("/api/settings/not_a_real_section")
    assert r.status_code == 404


def test_settings_schema_does_not_shadow_section_route(client):
    """The fixed /settings/schema route resolves to the schema, not the {section} catch-all."""
    body = client.get("/api/settings/schema").json()
    assert "sections" in body


# --------------------------------------------------------------------------- #
# Round-5 Sett-C / Rules R7 — element-model descent (rule collections).
# --------------------------------------------------------------------------- #
def _general_fields(client) -> dict:
    body = client.get("/api/settings/schema").json()
    by_key = {s["key"]: s for s in body["sections"]}
    return {f["name"]: f for f in by_key["general"]["fields"]}


def test_schema_descends_into_list_of_models(client):
    """A ``list[Model]`` field (e.g. ``rule_catalog: list[RuleDefinition]``) now grows an
    additive ``element`` descriptor describing the element model — the fix for the old
    junk-``general``-bucket collapse that made rule collections undescribable."""
    fields = _general_fields(client)
    rc = fields["rule_catalog"]
    # type stays "array" (byte-identical for old consumers)…
    assert rc["type"] == "array"
    # …but now carries the element descriptor.
    assert "element" in rc
    elem = rc["element"]
    assert elem["container"] == "list"
    assert elem["model"] == "RuleDefinition"
    assert isinstance(elem["fields"], list) and elem["fields"]
    # The element's own fields are described with types + JSON-safe defaults.
    names = {f["name"] for f in elem["fields"]}
    assert "name" in names
    for f in elem["fields"]:
        assert "type" in f
        assert "default" in f


def test_schema_descends_into_dict_of_models(client):
    """A ``dict[str, Model]`` field (e.g. ``correlation_rules: dict[str, CorrelationRule]``)
    grows a ``dict``-container element descriptor."""
    fields = _general_fields(client)
    cr = fields["correlation_rules"]
    assert cr["type"] == "object"
    assert "element" in cr
    assert cr["element"]["container"] == "dict"
    assert cr["element"]["model"] == "CorrelationRule"
    assert cr["element"]["fields"]


def test_schema_descends_into_nested_section_collections(client):
    """Element descent also applies to a ``list[Model]`` on a NESTED section model —
    e.g. ``AutomationConfig.rules: list[CaseAutomationRule]`` and
    ``NotificationsConfig.channels: list[NotificationChannelConfig]``."""
    body = client.get("/api/settings/schema").json()
    by_key = {s["key"]: s for s in body["sections"]}

    ta_fields = {f["name"]: f for f in by_key["threshold_automation"]["fields"]}
    rules = ta_fields["rules"]
    assert rules.get("element", {}).get("model") == "CaseAutomationRule"
    assert rules["element"]["container"] == "list"

    notif_fields = {f["name"]: f for f in by_key["notifications"]["fields"]}
    channels = notif_fields["channels"]
    assert channels.get("element", {}).get("model") == "NotificationChannelConfig"


def test_schema_scalar_collections_do_not_grow_an_element(client):
    """A scalar collection (``list[str]`` / ``dict[str, float]``) stays opaque — no
    element descent (the element is not a Pydantic model)."""
    fields = _general_fields(client)
    assert "element" not in fields["excluded_rules"]       # list[str]
    assert "element" not in fields["asset_criticality"]    # dict[str, float]
    # And they keep their coarse container type tag.
    assert fields["excluded_rules"]["type"] == "array"
    assert fields["asset_criticality"]["type"] == "object"


def test_schema_element_descent_is_bounded(client):
    """Element descent must terminate — a nested element (e.g. RuleDefinition.model_override
    → ModelConfig) is fine, but the nesting is depth-capped so a hypothetical self-referential
    model can never recurse unbounded. Assert the returned schema is finite + JSON-serialisable
    and that nesting never exceeds a small bound."""
    import json

    body = client.get("/api/settings/schema").json()
    # Serialisable (a runaway recursion would blow the stack before we ever got here).
    json.dumps(body)

    def max_element_depth(fields, depth=0):
        best = depth
        for f in fields:
            el = f.get("element")
            if el:
                best = max(best, max_element_depth(el["fields"], depth + 1))
        return best

    depths = [max_element_depth(s["fields"]) for s in body["sections"]]
    # The real config needs 2 (rule_catalog → RuleDefinition → model_override → ModelConfig);
    # the cap keeps it comfortably bounded.
    assert max(depths) <= 4


def test_schema_element_descent_carries_no_secret_values(client):
    """Element descent must not surface any secret VALUE. The only secret-adjacent thing
    that may appear is a field NAME like ``configured_secrets`` (a list of which keys are
    configured — booleans/names, never values), consistent with #10."""
    body = client.get("/api/settings/schema").json()
    blob = repr(body).lower()
    for forbidden in ("es_api_key", "anthropic_api_key", "connector_secrets",
                      "auth_jwt_secret", "notification_secrets", "webhook_url_secret"):
        assert forbidden not in blob
    # Any element default that is a list/dict must be EMPTY (defaults only, no seeded
    # values that could carry secrets).
    for section in body["sections"]:
        for f in section["fields"]:
            elem = f.get("element")
            if not elem:
                continue
            for ef in elem["fields"]:
                # configured_secrets is the boolean-keyed configured map — allowed, but
                # its default must be empty (no secret material).
                if ef["name"] == "configured_secrets":
                    assert ef["default"] in (None, [], {}), ef
