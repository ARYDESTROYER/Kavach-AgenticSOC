"""``GET /api/notifications/providers`` answers with its catalog (Round 14 FX3b2).

The response model typed ``channel_types`` as a list of objects while
``notifications.channel.channel_types()`` returns the registered type ids as plain
strings, so response validation failed and the route answered 500 (seen in Demo
Mode). The catalog is names and ids only: no secret ever appears in it.
"""

from __future__ import annotations

from app.api.routes_notifications import NotificationProvidersResponse
from app.notifications.channel import channel_types, ensure_registered
from app.notifications.templates import builtin_template_ids


def test_the_providers_route_answers_with_the_channel_type_ids(client) -> None:
    response = client.get("/api/notifications/providers")
    assert response.status_code == 200, response.text
    body = response.json()
    ensure_registered()
    assert body["channel_types"] == channel_types()
    assert all(isinstance(kind, str) for kind in body["channel_types"])
    assert {"email", "resend", "slack", "teams", "webhook"} <= set(body["channel_types"])
    assert body["template_ids"] == builtin_template_ids()
    presets = body["email_presets"]
    assert presets and all(isinstance(p, dict) and isinstance(p.get("id"), str) for p in presets)
    assert "ses" in {p["id"] for p in presets}


def test_the_published_schema_says_channel_types_are_strings() -> None:
    schema = NotificationProvidersResponse.model_json_schema()
    assert schema["properties"]["channel_types"]["items"] == {"type": "string"}
    assert schema["properties"]["template_ids"]["items"] == {"type": "string"}


def test_the_providers_route_is_gated_on_notifications_read() -> None:
    from app.api.routes_notifications import router

    route = next(r for r in router.routes if getattr(r, "path", "") == "/api/notifications/providers")
    names = [getattr(dep.call, "__qualname__", "") for dep in route.dependant.dependencies]
    assert any("require_permission" in name for name in names), names
