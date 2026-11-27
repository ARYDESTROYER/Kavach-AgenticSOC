"""In-app notification channel (Feature 8 / Round 3 Wave 2).

The :class:`InAppChannel` is a :class:`app.notifications.channel.NotificationChannel`
that delivers a notification to the operator's IN-APP inbox instead of over the
network. Its :meth:`send` does NO network I/O at all: it

1. resolves the human RECIPIENTS for the event (case assignee + @mentions + the RBAC
   roles whose members should see this category), then
2. fans ONE :class:`app.models.InAppNotification` out per recipient into the
   per-user :class:`app.stores.inbox.InboxStore` (a bounded ring), reusing the SAME
   UNTRUSTED-safe rendered title/body the other channels use (#9 — the renderer
   already escaped every case/log-derived value; we surface plain text only), and
3. publishes a per-user ``inapp`` event on the :class:`app.realtime.EventBus` so a
   live badge can update (fire-and-forget — never blocks, never raises).

Why a directly-constructed channel (NOT the generic ``build_channel`` registry
path): the inbox + prefs stores + event bus live on :class:`app.state.AppState` and
cannot be threaded through the per-send ``build_channel(type, config, secret)``
factory. So :class:`app.notifications.dispatch.NotificationService` constructs ONE
``InAppChannel`` at wire time (stores injected) and fans it in AFTER the network
channels — see ``NotificationService`` for the fan-in hook. We STILL register the
type on the SPI so the providers catalog / settings editor lists ``in_app`` and the
per-user :class:`app.models.NotificationPref` can route per category, but the
authoritative delivery uses the directly-wired instance.

Non-negotiables upheld:
* #3 — advisory only. The inbox NEVER feeds ``case_manager.decide()``; the fan-in
  runs strictly AFTER ``apply()``+save, fire-and-forget. ``send`` never raises.
* #9 — ``event.subject``/``event.text`` are the renderer's already-escaped output;
  ``meta`` scalars are plain (``build_meta`` cleaned them). We store plain text; the
  UI render-escapes. We never re-inject raw case/log HTML.
* #10 — no secrets: the inbox channel has no transport credential.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from ..constants import NotificationCategory
from ..models import InAppNotification
from .channel import NotificationChannel, NotificationEvent, SendResult, register_channel

logger = logging.getLogger("tlsoc.notifications.inapp")

# A recipient resolver: (event) -> list[(username, category)] OR list[username]. The
# service injects one that knows the case assignee / mentions / role members; a default
# resolver (assignee + mentions only) is used when none is wired.
RecipientResolver = Callable[[NotificationEvent], "Awaitable[list[str]]"]

# An event publisher: (username, payload) -> None. The service injects the EventBus
# publish hook; default is a no-op so the channel works standalone (tests).
InappPublisher = Callable[[str, dict[str, Any]], None]


# Map the dispatch trigger id → the in-app NotificationCategory (so the inbox item is
# filed under the right category and the per-user pref matrix can route/mute it).
_TRIGGER_CATEGORY: dict[str, str] = {
    "case_created": NotificationCategory.CASE_NEW.value,
    "escalated": NotificationCategory.CASE_ESCALATED.value,
    "true_positive": NotificationCategory.CASE_ESCALATED.value,
    "needs_human": NotificationCategory.CASE_ESCALATED.value,
    "closed": NotificationCategory.CASE_RESOLVED.value,
    "manual": NotificationCategory.SYSTEM.value,
    "digest_daily": NotificationCategory.DIGEST.value,
    "test": NotificationCategory.SYSTEM.value,
}


def category_for_trigger(trigger: str) -> str:
    """The in-app :class:`app.constants.NotificationCategory` value for a dispatch
    trigger id (defaults to ``system`` for an unknown trigger)."""
    return _TRIGGER_CATEGORY.get(trigger or "", NotificationCategory.SYSTEM.value)


#: The two details :meth:`InAppChannel.send` returns, with ``ok=True``, for an inbox copy
#: that went out to no one: the channel has no inbox, or nobody is addressed. The
#: automation notify wiring (``AppState._automation_notify``) reads them to leave such a
#: copy out of the channels a notification was sent on.
INAPP_NO_INBOX_DETAIL = "no inbox wired"
INAPP_NO_RECIPIENTS_DETAIL = "no recipients"
INAPP_NOT_DUE_DETAILS = frozenset({INAPP_NO_INBOX_DETAIL, INAPP_NO_RECIPIENTS_DETAIL})


@register_channel
class InAppChannel(NotificationChannel):
    """Fan a rendered notification out into the per-user in-app inbox.

    Constructed with the :class:`app.stores.inbox.InboxStore` (required to actually
    deliver) + an optional recipient resolver + an optional event publisher. The
    no-arg / SPI ``build_channel`` construction yields a channel WITHOUT an inbox; its
    ``send`` is then a safe no-op (returns ``ok=True, detail="no inbox wired"``) so the
    generic registry path never errors — real delivery uses the directly-wired
    instance the service builds.
    """

    type = "in_app"

    def __init__(
        self,
        config: dict[str, Any] | None = None,
        secret: str = "",
        *,
        inbox: Any = None,
        resolve_recipients: RecipientResolver | None = None,
        publish: InappPublisher | None = None,
    ) -> None:
        super().__init__(config or {}, secret)
        self._inbox = inbox
        self._resolve = resolve_recipients
        self._publish = publish

    async def send(self, event: NotificationEvent) -> SendResult:
        """Deliver ``event`` to every resolved recipient's inbox. NEVER raises.

        Returns ``ok=True`` with a count of recipients fanned out (``ok=True`` with
        zero recipients is still a success — nobody needed it); ``ok=False`` only on an
        internal store error (already isolated → a redacted detail)."""
        if self._inbox is None:
            return SendResult(ok=True, detail=INAPP_NO_INBOX_DETAIL)
        try:
            recipients = await self._recipients(event)
        except Exception as exc:  # noqa: BLE001 — resolver must never break delivery
            logger.debug("in-app recipient resolution failed: %s", exc)
            recipients = []
        if not recipients:
            return SendResult(ok=True, detail=INAPP_NO_RECIPIENTS_DETAIL)

        category = category_for_trigger(event.trigger)
        meta = event.meta or {}
        title = self._title(event, meta)
        body = self._body(event, meta)
        severity = str(meta.get("severity_label") or "") or None
        case_id = str(meta.get("case_id") or "") or None
        url = str(meta.get("case_url") or "") or None

        # De-dup recipients (a user who is BOTH assignee and mentioned gets ONE item).
        seen: set[str] = set()
        ordered: list[str] = []
        for r in recipients:
            key = (r or "").strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            ordered.append(r)

        def _build(recipient: str) -> InAppNotification:
            return InAppNotification(
                recipient=recipient, category=category, title=title, body=body,
                severity=severity, case_id=case_id, url=url,
                ref={"trigger": event.trigger},
            )

        try:
            created = await self._inbox.fanout(ordered, _build)
        except Exception as exc:  # noqa: BLE001 — store glitch never blocks the case flow
            logger.warning("in-app fanout failed: %s", exc)
            return SendResult(ok=False, detail=f"inbox fanout failed: {type(exc).__name__}")

        # Fire-and-forget live-badge nudge per recipient (Wave-4 badge). Never raises.
        self._notify_live(created)
        return SendResult(ok=True, detail=f"fanned out to {len(created)} recipient(s)")

    # -- recipient resolution ------------------------------------------------ #
    async def _recipients(self, event: NotificationEvent) -> list[str]:
        if self._resolve is not None:
            out = await self._resolve(event)
            return [str(u) for u in (out or []) if str(u).strip()]
        # Default resolver (no service wiring): the case assignee + @mentions only.
        return _default_recipients(event)

    # -- live-badge publish -------------------------------------------------- #
    def _notify_live(self, created: list[InAppNotification]) -> None:
        if self._publish is None:
            return
        for note in created:
            try:
                self._publish(
                    note.recipient,
                    {
                        "id": note.id,
                        "category": note.category,
                        "title": note.title,
                        "severity": note.severity,
                        "case_id": note.case_id,
                        "created_at": note.created_at,
                    },
                )
            except Exception as exc:  # noqa: BLE001 — publish is best-effort
                logger.debug("in-app live publish failed: %s", exc)

    # -- title / body (already UNTRUSTED-safe scalars) ----------------------- #
    @staticmethod
    def _title(event: NotificationEvent, meta: dict[str, Any]) -> str:
        # The rendered subject is header-safe + escaped; fall back to a label+title.
        subject = (event.subject or "").strip()
        if subject:
            return subject[:200]
        label = str(meta.get("trigger") or event.trigger or "Notification")
        title = str(meta.get("title") or meta.get("case_id") or "case")
        return f"{label}: {title}"[:200]

    @staticmethod
    def _body(event: NotificationEvent, meta: dict[str, Any]) -> str:
        # Prefer the rendered plain-text body (already control-stripped); cap it.
        text = (event.text or "").strip()
        if text:
            return text[:1000]
        return str(meta.get("title") or "")[:1000]


def _default_recipients(event: NotificationEvent) -> list[str]:
    """Recipients from the case alone (no users store): the assignee + @mentions on
    the case's comments/messages. Used when the service hasn't injected a resolver.
    All values are plain user-id strings (#9)."""
    case = event.case
    out: list[str] = []

    def g(name: str, default: Any = None) -> Any:
        if isinstance(case, dict):
            return case.get(name, default)
        return getattr(case, name, default)

    assignee = g("assignee")
    if assignee:
        out.append(str(assignee))
    return out
