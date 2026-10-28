"""What changed, as the audit log records it (Round 14 SPEC §4.5.3 ``changes``).

:func:`diff_changes` compares the stored document before a write with the validated
document after it and returns one :class:`~app.models.AuditChange` per changed field,
named by its dotted path (``auto_close.false_positive.min_confidence``). Lists whose
items carry a unique ``id`` (or ``name``) are compared item by item
(``sources[web-proxy].config.url``); any other list is one value.

Nothing secret is ever recorded:

* A field whose name is sensitive (the data export's list, ``password``,
  ``api_key``, ``client_secret`` and the rest; the credential names a notification
  channel or connector reads, such as ``routing_key``; and any text field, or flat
  list holding text, named ``key`` or ``keys``, ending in ``_key`` or ``_keys``, or
  whose name speaks of a password, secret, token or credential in the singular or
  the plural) is written as ``{field, before: None, after: None, secret: True}``.
  Both sides of a change are judged, so a secret replaced by a value of another
  type (a flag, a number) is still withheld. A true or false flag is never secret
  on its own (``must_change_password`` stays readable). The lists the product
  defines as holding field NAMES, never values (``configured_secrets``,
  ``entity_keys``), stay readable.
* A field named ``url`` or containing ``webhook`` (a notification channel's
  ``config.url``, a source URL) keeps only the scheme and host of a network address:
  Slack and Teams webhook URLs carry their credential in the path, so
  ``https://hooks.slack.com/services/T0/B0/X`` is recorded as
  ``https://hooks.slack.com``, and the entry is marked ``secret`` because something
  was removed. A value there that is not a well-formed address (a mistyped
  ``hooks.slack.com/services/T0/B0/X``) never keeps its path or query either: it is
  cut to the host it names, or to ``[REDACTED]`` when it names none. A ``data:`` URL
  and a bare host stay as they are.
* Any other text passes through the data export's secret patterns (bearer tokens,
  ``sk-`` keys, private key blocks) and a basic credential header, and a
  ``user:password@`` inside any address is removed (and the entry marked
  ``secret``).
* A list is one value, and every item in it gets the same treatment: text is
  redacted (and an address reduced under a URL name), and inside a mapping a
  sensitive name has its value replaced by ``[REDACTED]``. So a list of hosts with
  credentials, a list of headers or a list of unnamed entries carrying a password
  never reaches the record either.

Values that are not text are stored as canonical JSON text by the model; every value
is cut to 500 characters and a write records at most 50 changes. A list or mapping
that goes from empty to holding keyed items (or back) is recorded only through its
items, never as an extra "removed" or "added" entry for the container. The bookkeeping stamps
a store sets on every save (``created_at``, ``updated_at``) are not changes a person
made and are left out (they would also be the first date-looking text an older
Elasticsearch audit index could map as a date, see DEPLOY.md on rolling the index).
"""

from __future__ import annotations

import functools
import re
from typing import Any, Iterable, Mapping
from urllib.parse import urlsplit

from ..models import AUDIT_MAX_CHANGES, AuditChange

