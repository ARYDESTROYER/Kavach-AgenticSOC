"""Notification dispatch service (F5 / Wave 4).

``NotificationService`` is the one place that turns a (case, trigger) into zero or
more channel sends. It:

1. Evaluates the operator triggers (verdict/status/severity/risk floors) — does this
   trigger fire at all?
2. Renders the UNTRUSTED-safe body ONCE (:mod:`templates`) and reuses it per channel.
3. Per enabled+matching channel: DEDUPES (a hash of channel+case-signature+trigger
   over a time bucket; Redis-backed when available, in-memory fallback), RATE-LIMITS
   (per channel, per rolling hour), then DISPATCHES.
4. Audits every attempt (``ActionType.NOTIFICATION``) with channel + ok + a REDACTED
   detail (never a secret), and records a compact entry on ``case.notifications_sent``.

NON-NEGOTIABLE #3: ``notify(...)`` is invoked AFTER ``case_manager.apply()`` + save,
fire-and-forget. It NEVER raises into the caller and NEVER blocks the case flow — the
caller wraps the call in ``asyncio.create_task`` / a swallowed try/except, and every
internal failure here is caught and downgraded to an audited non-send. The case
decision is produced solely by ``decide()``; this module only OBSERVES the saved case.
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

from ..models import InAppNotification
from . import templates
from .channel import NotificationEvent, build_channel, ensure_registered

logger = logging.getLogger("tlsoc.notifications.dispatch")

# In-app category mapping + helpers (Feature 8). Importing the module also triggers
# @register_channel for InAppChannel so the providers catalog lists ``in_app`` without
# editing channel.py's builtin loader.
from .inapp import InAppChannel, category_for_trigger  # noqa: E402

# Trigger ids (mirrors templates._TRIGGER_LABEL keys the channels surface).
TRIGGER_CREATED = "case_created"
TRIGGER_ESCALATED = "escalated"
TRIGGER_TRUE_POSITIVE = "true_positive"
TRIGGER_NEEDS_HUMAN = "needs_human"
TRIGGER_CLOSED = "closed"
TRIGGER_MANUAL = "manual"
TRIGGER_TEST = "test"


def _val(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _enum_value(v: Any) -> str:
    return str(getattr(v, "value", v) or "")


def _mentions_of(case: Any) -> list[str]:
    """Every @mentioned user across a case's comments + threaded messages (plain
    user-id strings, #9). Reads defensively from a Case (or dict) so a partial case
    never errors; returns [] on anything unexpected."""
    out: list[str] = []
    try:
        comments = _val(case, "comments", []) or []
        for c in comments:
            for m in (_val(c, "mentions", []) or []):
                if str(m).strip():
                    out.append(str(m).strip())
    except Exception:  # noqa: BLE001 — mentions are advisory; never break delivery
        pass
    return out


def _in_quiet_hours(quiet: Any) -> bool:
    """Whether NOW falls in a user's ``quiet_hours`` window ``{start, end, tz}``
    (``HH:MM`` 24h strings). The window is evaluated in the user's ``tz`` (an IANA
    name like ``Asia/Kolkata``) so an operator's "10pm-6am" means THEIR local
    night, not the server's UTC night. A blank / invalid / unknown ``tz`` falls back
    to UTC. A window that wraps midnight (start > end) is handled. Missing/malformed
    config → False (no quiet hours). Never raises."""
    if not isinstance(quiet, dict):
        return False
    start = _parse_hhmm(quiet.get("start"))
    end = _parse_hhmm(quiet.get("end"))
    if start is None or end is None or start == end:
        return False
    minute = _local_minute_of_day(quiet.get("tz"))
    if start < end:
        return start <= minute < end
    # Wraps midnight (e.g. 22:00 → 06:00).
    return minute >= start or minute < end


def _local_minute_of_day(tz: Any) -> int:
    """Minutes-since-midnight of NOW in the IANA timezone ``tz`` (e.g.
    ``Asia/Kolkata``). Falls back to UTC on a blank / non-string / unknown tz. Never
    raises — a bad tz must never block notification routing."""
    name = tz.strip() if isinstance(tz, str) else ""
    if name:
        try:
            from datetime import datetime
            from zoneinfo import ZoneInfo

            now_local = datetime.now(ZoneInfo(name))
            return now_local.hour * 60 + now_local.minute
        except Exception as exc:  # noqa: BLE001 — unknown key / no tzdata → UTC fallback
            logger.debug("quiet-hours tz %r unresolved (%s); using UTC", name, exc)
    now = time.gmtime()
    return now.tm_hour * 60 + now.tm_min


def _parse_hhmm(value: Any) -> int | None:
    """Parse an ``HH:MM`` string to minutes-since-midnight, or None when invalid."""
    if not isinstance(value, str) or ":" not in value:
        return None
    try:
        h, m = value.split(":", 1)
        hh, mm = int(h), int(m)
    except (ValueError, TypeError):
        return None
    if 0 <= hh < 24 and 0 <= mm < 60:
        return hh * 60 + mm
    return None


class NotificationService:
    """Fire-and-forget notification dispatcher.

    ``cache`` is the app's :class:`app.cache.Cache` (Redis + in-memory fallback) used
    for dedup + rate-limit counters; when None a process-local dict is used. ``audit``
    is the append-only audit logger (best-effort). ``get_prefs`` returns the live
    ``Preferences`` (so config edits take effect without rebuilding the service).
    ``secrets`` is the SECRET tier (per-channel secrets resolved at send time)."""

    def __init__(self, *, get_prefs, secrets, cache=None, audit=None,
                 inbox=None, notif_prefs=None, users=None, event_bus=None) -> None:
        self._get_prefs = get_prefs
        self._secrets = secrets
        self._cache = cache
        self._audit = audit
        # In-memory fallbacks (single-node) when no cache is wired.
        self._dedup_mem: dict[str, float] = {}
        self._rate_mem: dict[str, list[float]] = {}
        # One-time flag so we warn ONCE if an operator enabled the (unimplemented)
        # channel-level digest, instead of silently doing nothing (audit #44).
        self._warned_channel_digest = False
        # In-app inbox fan-in (Feature 8). All OPTIONAL + defaulted None so existing
        # callers / the offline test suite construct the service unchanged. When
        # ``inbox`` is wired the dispatcher ALSO fans an in-app copy out per recipient
        # AFTER the network sends — fire-and-forget, never before decide() (#3).
        self._inbox = inbox
        self._notif_prefs = notif_prefs
        self._users = users
        self._event_bus = event_bus
        ensure_registered()

    def reset_runtime_state(self) -> None:
        """Forget in-process tenant dedup/rate evidence after a factory reset."""

        self._dedup_mem.clear()
        self._rate_mem.clear()
        self._warned_channel_digest = False

    # -- trigger evaluation -------------------------------------------------- #
    def _triggers_for_case(self, case: Any, cfg) -> list[str]:
        """Which configured triggers this saved case matches (verdict/status)."""
        t = cfg.triggers
        verdict = _enum_value(_val(case, "verdict"))
        status = _enum_value(_val(case, "status"))
        out: list[str] = []
        # on_case_created — was documented but never wired (audit #29). Fire for a
        # genuinely-new OPEN case: non-terminal status AND no prior case_created
        # notification already recorded (so a later reinvestigate/notify doesn't re-fire).
        if getattr(t, "on_case_created", False) and status not in ("closed", "resolved"):
            already_created = any(
                (n.get("trigger") if isinstance(n, dict) else getattr(n, "trigger", None))
                == TRIGGER_CREATED
                for n in (_val(case, "notifications_sent", []) or [])
            )
            if not already_created:
                out.append(TRIGGER_CREATED)
        if t.on_escalated and status in ("escalated", "needs_human"):
            out.append(TRIGGER_ESCALATED)
        if t.on_true_positive and verdict == "TRUE_POSITIVE":
            out.append(TRIGGER_TRUE_POSITIVE)
        if t.on_needs_human and (verdict == "NEEDS_HUMAN" or status == "needs_human"):
            out.append(TRIGGER_NEEDS_HUMAN)
        if t.on_closed and status in ("closed", "resolved"):
            out.append(TRIGGER_CLOSED)
        return out

    def _passes_floors(self, case: Any, cfg) -> bool:
        t = cfg.triggers
        risk = float(_val(case, "risk_score", 0.0) or 0.0)
        if t.min_risk and risk < float(t.min_risk):
            return False
        if t.min_severity and risk < float(t.min_severity):
            return False
        return True

    # -- dedup + rate-limit -------------------------------------------------- #
    def _dedup_key(self, channel_id: str, case: Any, trigger: str, window: int) -> str:
        sig = _enum_value(_val(case, "cluster_signature")) or _val(case, "case_id", "")
        bucket = int(time.time() // window) if window > 0 else 0
        raw = f"{channel_id}|{sig}|{trigger}|{bucket}"
        return "tlsoc:notif:dedup:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]

    async def _is_duplicate(self, channel_id: str, case: Any, trigger: str, window: int) -> bool:
        """PURE check — is this (channel, case, trigger, window) already sent? Does NOT
        record the key; that is done by ``_mark_dedup`` ONLY after a successful send, so a
        failed / rate-limited attempt never burns the dedup window and drops the retry
        (audit #43)."""
        if window <= 0:
            return False
        key = self._dedup_key(channel_id, case, trigger, window)
        if self._cache is not None:
            try:
                return bool(await self._cache.get(key))
            except Exception:  # noqa: BLE001 — never let cache errors block a send decision
                pass
        # in-memory fallback
        exp = self._dedup_mem.get(key)
        return bool(exp and exp > time.time())

    async def _mark_dedup(self, channel_id: str, case: Any, trigger: str, window: int) -> None:
        """Record the dedup key AFTER a successful send (audit #43). Best-effort."""
        if window <= 0:
            return
        key = self._dedup_key(channel_id, case, trigger, window)
        if self._cache is not None:
            try:
                await self._cache.set(key, "1", window)
                return
            except Exception:  # noqa: BLE001
                pass
        self._dedup_mem[key] = time.time() + window

    async def _rate_limited(self, channel_id: str, per_hour: int) -> bool:
        if per_hour <= 0:
            return False
        now = time.time()
        if self._cache is not None:
            bucket = int(now // 3600)
            key = f"tlsoc:notif:rate:{channel_id}:{bucket}"
            try:
                raw = await self._cache.get(key)
                count = int(raw) if raw else 0
                if count >= per_hour:
                    return True
                await self._cache.set(key, str(count + 1), 3600)
                return False
            except Exception:  # noqa: BLE001
                pass
        # in-memory rolling window
        window_start = now - 3600
        hits = [t for t in self._rate_mem.get(channel_id, []) if t > window_start]
        if len(hits) >= per_hour:
            self._rate_mem[channel_id] = hits
            return True
        hits.append(now)
        self._rate_mem[channel_id] = hits
        return False

    # -- send one channel ---------------------------------------------------- #
    def _resolve_secret(self, channel_id: str) -> str:
        """The primary per-channel secret (password / api key / webhook url / token).

        Channels read one opaque ``secret`` string; we pick the channel's single
        secret value (the dict has one well-known field name per type)."""
        try:
            bucket = self._secrets.notification_channel_secrets(channel_id)
        except Exception:  # noqa: BLE001
            bucket = {}
        if not bucket:
            return ""
        # Convention: the primary credential is stored under "secret"; fall back to
        # other well-known field names, else the first value present.
        for field in ("secret", "password", "url", "api_key", "token",
                      "routing_key", "bot_token", "webhook_url"):
            if bucket.get(field):
                return str(bucket[field])
        return str(next(iter(bucket.values())))

    async def _send_one(self, ch_cfg, event: NotificationEvent) -> dict[str, Any]:
        secret = self._resolve_secret(ch_cfg.id)
        config = dict(ch_cfg.config or {})
        config.setdefault("name", ch_cfg.name or ch_cfg.id)
        config.setdefault("id", ch_cfg.id)
        channel = build_channel(ch_cfg.type, config, secret)
        if channel is None:
            return {"channel_id": ch_cfg.id, "type": ch_cfg.type, "ok": False,
                    "detail": f"unknown channel type: {ch_cfg.type}"}
        result = await channel.send(event)
        return {"channel_id": ch_cfg.id, "type": ch_cfg.type, "ok": result.ok, "detail": result.detail}

    # -- in-app inbox fan-in (Feature 8) ------------------------------------- #
    async def _fan_in_app(self, case: Any, trigger: str, event: NotificationEvent
                          ) -> dict[str, Any] | None:
        """Fan ONE in-app copy of ``event`` out into every resolved recipient's inbox.

        Resolves recipients (case assignee + @mentions ALWAYS; RBAC-role members
        filtered by each user's per-category :class:`NotificationPref`), then delivers
        through the directly-wired :class:`InAppChannel` (no network). Returns a
        compact per-channel record (``type="in_app"``) for ``notifications_sent`` /
        audit, or None when no inbox is wired. NEVER raises."""
        if self._inbox is None:
            return None
        try:
            channel = InAppChannel(
                inbox=self._inbox,
                resolve_recipients=lambda ev: self._resolve_inapp_recipients(ev),
                publish=self._inapp_publish,
            )
            result = await channel.send(event)
            return {"channel_id": "in_app", "type": "in_app",
                    "ok": result.ok, "detail": result.detail}
        except Exception as exc:  # noqa: BLE001 — one channel can't break the rest / the flow
            logger.debug("in-app fan-in failed: %s", exc)
            return {"channel_id": "in_app", "type": "in_app", "ok": False,
                    "detail": f"in-app error: {type(exc).__name__}"}

    async def _resolve_inapp_recipients(self, event: NotificationEvent) -> list[str]:
        """The users who should see this event in their inbox.

        Two tiers, UNIONed:

        * ALWAYS (regardless of channel/category prefs — the inbox is the canonical
          surface): the case ASSIGNEE + every @MENTION on the case. A direct mention or
          assignment is a personal address, so it always fans in.
        * ROLE members (the active users whose role should see this category) — but
          ONLY when that user's per-category :class:`NotificationPref` enables in-app
          for the trigger's category (and they aren't in quiet-hours/digest).

        Every value is a plain user-id string (#9 — render-escaped by the UI)."""
        case = event.case
        category = category_for_trigger(event.trigger)

        always: list[str] = []
        assignee = _val(case, "assignee")
        if assignee:
            always.append(str(assignee))
        for m in _mentions_of(case):
            always.append(m)

        # ALWAYS recipients (assignee + @mentions) — these win the prefs filter and
        # are never deferred (a direct address always fans in immediately).
        always_keys = {(u or "").strip().lower() for u in always}

        role_members = await self._role_recipients(event.trigger)
        routed: list[str] = []
        deferred: list[str] = []
        for user in role_members:
            if (user or "").strip().lower() in always_keys:
                continue  # an always-recipient is delivered via the always tier
            decision = await self._inapp_route(user, category)
            if decision == "deliver":
                routed.append(user)
            elif decision == "defer":
                deferred.append(user)
            # "mute" → the user explicitly opted out of this category; drop (intended).

        # Record the deferred (quiet-hours / digest) role-tier items into each user's
        # pending-digest buffer so they are HELD, not silently lost. Best-effort —
        # never blocks delivery of the live recipients.
        if deferred:
            await self._defer_inapp(event, category, deferred)

        # De-dup preserving order; ALWAYS recipients first (they win the prefs filter).
        seen: set[str] = set()
        out: list[str] = []
        for u in always + routed:
            key = (u or "").strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(u)
        return out

    async def _defer_inapp(self, event: NotificationEvent, category: str,
                           users: list[str]) -> None:
        """Hold a routed in-app item for each ``users`` recipient in their pending-
        digest buffer (quiet-hours / digest cadence). Best-effort; never raises —
        a deferral glitch must not break live delivery."""
        inbox = self._inbox
        if inbox is None or not hasattr(inbox, "defer"):
            return
        meta = event.meta or {}
        title = (event.subject or "").strip()[:200] or str(meta.get("title") or "case")
        body = (event.text or "").strip()[:1000]
        severity = str(meta.get("severity_label") or "") or None
        case_id = str(meta.get("case_id") or "") or None
        url = str(meta.get("case_url") or "") or None
        seen: set[str] = set()
        for user in users:
            key = (user or "").strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            try:
                await inbox.defer(InAppNotification(
                    recipient=user, category=category, title=title, body=body,
                    severity=severity, case_id=case_id, url=url,
                    ref={"trigger": event.trigger, "deferred": True},
                ))
            except Exception as exc:  # noqa: BLE001 — best-effort; never block delivery
                logger.debug("in-app defer for %s failed: %s", user, exc)

    async def _role_recipients(self, trigger: str) -> list[str]:
        """Active usernames whose role should be notified of ``trigger``'s category.

        When no users store is wired (auth off / standalone), there are no role
        recipients — only the assignee/mention tier applies. Best-effort; never
        raises. (A SOC where every analyst should see escalations relies on each
        user's pref defaulting in-app ON, so this casts a WIDE net — every active user
        — and the per-user pref + quiet-hours filter narrows it.)"""
        if self._users is None:
            return []
        try:
            users = await self._users.list()
        except Exception as exc:  # noqa: BLE001 — a store glitch must not break delivery
            logger.debug("in-app role recipient load failed: %s", exc)
            return []
        out: list[str] = []
        for u in users or []:
            active = getattr(u, "active", True)
            username = getattr(u, "username", "") or ""
            if active and username:
                out.append(username)
        return out

    async def _inapp_route(self, user: str, category: str) -> str:
        """How ``user``'s :class:`NotificationPref` routes ``category`` to the in-app
        inbox right now → one of:

        * ``"deliver"`` — fan in immediately (DEFAULT-ON: a user with nothing stored,
          or an absent category entry, receives in-app notifications);
        * ``"mute"``    — the user explicitly disabled this category / excluded the
          in-app channel → drop (intended opt-out);
        * ``"defer"``   — the user is in quiet-hours or on a digest cadence → HOLD the
          item in their pending-digest buffer instead of losing it (see
          :meth:`_defer_inapp`), to be surfaced when the window ends / the digest
          fires.

        Never raises → defaults to ``"deliver"`` on any glitch."""
        if self._notif_prefs is None:
            return "deliver"
        try:
            pref = await self._notif_prefs.get(user)
        except Exception as exc:  # noqa: BLE001
            logger.debug("notif pref load failed for %s: %s", user, exc)
            return "deliver"
        try:
            cats = getattr(pref, "categories", {}) or {}
            entry = cats.get(category)
            if isinstance(entry, dict):
                if entry.get("enabled") is False:
                    return "mute"
                channels = entry.get("channels")
                # An explicit channel list that EXCLUDES in-app mutes the inbox for
                # this category; an absent/empty list means "default" → in-app on.
                if isinstance(channels, list) and channels and "in_app" not in channels:
                    return "mute"
            # Quiet-hours: hold (defer) routed (non-personal) items during the window.
            if _in_quiet_hours(getattr(pref, "quiet_hours", None)):
                return "defer"
            # Digest cadence: a digest user gets a held copy, not a per-event item.
            if str(getattr(pref, "digest", "") or "off").lower() not in ("", "off"):
                return "defer"
        except Exception as exc:  # noqa: BLE001 — a malformed pref never blocks delivery
            logger.debug("notif pref eval failed for %s: %s", user, exc)
            return "deliver"
        return "deliver"

    async def _inapp_allows(self, user: str, category: str) -> bool:
        """Back-compat boolean: True iff the category is delivered LIVE to ``user``
        (a deferred/muted user returns False). New code should prefer
        :meth:`_inapp_route` which distinguishes mute from defer."""
        return (await self._inapp_route(user, category)) == "deliver"

    def _inapp_publish(self, username: str, payload: dict[str, Any]) -> None:
        """Publish an ``inapp`` live-badge event to ONE user on the EventBus (Wave-4).
        Fire-and-forget — never raises into the caller."""
        bus = self._event_bus
        if bus is None:
            return
        try:
            bus.publish("notifications", "inapp", payload, audience=[username])
        except Exception as exc:  # noqa: BLE001
            logger.debug("in-app event publish failed: %s", exc)

    async def _audit_send(self, case_id: str, rec: dict[str, Any], trigger: str) -> None:
        if self._audit is None:
            return
        try:
            from ..constants import ActionType

            await self._audit.record(
                action_type=ActionType.NOTIFICATION, surface="notification",
                actor="notification", case_id=case_id,
                result_summary=(
                    f"channel={rec.get('channel_id')} type={rec.get('type')} "
                    f"trigger={trigger} ok={rec.get('ok')} detail={rec.get('detail')}"
                ),
            )
        except Exception as exc:  # noqa: BLE001 — audit is best-effort
            logger.debug("notification audit failed: %s", exc)

    def _org_name(self, cfg) -> str:
        prefs = self._safe_prefs()
        branding = getattr(prefs, "branding", None)
        return (getattr(branding, "org_name", "") or "Agentic SOC") if branding else "Agentic SOC"

    def _branding(self):
        """The live BrandingConfig (or None) — feeds the email shell tokens (logo /
        accent / footer) into :func:`templates.render`. Best-effort; never raises."""
        prefs = self._safe_prefs()
        return getattr(prefs, "branding", None) if prefs else None

    def _safe_prefs(self):
        try:
            return self._get_prefs()
        except Exception:  # noqa: BLE001
            return None

    # -- public entrypoints -------------------------------------------------- #
    async def dispatch(self, case: Any, trigger: str, *, channel_ids: list[str] | None = None,
                       check_triggers: bool = True) -> list[dict[str, Any]]:
        """Render + dispatch ``case`` for ``trigger`` to matching channels.

        Returns a list of per-channel result dicts (also appended to
        ``case.notifications_sent`` by the caller / here). NEVER raises."""
        sent: list[dict[str, Any]] = []
        try:
            prefs = self._safe_prefs()
            cfg = getattr(prefs, "notifications", None) if prefs else None
            if cfg is None or not cfg.enabled:
                return sent
            # Channel-level digest is a RESERVED, not-yet-wired field (audit #44): warn
            # ONCE so an operator who enabled it isn't misled into thinking email/webhook
            # volume is being batched (the implemented digest is per-user + in-app).
            if not self._warned_channel_digest and getattr(
                getattr(cfg, "digest", None), "enabled", False
            ):
                self._warned_channel_digest = True
                logger.warning(
                    "notifications.digest.enabled is set but channel-level digest batching "
                    "is not implemented; email/webhook events are sent immediately. Use a "
                    "per-user in-app digest (NotifPref.digest) to batch inbox items."
                )
            ensure_registered()
            channels = cfg.enabled_channels() if hasattr(cfg, "enabled_channels") else [
                c for c in cfg.channels if c.enabled
            ]
            if channel_ids is not None:
                wanted = set(channel_ids)
                channels = [c for c in channels if c.id in wanted]
            # NOTE: do NOT early-return on an empty network-channel list — the in-app
            # inbox fan-in below must still run (the inbox is the canonical surface and
            # is independent of whether any email/webhook channel is configured). When
            # the caller TARGETED a channel subset (channel_ids != None) and none match,
            # they explicitly want only those — skip the in-app fan-in too.
            if not channels and channel_ids is not None:
                return sent

            body = templates.render(
                case, trigger, base_url=cfg.base_url or "", org_name=self._org_name(cfg),
                templates=getattr(cfg, "templates", None), branding=self._branding(),
            )
            event = NotificationEvent(
                case=case, trigger=trigger, subject=body["subject"],
                html=body["html"], text=body["text"], meta=body["meta"],
                headers=body.get("headers") or {},
            )
            case_id = _val(case, "case_id", "") or ""
            for ch in channels:
                try:
                    if check_triggers:
                        if await self._is_duplicate(ch.id, case, trigger, cfg.dedup_window_seconds):
                            continue
                        if await self._rate_limited(ch.id, cfg.rate_limit_per_hour):
                            sent.append({"channel_id": ch.id, "type": ch.type, "ok": False,
                                         "detail": "rate limit exceeded"})
                            continue
                    rec = await self._send_one(ch, event)
                    # Consume the dedup window ONLY on a confirmed send, so a failed /
                    # rate-limited attempt leaves the window open for a retry (audit #43).
                    if check_triggers and rec.get("ok"):
                        await self._mark_dedup(ch.id, case, trigger, cfg.dedup_window_seconds)
                except Exception as exc:  # noqa: BLE001 — one channel can't break the rest
                    rec = {"channel_id": ch.id, "type": ch.type, "ok": False,
                           "detail": f"dispatch error: {type(exc).__name__}"}
                rec["trigger"] = trigger
                rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                sent.append(rec)
                await self._audit_send(case_id, rec, trigger)
            # IN-APP fan-in (Feature 8): a copy lands in each recipient's inbox AFTER
            # the network channels. Fire-and-forget, fully isolated — never blocks /
            # raises, never participates in decide() (#3).
            inapp_rec = await self._fan_in_app(case, trigger, event)
            if inapp_rec is not None:
                inapp_rec["trigger"] = trigger
                inapp_rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                sent.append(inapp_rec)
                await self._audit_send(case_id, inapp_rec, trigger)
        except Exception as exc:  # noqa: BLE001 — fire-and-forget; never raise into the caller
            logger.warning("notification dispatch failed: %s", exc)
        return sent

    async def notify(self, case: Any, *, save=None, fetch=None) -> list[dict[str, Any]]:
        """Evaluate triggers for a freshly-saved case and dispatch all matches.

        Fire-and-forget: catches everything. When ``save`` is provided (a coroutine
        callable taking the case), the updated ``notifications_sent`` is persisted
        best-effort AFTER sending (so a failed save never blocks delivery). ``notify`` is
        scheduled as a DETACHED task, so the ``case`` snapshot it holds may be stale by
        the time it saves; when ``fetch`` (a coroutine ``case_id -> case``) is provided we
        RE-FETCH the case and append ``notifications_sent`` onto the FRESH doc, so a
        concurrent analyst edit (comment/status/assign) is not clobbered (audit #28)."""
        all_sent: list[dict[str, Any]] = []
        try:
            prefs = self._safe_prefs()
            cfg = getattr(prefs, "notifications", None) if prefs else None
            if cfg is None or not cfg.enabled:
                return all_sent
            if not self._passes_floors(case, cfg):
                return all_sent
            triggers = self._triggers_for_case(case, cfg)
            for trig in triggers:
                all_sent.extend(await self.dispatch(case, trig))
            if all_sent:
                try:
                    target = case
                    if fetch is not None:
                        cid = _val(case, "case_id", None) or _val(case, "id", None)
                        if cid:
                            fresh = await fetch(cid)
                            if fresh is not None:
                                target = fresh  # merge onto the latest, not our stale snapshot
                    existing = list(_val(target, "notifications_sent", []) or [])
                    if isinstance(target, dict):
                        target["notifications_sent"] = existing + all_sent
                    else:
                        target.notifications_sent = existing + all_sent
                    if save is not None:
                        await save(target)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("persist notifications_sent failed: %s", exc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("notify() failed: %s", exc)
        return all_sent

    async def test_channel(self, channel_id: str) -> dict[str, Any]:
        """Send a sample notification to ONE channel (the Settings 'Send test' button).
        Never leaks secrets in the returned detail."""
        prefs = self._safe_prefs()
        cfg = getattr(prefs, "notifications", None) if prefs else None
        if cfg is None:
            return {"ok": False, "detail": "notifications not configured"}
        ch = cfg.channel(channel_id) if hasattr(cfg, "channel") else next(
            (c for c in cfg.channels if c.id == channel_id), None
        )
        if ch is None:
            return {"ok": False, "detail": "channel not found"}
        ensure_registered()
        sample = _sample_case()
        body = templates.render(sample, TRIGGER_TEST, base_url=cfg.base_url or "",
                                org_name=self._org_name(cfg),
                                templates=getattr(cfg, "templates", None),
                                branding=self._branding())
        event = NotificationEvent(
            case=sample, trigger=TRIGGER_TEST, subject=body["subject"],
            html=body["html"], text=body["text"], meta=body["meta"],
            headers=body.get("headers") or {},
        )
        try:
            rec = await self._send_one(ch, event)
        except Exception as exc:  # noqa: BLE001
            rec = {"ok": False, "detail": f"test failed: {type(exc).__name__}"}
        await self._audit_send("", {**rec, "channel_id": channel_id, "type": ch.type}, TRIGGER_TEST)
        return {"ok": bool(rec.get("ok")), "detail": rec.get("detail", "")}


def _sample_case() -> dict[str, Any]:
    """A safe synthetic case for the 'Send test' path (no real data)."""
    return {
        "case_id": "case-test-0001",
        "cluster_signature": "test:notification",
        "title": "Test notification from the SOC console",
        "entity": {"type": "ip", "value": "203.0.113.10"},
        "verdict": "TRUE_POSITIVE",
        "confidence": 0.91,
        "disposition": "true_positive",
        "status": "escalated",
        "risk_score": 82.0,
        "rule_ids": ["sample.rule"],
        "summary": "This is a sample notification confirming the channel is configured correctly.",
        "source_name": "Test source",
    }
