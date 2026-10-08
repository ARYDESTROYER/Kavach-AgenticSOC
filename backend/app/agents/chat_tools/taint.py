"""Indicator validation and the per-turn taint ledger (chat revamp SPEC §4.8).

``lookup_indicator`` is the ONLY chat tool that sends anything outside the
deployment: a value goes to third-party enrichment providers. Two independent rules
guard it, both enforced in code:

1. **Kind validation** (:func:`validate_indicator`): the value must parse as the
   kind it claims; private, reserved, loopback, link-local, shared-address and
   multicast IPs, single-label hosts, internal/special-use names, the operator's
   ``chat_agent.internal_domains`` suffixes and (unless ``allow_email_lookup``)
   e-mail addresses are refused. Demo Mode dispatches nothing, so it additionally
   accepts the RFC 5737/3849 documentation networks and the RFC 2606 ``.example``
   names the demo dataset uses as its stand-in "internet".
2. **Taint** (:class:`TaintLedger`): the value must appear verbatim — as a whole
   token, never a fragment of one — in a message the USER authored in this
   conversation (``origin: "user"`` turns only) or in a code-provenance artifact
   field (an entity, IP, domain or hash column) a tool produced THIS turn. A value
   that only appeared in log text, a fenced observation or a model's own output is
   refused as "indicator not from user or evidence", so an injected "look up
   ceo@corp.example" cannot make the agent exfiltrate data.

The engine owns one :class:`TaintLedger` per turn and passes it to
``ChatToolbox.execute(..., taint=ledger)``; the toolbox feeds every successful
call's artifacts back into it (:meth:`TaintLedger.observe`) so later calls in the
same turn can look up what earlier ones found. The ledger also carries the per-turn
and per-conversation lookup budgets (``max_indicator_lookups`` and
``max_indicator_lookups_per_conversation``).
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from typing import Any, Iterable
from urllib.parse import urlsplit

from ...constants import IndicatorKind

# --------------------------------------------------------------------------- #
# Validation.
# --------------------------------------------------------------------------- #
MAX_INDICATOR_CHARS = 512

_HASH_RE = re.compile(r"^(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$")
_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@([^@\s]{1,253})$")
_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_TLD_RE = re.compile(r"^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$")
# Special-use / private-use names that never resolve on the public internet
# (RFC 6761/6762/8375 and the common private-use TLDs). Sending them to a third
# party would leak internal naming and can return nothing useful.
_SPECIAL_SUFFIXES = (
    "localhost", "local", "internal", "intranet", "lan", "home", "corp", "private",
    "home.arpa", "arpa", "test", "invalid", "example", "localdomain",
)
# RFC 2606 reserved documentation names. The demo dataset's domains live under
# ``.example``; Demo Mode dispatches nothing, so it accepts these (only).
_DEMO_SUFFIXES = frozenset({"example", "test", "invalid"})
# RFC 5737 / RFC 3849 documentation networks: the demo dataset's public stand-ins.
_DEMO_NETWORKS = tuple(
    ipaddress.ip_network(n)
    for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32")
)

# The kinds the tool accepts; ``hash`` is a convenience spelling of ``file_hash``.
KIND_ALIASES: dict[str, IndicatorKind] = {
    "ip": IndicatorKind.IP,
    "domain": IndicatorKind.DOMAIN,
    "url": IndicatorKind.URL,
    "file_hash": IndicatorKind.FILE_HASH,
    "hash": IndicatorKind.FILE_HASH,
    "email": IndicatorKind.EMAIL,
    "host": IndicatorKind.HOST,
}

# Engine-template refusal reasons (never echo the value).
REFUSED_INVALID = "not a valid {kind}"
REFUSED_PRIVATE_IP = "private, reserved, loopback or link-local addresses are never sent to third parties"
REFUSED_SINGLE_LABEL = "single-label or special-use host names are never sent to third parties"
REFUSED_INTERNAL = "internal domains are never sent to third parties"
REFUSED_EMAIL = "e-mail addresses are not sent to third parties on this deployment"
REFUSED_TAINT = "indicator not from user or evidence"


@dataclass(frozen=True)
class IndicatorCheck:
    """The outcome of :func:`validate_indicator`: the normalised value and kind, or
    an engine-template ``reason`` the value was refused."""

    value: str = ""
    kind: IndicatorKind | None = None
    reason: str | None = None

    @property
    def ok(self) -> bool:
        return self.reason is None and self.kind is not None


def detect_kind(value: str) -> IndicatorKind:
    """Best-effort classification (same order as ``GET /api/enrichment/lookup``):
    IP, hash, e-mail, URL (scheme or path), else domain."""
    text = (value or "").strip()
    try:
        ipaddress.ip_address(text)
        return IndicatorKind.IP
    except ValueError:
        pass
    if _HASH_RE.match(text.lower()):
        return IndicatorKind.FILE_HASH
    if _EMAIL_RE.match(text):
        return IndicatorKind.EMAIL
    if "://" in text or "/" in text:
        return IndicatorKind.URL
    return IndicatorKind.DOMAIN


def _ip_refusal(ip: Any, *, demo: bool) -> str | None:
    if demo and any(ip in net for net in _DEMO_NETWORKS if net.version == ip.version):
        return None
    # ``is_global`` already excludes RFC 1918, loopback, link-local, CGNAT shared
    # space, documentation and other reserved blocks; multicast is excluded too.
    if not ip.is_global or ip.is_multicast or ip.is_unspecified:
        return REFUSED_PRIVATE_IP
    return None


def _normalise_host(host: str) -> str:
    return host.strip().rstrip(".").lower()


def _domain_refusal(host: str, internal_domains: Iterable[str], *, demo: bool = False) -> str | None:
    """``None`` when ``host`` is a public multi-label DNS name we may send."""
    if not host or len(host) > 253:
        return REFUSED_INVALID.format(kind="domain")
    labels = host.split(".")
    if len(labels) < 2:
        return REFUSED_SINGLE_LABEL
    if not all(_LABEL_RE.match(label) for label in labels) or not _TLD_RE.match(labels[-1]):
        return REFUSED_INVALID.format(kind="domain")
    for suffix in _SPECIAL_SUFFIXES:
        if demo and suffix in _DEMO_SUFFIXES:
            continue
        if host == suffix or host.endswith("." + suffix):
            return REFUSED_SINGLE_LABEL
    for raw in internal_domains or ():
        suffix = _normalise_host(str(raw)).lstrip("*.").lstrip(".")
        if suffix and (host == suffix or host.endswith("." + suffix)):
            return REFUSED_INTERNAL
    return None


def validate_indicator(
    value: Any,
    kind: str | IndicatorKind | None = None,
    *,
    internal_domains: Iterable[str] = (),
    allow_email: bool = False,
    demo: bool = False,
) -> IndicatorCheck:
    """Validate and normalise one indicator for third-party enrichment (§4.8.3).

    ``kind`` may be omitted (auto-detected) or one of :data:`KIND_ALIASES`. Returns
    an :class:`IndicatorCheck` whose ``reason`` is an engine template when the value
    must not be sent. Never raises."""
    raw = str(value if value is not None else "").strip()
    if not raw or len(raw) > MAX_INDICATOR_CHARS or any(ch.isspace() for ch in raw):
        return IndicatorCheck(reason=REFUSED_INVALID.format(kind="indicator"))
    if kind is None or kind == "":
        resolved = detect_kind(raw)
    elif isinstance(kind, IndicatorKind):
        resolved = kind
    else:
        resolved = KIND_ALIASES.get(str(kind).strip().lower())
        if resolved is None:
            return IndicatorCheck(reason=REFUSED_INVALID.format(kind="indicator kind"))

    if resolved is IndicatorKind.IP:
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            return IndicatorCheck(reason=REFUSED_INVALID.format(kind="IP address"))
        refusal = _ip_refusal(ip, demo=demo)
        return IndicatorCheck(value=str(ip), kind=resolved, reason=refusal)

    if resolved is IndicatorKind.FILE_HASH:
        lowered = raw.lower()
        if not _HASH_RE.match(lowered):
            return IndicatorCheck(reason=REFUSED_INVALID.format(kind="MD5, SHA-1 or SHA-256 hash"))
        return IndicatorCheck(value=lowered, kind=resolved)

    if resolved is IndicatorKind.EMAIL:
        match = _EMAIL_RE.match(raw)
        if not match:
            return IndicatorCheck(reason=REFUSED_INVALID.format(kind="e-mail address"))
        if not allow_email:
            return IndicatorCheck(reason=REFUSED_EMAIL)
        domain = _normalise_host(match.group(1))
        refusal = _domain_refusal(domain, internal_domains, demo=demo)
        return IndicatorCheck(value=raw.lower(), kind=resolved, reason=refusal)

    if resolved is IndicatorKind.URL:
        try:
            parts = urlsplit(raw if "://" in raw else f"http://{raw}")
            host = parts.hostname or ""
        except ValueError:
            return IndicatorCheck(reason=REFUSED_INVALID.format(kind="URL"))
        if parts.scheme not in ("http", "https") or not host:
            return IndicatorCheck(reason=REFUSED_INVALID.format(kind="URL"))
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            refusal = _domain_refusal(_normalise_host(host), internal_domains, demo=demo)
        else:
            refusal = _ip_refusal(ip, demo=demo)
        return IndicatorCheck(value=raw, kind=resolved, reason=refusal)

    # DOMAIN / HOST: a public, multi-label DNS name.
    host = _normalise_host(raw)
    try:
        ipaddress.ip_address(host)
        return IndicatorCheck(reason=REFUSED_INVALID.format(kind="domain"))
    except ValueError:
        pass
    refusal = _domain_refusal(host, internal_domains, demo=demo)
    return IndicatorCheck(value=host, kind=resolved, reason=refusal)


# --------------------------------------------------------------------------- #
# The per-turn taint ledger.
# --------------------------------------------------------------------------- #
# Table columns whose cells count as evidence values (§4.8.3 "entity/ip/domain/hash
# column"), matched on the column key or its declared ``entity`` type.
EVIDENCE_COLUMN_KEYS = frozenset({
    "entity", "indicator", "ip", "source_ip", "src_ip", "dest_ip", "destination_ip",
    "domain", "hash", "file_hash", "sha256", "sha1", "md5", "url", "host",
})
_MAX_EVIDENCE_VALUES = 2_000
_MAX_USER_TEXT_CHARS = 200_000
# Characters that can never sit inside an indicator token (whitespace, quotes,
# brackets and list punctuation). ``. : / - _ @`` and the URL query characters stay.
_TOKEN_SPLIT_RE = re.compile(r"[\s<>\"'`()\[\]{}|\\^,;]+")
# Sentence punctuation that may trail a token ("look up 8.8.8.8.").
_TOKEN_TRIM = ".:!?"
_HOST_PORT_RE = re.compile(r"^([^:/@]+):(\d{1,5})$")
# Analysts paste defanged indicators; refang before tokenising so "evil[.]com" is
# the token "evil.com" (what the lookup will send), not three fragments.
_REFANG = (("[.]", "."), ("(.)", "."), ("{.}", "."), ("[:]", ":"), ("[@]", "@"),
           ("hxxps://", "https://"), ("hxxp://", "http://"))


def indicator_tokens(text: str) -> set[str]:
    """The whole-token indicator spellings in ``text`` (lowercased): every token,
    plus the components a person typed as part of one — a URL's host, a
    ``host:port``'s host and an e-mail address's domain. Never a fragment of a token:
    typing ``evil-example.com`` does not license ``example.com``, and ``1.2.3.45``
    does not license ``1.2.3.4``."""
    lowered = text.lower()
    for fanged, plain in _REFANG:
        lowered = lowered.replace(fanged, plain)
    tokens: set[str] = set()
    for raw in _TOKEN_SPLIT_RE.split(lowered):
        token = raw.strip(_TOKEN_TRIM)
        if not token:
            continue
        tokens.add(token)
        if "://" in token:
            try:
                host = urlsplit(token).hostname
            except ValueError:
                host = None
            if host:
                tokens.add(host.rstrip("."))
        elif "@" in token:
            domain = token.rsplit("@", 1)[1]
            if domain:
                tokens.add(domain)
        else:
            match = _HOST_PORT_RE.match(token)
            if match:
                tokens.add(match.group(1))
    return tokens


class TaintLedger:
    """What this turn may send to enrichment, and how many lookups remain.

    * ``user_texts`` — the texts of messages the USER authored in this conversation
      (the live message when its origin is ``user``, plus earlier ``origin: user``
      turns). Follow-up chips, starters, slash commands and continue requests are
      NOT user-authored for this rule (§4.8.2), so the engine leaves them out.
    * evidence — values collected by :meth:`observe` from CODE-provenance artifacts
      produced this turn (``provenance == "code"``): an ``entity`` artifact's value
      and the cells of evidence columns in ``table`` artifacts. Source-provenance
      artifacts (raw log rows, log facets) never qualify: their values are log text.
    * budgets — ``max_per_turn`` and ``max_per_conversation``; the conversation
      count starts at ``conversation_lookups`` (the engine's count of earlier
      successful lookups in this conversation). The budgets are enforced by whoever
      owns the loop: ``ChatToolbox.execute`` reserves one before running
      ``lookup_indicator`` and commits or releases it after; an engine that calls
      ``run`` itself checks :meth:`can_lookup` (with its in-batch count) and bumps
      :attr:`lookups` after a successful call.

    Matching is case-insensitive WHOLE-TOKEN equality for user text (a value must be
    one of the tokens the user typed, see :func:`indicator_tokens`; a substring is
    not enough, or "evil-example.com" would license "example.com") and
    case-insensitive equality for evidence values."""

    def __init__(
        self,
        user_texts: Iterable[str] = (),
        *,
        conversation_lookups: int = 0,
        max_per_turn: int = 3,
        max_per_conversation: int = 10,
    ) -> None:
        self._user_tokens: set[str] = set()
        self._user_chars = 0
        self._evidence: set[str] = set()
        self.max_per_turn = max(0, int(max_per_turn))
        self.max_per_conversation = max(0, int(max_per_conversation))
        self.conversation_lookups = max(0, int(conversation_lookups))
        #: Successful lookups this turn (an engine that counts itself may bump it).
        self.lookups = 0
        #: Lookups reserved by calls still running (see :meth:`reserve_lookup`).
        self.reserved = 0
        for item in user_texts:
            self.add_user_text(item)

    @classmethod
    def for_turn(
        cls, prefs: Any, user_texts: Iterable[str] = (), *, conversation_lookups: int = 0,
    ) -> "TaintLedger":
        """A ledger with the budgets of ``prefs.chat_agent``."""
        cfg = getattr(prefs, "chat_agent", None)
        return cls(
            user_texts,
            conversation_lookups=conversation_lookups,
            max_per_turn=int(getattr(cfg, "max_indicator_lookups", 3)),
            max_per_conversation=int(getattr(cfg, "max_indicator_lookups_per_conversation", 10)),
        )

    # -- sources of trust --------------------------------------------------- #
    def add_user_text(self, text: Any) -> None:
        if not isinstance(text, str) or not text:
            return
        if self._user_chars >= _MAX_USER_TEXT_CHARS:
            return
        clipped = text[: _MAX_USER_TEXT_CHARS - self._user_chars]
        self._user_tokens.update(indicator_tokens(clipped))
        self._user_chars += len(clipped)

    def add_evidence(self, value: Any) -> None:
        if isinstance(value, str) and value.strip() and len(self._evidence) < _MAX_EVIDENCE_VALUES:
            self._evidence.add(value.strip().lower())

    def observe(self, artifacts: Iterable[Any]) -> None:
        """Collect evidence values from code-provenance artifacts (see class doc)."""
        for artifact in artifacts or ():
            if getattr(artifact, "provenance", None) != "code":
                continue
            data = getattr(artifact, "data", None) or {}
            kind = getattr(artifact, "kind", None)
            if kind == "entity":
                entity = data.get("entity") if isinstance(data, dict) else None
                if isinstance(entity, dict):
                    self.add_evidence(entity.get("value"))
            elif kind == "table" and isinstance(data, dict):
                columns = data.get("columns") or []
                wanted = [
                    i for i, col in enumerate(columns)
                    if isinstance(col, dict)
                    and (col.get("type") == "entity" or str(col.get("key", "")).lower() in EVIDENCE_COLUMN_KEYS)
                ]
                for row in data.get("rows") or []:
                    if not isinstance(row, (list, tuple)):
                        continue
                    for i in wanted:
                        if i < len(row):
                            self.add_evidence(row[i])

    #: Alias for engines that speak of "adding artifacts" to the ledger.
    add_artifacts = observe

    # -- the rule ----------------------------------------------------------- #
    def permits(self, value: Any) -> bool:
        """True when ``value`` came from the user or from code-provenance evidence."""
        if not isinstance(value, str) or not value.strip():
            return False
        needle = value.strip().lower()
        return needle in self._evidence or needle in self._user_tokens

    def check(
        self,
        value: Any,
        kind: str | IndicatorKind | None = None,
        *,
        egress: bool = True,
        internal_domains: Iterable[str] = (),
        allow_email: bool = False,
    ) -> tuple[bool, str | None]:
        """``(allowed, reason)`` for one value: kind validation (only when the value
        would leave the deployment, ``egress``; Demo Mode passes ``False``), then the
        taint rule. ``reason`` is an engine template."""
        result = validate_indicator(
            value, kind, internal_domains=internal_domains, allow_email=allow_email,
            demo=not egress,
        )
        if not result.ok:
            return False, result.reason
        if not (self.permits(result.value) or self.permits(value)):
            return False, REFUSED_TAINT
        return True, None

    # -- budgets ------------------------------------------------------------ #
    def lookups_remaining(self, in_flight: int = 0) -> int:
        used = self.lookups + self.reserved + max(0, int(in_flight))
        return max(0, min(
            self.max_per_turn - used,
            self.max_per_conversation - self.conversation_lookups - used,
        ))

    def can_lookup(self, in_flight: int = 0) -> bool:
        return self.lookups_remaining(in_flight) > 0

    def reserve_lookup(self) -> bool:
        """Hold one lookup for a call about to run; False when a budget is spent.
        Sync, so parallel calls in one batch (one event loop) cannot overspend."""
        if not self.can_lookup():
            return False
        self.reserved += 1
        return True

    def commit_lookup(self) -> None:
        """The reserved call succeeded: it now counts against both budgets."""
        self.reserved = max(0, self.reserved - 1)
        self.lookups += 1

    def release_lookup(self) -> None:
        """The reserved call was refused or failed: give the lookup back."""
        self.reserved = max(0, self.reserved - 1)

    @property
    def lookups_this_turn(self) -> int:
        return self.lookups


__all__ = [
    "EVIDENCE_COLUMN_KEYS",
    "IndicatorCheck",
    "KIND_ALIASES",
    "MAX_INDICATOR_CHARS",
    "REFUSED_EMAIL",
    "REFUSED_INTERNAL",
    "REFUSED_PRIVATE_IP",
    "REFUSED_SINGLE_LABEL",
    "REFUSED_TAINT",
    "TaintLedger",
    "detect_kind",
    "indicator_tokens",
    "validate_indicator",
]