#: Words that make a TEXT field secret by name (a number never is, so
#: ``turn_token_ceiling`` and ``max_tokens`` stay readable).
_SECRET_WORDS = frozenset({
    "password", "passwd", "passphrase", "secret", "secrets", "token", "credential",
    "credentials", "apikey", "privatekey", "connectionstring",
})
#: Credential names the export list does not carry but a notification channel or a
#: connector reads as its secret (``PagerDutyChannel`` reads ``config.routing_key``;
#: the dispatcher's own secret field names). Withheld whatever the value's type.
_SECRET_NAMES = frozenset({
    "routing_key", "integration_key", "signing_key", "hmac_key", "shared_key", "sas_key",
    "license_key", "encryption_key", "secret_key", "bot_token",
})
#: Lists the product defines as holding field NAMES, never values (which secret
#: fields a source or channel has set; which entity fields cross-source correlation
#: joins on): readable even though their names speak of secrets or keys. The export
#: rule and the credential names above still win.
_FIELD_NAME_LISTS = frozenset({"configured_secrets", "entity_keys"})
#: Leaf names that are store bookkeeping, never a person's change (see the module doc).
_BOOKKEEPING_KEYS = frozenset({"created_at", "updated_at"})
#: ``scheme://userinfo@`` up to the LAST ``@`` of the authority, so a password that
#: itself holds an ``@`` is removed whole (the authority ends at ``/``, ``?``, ``#``
#: or whitespace; a raw ``/`` cannot appear in userinfo).
_USERINFO_RE = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)([^/\s?#]*@)")
#: A basic or digest credential in header text (``Authorization: Basic dXNlcjpw``),
#: beside the export's bearer pattern.
_HEADER_CREDENTIAL_RE = re.compile(r"(?i)\b(Basic|Digest)\s+[A-Za-z0-9._~+/=-]{8,}")
_REDACTED = "[REDACTED]"
_JOINERS = re.compile(r"[^a-z0-9]+")


@functools.lru_cache(maxsize=1)
def _export_rules() -> tuple[frozenset[str], tuple[str, ...], tuple[re.Pattern[str], ...]]:
    """The data export's sensitive key names, suffixes and secret text patterns (one
    definition, so the audit log and the export can never disagree on what is secret).
    Imported on first use: the export module is an API module."""
    from ..api import routes_export

    return (
        frozenset(routes_export._SENSITIVE_KEYS),
        tuple(routes_export._SENSITIVE_SUFFIXES),
        tuple(routes_export._TEXT_SECRET_PATTERNS),
    )


def _normal_key(key: str) -> str:
    return str(key).strip().lower().replace("-", "_")


def _singular(word: str) -> str:
    """``word`` without a plural ``s`` (``tokens``, ``passwords``, ``keys``); a word
    ending in ``ss`` or of three letters or fewer is left as it is."""
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _is_text_list(value: Any) -> bool:
    """A flat list or tuple (no mapping or list inside) holding at least one text
    item: it can carry a credential the way a text field can."""
    if not isinstance(value, (list, tuple)):
        return False
    if any(isinstance(item, (Mapping, list, tuple)) for item in value):
        return False
    return any(isinstance(item, str) for item in value)


def is_secret_key(key: str, value: Any = None) -> bool:
    """Is a field named ``key`` (holding ``value``) secret?

    A true or false flag never is: it cannot carry a credential, and hiding it would
    hide what an account change did (``must_change_password``). Otherwise the export's
    rule and the credential names (``routing_key``) apply whatever the value's type.
    The broader rules (a name that speaks of a password, secret, token or credential,
    singular or plural, or a name that is ``key``/``keys`` or ends in ``_key``/
    ``_keys``) apply to text and to a flat list holding text only, so ``max_tokens``
    stays readable; the lists that hold field names (:data:`_FIELD_NAME_LISTS`) do
    too. A caller judging a change asks for each side (:func:`diff_changes` does)."""
    if isinstance(value, bool):
        return False
    if _is_export_secret(key):
        return True
    normal = _normal_key(key)
    if normal in _SECRET_NAMES:
        return True
    if value is not None and not isinstance(value, str) and not _is_text_list(value):
        return False
    if normal in _FIELD_NAME_LISTS and isinstance(value, (list, tuple)):
        return False
    words = [_singular(w) for w in _JOINERS.split(normal) if w]
    if any(word in _SECRET_WORDS for word in words):
        return True
    if words and words[-1] == "key":
        return True
    squashed = "".join(_JOINERS.split(normal))
    return any(
        form in _SECRET_WORDS or form.endswith(("apikey", "privatekey", "secret", "password"))
        for form in (squashed, _singular(squashed))
    )


def _is_url_key(key: str) -> bool:
    normal = _normal_key(key)
    return normal == "url" or "webhook" in normal


#: Schemes whose value is data, never a network address (a logo as a ``data:`` URL).
_OPAQUE_SCHEMES = frozenset({"data"})
#: A host on its own, with an optional port (``hooks.example``, ``10.0.0.5:9200``).
_BARE_HOST_RE = re.compile(r"[A-Za-z0-9._-]+(?::\d{1,5})?")
#: A leading ``scheme:`` that is not a host's port (``https:`` but not ``localhost:8080``).
_LEADING_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:(?!\d+(?:[/?#\\]|$))")
#: What a host name or address may hold once parsed (an IPv6 literal holds ``:``).
_HOST_RE = re.compile(r"[A-Za-z0-9._:-]+")


def _host_port(parts: Any) -> str:
    """``host[:port]`` of parsed address ``parts``, or ``""`` when it names no host."""
    host = parts.hostname or ""
    if not host or not _HOST_RE.fullmatch(host):
        return ""
    if ":" in host:  # an IPv6 literal keeps its brackets
        host = f"[{host}]"
    try:
        port = parts.port
    except ValueError:
        return ""
    return host + (f":{port}" if port else "")


def reduce_url(value: str) -> tuple[str, bool]:
    """``(scheme://host[:port], removed)`` for a network address; the value unchanged
    (``removed`` False) when it is data, not an address (a ``data:`` URL), or a bare
    host.

    A value that is not a well-formed address never keeps its path or query either
    (Slack and Teams carry the credential in the path, and a mistyped
    ``hooks.slack.com/services/T/B/X``, ``//hooks.slack.com/...`` or
    ``https:hooks.slack.com/...`` would otherwise be recorded whole): it is reduced to
    the host it names, and to ``[REDACTED]`` when no host can be read from it."""
    text = value.strip()
    if not text:
        return value, False
    try:
        parts = urlsplit(text)
    except ValueError:
        parts = None
    if parts is not None and parts.scheme and parts.netloc:
        host = parts.hostname or ""
        if not host:
            return f"{parts.scheme}://", True
        if ":" in host:  # an IPv6 literal keeps its brackets
            host = f"[{host}]"
        try:
            port = parts.port
        except ValueError:
            port = None
        reduced = f"{parts.scheme}://{host}" + (f":{port}" if port else "")
        return reduced, reduced != text
    if parts is not None and parts.scheme.lower() in _OPAQUE_SCHEMES:
        return value, False
    if _BARE_HOST_RE.fullmatch(text):
        return value, False
    # Not a well-formed address: keep only the host it names, never its path.
    rest = _LEADING_SCHEME_RE.sub("", text, count=1).lstrip("/\\")
    if not rest:
        return value, False  # a scheme alone ("https:", "https://") names nothing
    try:
        host = _host_port(urlsplit("//" + rest))
    except ValueError:
        host = ""
    if host:
        return host, host != text
    return _REDACTED, True


def redact_text(value: str) -> tuple[str, bool]:
    """``(text, removed)``: the export's secret patterns and a basic or digest
    credential replaced by ``[REDACTED]``, and any ``user:password@`` removed from an
    address."""
    _keys, _suffixes, patterns = _export_rules()
    text = value
    for pattern in patterns:
        text = pattern.sub(_REDACTED, text)
    text = _HEADER_CREDENTIAL_RE.sub(_REDACTED, text)
    text = _USERINFO_RE.sub(r"\1", text)
    return text, text != value


def _safe_value(key: str, value: Any) -> tuple[Any, bool]:
    """A value as it may be recorded, and whether anything was removed from it.

    Text is redacted (and reduced to scheme and host under a URL name). A list or a
    mapping (a list leaf, which :func:`_flatten` keeps whole) is walked: every text
    item gets the same treatment under the list's name, and inside a mapping a
    sensitive name (:func:`is_secret_key`) has its value replaced by ``[REDACTED]``."""
    if isinstance(value, str):
        if _is_url_key(key):
            reduced, removed = reduce_url(value)
            text, redacted = redact_text(reduced)
            return text, removed or redacted
        return redact_text(value)
    if isinstance(value, (list, tuple)):
        out: list[Any] = []
        removed_any = False
        for item in value:
            safe, removed = _safe_value(key, item)
            out.append(safe)
            removed_any = removed_any or removed
        return out, removed_any
    if isinstance(value, Mapping):
        masked: dict[str, Any] = {}
        removed_any = False
        for child_key, child in value.items():
            name = str(child_key)
            if child is not None and is_secret_key(name, child):
                masked[name] = _REDACTED
                removed_any = True
                continue
            safe, removed = _safe_value(name, child)
            masked[name] = safe
            removed_any = removed_any or removed
        return masked, removed_any
    return value, False


def _item_key(item: Any) -> str | None:
    if isinstance(item, Mapping):
        for name in ("id", "name"):
            value = item.get(name)
            if isinstance(value, str) and value:
                return value
    return None


def _keyed_items(items: list[Any]) -> dict[str, Any] | None:
    """``{key: item}`` when every item is a mapping with a unique ``id`` or ``name``."""
    if not items:
        return None
    out: dict[str, Any] = {}
    for item in items:
        key = _item_key(item)
        if key is None or key in out:
            return None
        out[key] = item
    return out


def _flatten(value: Any, path: str, leaf_key: str, out: dict[str, tuple[str, Any]]) -> None:
    """``out[path] = (leaf key, value)`` for every leaf under ``value``."""
    if isinstance(value, Mapping):
        if not value:
            out[path] = (leaf_key, {})
            return
        for key in value:
            child = f"{path}.{key}" if path else str(key)
            _flatten(value[key], child, str(key), out)
        return
    if isinstance(value, list):
        keyed = _keyed_items(value)
        if keyed is not None:
            for key, item in keyed.items():
                _flatten(item, f"{path}[{key}]", leaf_key, out)
            return
    out[path] = (leaf_key, value)


def _is_export_secret(key: str) -> bool:
    keys, suffixes, _patterns = _export_rules()
    normal = _normal_key(key)
    return normal in keys or normal.endswith(suffixes)


def _flatten_root(doc: Mapping[str, Any] | None, prefix: str) -> dict[str, tuple[str, Any]]:
    """Every leaf of a document under ``prefix`` (an empty document has none)."""
    out: dict[str, tuple[str, Any]] = {}
    for key, value in (doc or {}).items():
        path = f"{prefix}.{key}" if prefix else str(key)
        _flatten(value, path, str(key), out)
    return out


def _secret_path(path_keys: Iterable[str], value: Any) -> bool:
    """A leaf holding ``value`` is secret by its own name (:func:`is_secret_key`) or
    because a parent is a secret container by the export's rule
    (``connector_secrets.x.y``)."""
    keys = list(path_keys)
    if not keys:
        return False
    *parents, leaf = keys
    if any(_is_export_secret(parent) for parent in parents):
        return True
    return is_secret_key(leaf, value)


_SEGMENT_RE = re.compile(r"\[[^\]]*\]")


def _path_keys(path: str) -> list[str]:
    return [part for part in _SEGMENT_RE.sub("", path).split(".") if part]


def diff_changes(
    before: Mapping[str, Any] | None,
    after: Mapping[str, Any] | None,
    *,
    prefix: str = "",
    secret_fields: Iterable[str] = (),
) -> list[AuditChange]:
    """Every changed field between two documents, secrets withheld (module doc).

    ``prefix`` names the documents' place (``branding`` makes ``branding.org_name``);
    ``secret_fields`` adds dotted paths that are always secret (a password field).
    Sorted by path for a stable row; never more than :data:`AUDIT_MAX_CHANGES`
    entries (see :func:`count_changes` for the full number)."""
    return _diff(before, after, prefix=prefix, secret_fields=secret_fields)[:AUDIT_MAX_CHANGES]


def count_changes(before: Mapping[str, Any] | None, after: Mapping[str, Any] | None,
                  *, prefix: str = "") -> int:
    """How many fields changed, uncapped (for a summary such as "63 fields")."""
    return len(changed_values(before, after, prefix=prefix))


def changed_values(
    before: Mapping[str, Any] | None,
    after: Mapping[str, Any] | None,
    *,
    prefix: str = "",
) -> dict[str, tuple[Any, Any]]:
    """``{path: (old, new)}`` for every changed leaf, by path, with the RAW values (a
    missing leaf reads ``None``; bookkeeping stamps are left out). For comparing two
    edits exactly (the settings compare-and-swap), never for recording: the recorded
    form is :func:`diff_changes`."""
    old = _flatten_root(before, prefix)
    new = _flatten_root(after, prefix)
    out: dict[str, tuple[Any, Any]] = {}
    for path in sorted(set(old) | set(new)):
        b_value = old[path][1] if path in old else None
        a_value = new[path][1] if path in new else None
        if b_value == a_value:
            continue
        keys = _path_keys(path)
        if keys and keys[-1] in _BOOKKEEPING_KEYS:
            continue
        if _container_shown_by_items(path, b_value, a_value, old if path in new else new):
            continue
        out[path] = (b_value, a_value)
    return out


def _container_shown_by_items(path: str, b_value: Any, a_value: Any,
                              other: Mapping[str, Any]) -> bool:
    """An empty list or mapping on one side whose other side holds items at deeper
    paths (``channels: []`` before, ``channels[pd].type`` after): the items record
    the change, and the container alone would read as removed (or added) when the
    opposite happened."""
    if b_value is not None and a_value is not None:
        return False
    present = b_value if b_value is not None else a_value
    if not isinstance(present, (list, dict)) or present:
        return False
    return any(other_path.startswith((f"{path}[", f"{path}.")) for other_path in other)


def _diff(before: Mapping[str, Any] | None, after: Mapping[str, Any] | None, *,
          prefix: str, secret_fields: Iterable[str]) -> list[AuditChange]:
    forced = {str(f) for f in secret_fields}
    changes: list[AuditChange] = []
    for path, (b_value, a_value) in changed_values(before, after, prefix=prefix).items():
        field = path or "value"
        keys = _path_keys(path)
        # Both sides are judged: a secret text replaced by a flag (or the reverse) is
        # secret by its text side, so neither value is recorded.
        sides = [value for value in (b_value, a_value) if value is not None]
        if path in forced or any(_secret_path(keys, value) for value in sides):
            changes.append(AuditChange(field=field, before=None, after=None, secret=True))
            continue
        leaf = keys[-1] if keys else ""
        removed = False
        safe_before = safe_after = None
        if b_value is not None:
            safe_before, cut = _safe_value(leaf, b_value)
            removed = removed or cut
        if a_value is not None:
            safe_after, cut = _safe_value(leaf, a_value)
            removed = removed or cut
        changes.append(AuditChange(field=field, before=safe_before, after=safe_after, secret=removed))
    return changes


def changed_sections(changes: Iterable[AuditChange]) -> list[str]:
    """The top-level names the changes touch, in order (``auto_close``, ``rag``)."""
    seen: dict[str, None] = {}
    for change in changes:
        head = _SEGMENT_RE.split(change.field, 1)[0].split(".", 1)[0]
        if head:
            seen.setdefault(head, None)
    return list(seen)


__all__ = [
    "changed_sections",
    "changed_values",
    "count_changes",
    "diff_changes",
    "is_secret_key",
    "redact_text",
    "reduce_url",
]
