"""Decode an NT security descriptor (SDDL) into readable ACEs — a read-only tool.

Windows logs an ACL change (Event 5136 on ``nTSecurityDescriptor``) as a raw **SDDL**
string — 3-4k characters of ``O:..G:..D:(ace)(ace)..`` that an LLM cannot reliably
parse and that our #9 injection fence deliberately truncates before it reaches a
prompt. The signal an analyst needs — *which right was granted to whom* — is encoded
inside it. In particular, an ACE granting the **directory-replication** extended
rights (``DS-Replication-Get-Changes`` + ``-Get-Changes-All``) to a non-DC principal
is the setup half of a **DCSync** attack.

This tool does the deterministic decode the model shouldn't guess at: it parses the
DACL, maps each ACE's rights and object GUID to human names, and flags the dangerous
grants. It is **purely a decoder** — it returns facts (rights, GUIDs, trustee SIDs),
never a verdict. The agent still decides whether the decoded grant is malicious.

Read-only and offline: it parses a string already present in the event. It queries
nothing, needs no directory and no credentials, so it stays ``ToolTier.SAFE``. (A live
DC would additionally resolve trustee SIDs to account names; that is enrichment layered
on top, not required for the decode.)
"""

from __future__ import annotations

import re
from typing import Any

from ..constants import ToolTier
from ..utils import dotted_get
from .base import Tool, ToolResult

# Where the SDDL lives on an event (same ladder the prompt projection uses).
_SDDL_PATHS = ("winlog.event_data.AttributeValue", "unmapped.AttributeValue")

# Sentinel that splits the tool summary into a DELTA-first headline (before it) and
# the full decoded ACL detail (after it). The Timeline/Why panel renders the head
# inline and tucks the tail behind a "view full ACL" disclosure.
_FULL_ACL_MARKER = "---DECODED-ACL-DETAIL---"

# Well-known AD extended-right / validated-write GUIDs (object GUID field of an ACE).
# The replication rights are the DCSync signature; the others are common ACL-abuse
# grants worth surfacing. GUIDs are matched case-insensitively.
_EXTENDED_RIGHTS: dict[str, str] = {
    "1131f6aa-9c07-11d1-f79f-00c04fc2dcd2": "DS-Replication-Get-Changes",
    "1131f6ad-9c07-11d1-f79f-00c04fc2dcd2": "DS-Replication-Get-Changes-All",
    "89e95b76-444d-4c62-991a-0facbeda640c": "DS-Replication-Get-Changes-In-Filtered-Set",
    "1131f6ab-9c07-11d1-f79f-00c04fc2dcd2": "DS-Replication-Synchronize",
    "1131f6ac-9c07-11d1-f79f-00c04fc2dcd2": "DS-Replication-Manage-Topology",
    "00299570-246d-11d0-a768-00aa006e0529": "User-Force-Change-Password",
    "ab721a53-1e2f-11d0-9819-00aa0040529b": "User-Change-Password",
}

# Object GUIDs that constitute the DCSync grant when held together.
_REPLICATION_GUIDS = {
    "1131f6aa-9c07-11d1-f79f-00c04fc2dcd2",
    "1131f6ad-9c07-11d1-f79f-00c04fc2dcd2",
    "89e95b76-444d-4c62-991a-0facbeda640c",
}

# SDDL access-right abbreviations → readable name (the security-relevant subset).
_RIGHTS: dict[str, str] = {
    "CR": "Control-Access (extended right)",
    "RP": "Read-Property",
    "WP": "Write-Property",
    "CC": "Create-Child",
    "DC": "Delete-Child",
    "LC": "List-Children",
    "SW": "Self-Write",
    "LO": "List-Object",
    "DT": "Delete-Tree",
    "RC": "Read-Control",
    "SD": "Delete",
    "WD": "Write-DACL",
    "WO": "Write-Owner",
    "GA": "Generic-All",
    "GX": "Generic-Execute",
    "GW": "Generic-Write",
    "GR": "Generic-Read",
}

# Rights that hand an attacker control of the object (ACL takeover primitives).
_DANGEROUS_RIGHTS = {"WD", "WO", "GA", "GW"}

# Well-known trustee SIDs worth naming inline (the rest are returned verbatim).
_WELL_KNOWN_SIDS: dict[str, str] = {
    "S-1-5-18": "Local System",
    "S-1-5-32-544": "Builtin Administrators",
    "S-1-5-11": "Authenticated Users",
    "S-1-1-0": "Everyone",
    "S-1-5-9": "Enterprise Domain Controllers",
    "BA": "Builtin Administrators",
    "DA": "Domain Admins",
    "EA": "Enterprise Admins",
    "SA": "Schema Admins",
    "SY": "Local System",
    "AU": "Authenticated Users",
    "WD": "Everyone",  # NOTE: 'WD' as a *trustee* alias is Everyone; as a right it is Write-DACL
    "ED": "Enterprise Domain Controllers",
    "DD": "Domain Controllers",
    "DC": "Domain Computers",
    "DU": "Domain Users",
    "DG": "Domain Guests",
    "CO": "Creator Owner",
    "CG": "Creator Group",
    "PA": "Group Policy Admins",
    "CA": "Cert Publishers",
    "RO": "Enterprise Read-Only Domain Controllers",
}

_ACE_RE = re.compile(r"\(([^()]*)\)")
_RIGHTS_TOKEN_RE = re.compile(r"[A-Z]{2}")


def _split_rights(field: str) -> list[str]:
    """Split a concatenated SDDL rights string ("CCDCLCRP") into 2-char tokens."""
    field = field.strip()
    if field.startswith("0x"):  # numeric access mask — leave as-is
        return [field]
    return _RIGHTS_TOKEN_RE.findall(field)


def _name_rights(tokens: list[str]) -> list[str]:
    return [_RIGHTS.get(t, t) for t in tokens]


def _name_trustee(sid: str) -> str:
    sid = sid.strip()
    return _WELL_KNOWN_SIDS.get(sid, sid)


class DecodeAclTool(Tool):
    name = "decode_acl"
    description = (
        "Decode a Windows NT security descriptor (SDDL string, e.g. the "
        "nTSecurityDescriptor value from an Event 5136 ACL change) into readable "
        "access-control entries. Returns, for each ACE, the rights granted, any "
        "extended-right/object GUID resolved to its name, and the trustee SID. "
        "Flags grants of Active Directory replication rights (the DCSync setup) and "
        "object-takeover rights (Write-DACL/Write-Owner/Generic-All). Use this when "
        "an event carries an 'attribute_value' that looks like SDDL "
        "(starts with 'O:' / 'D:'); do NOT try to parse the raw SDDL yourself. "
        "PREFER passing 'event_id' (the event's id): the SDDL shown in the prompt is "
        "truncated, so pass the id and the tool reads the FULL descriptor server-side. "
        "This only decodes — it does not decide whether the change is malicious."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "event_id": {
                "type": "string",
                "description": "id of the event whose SDDL to decode (preferred — reads "
                               "the full, untruncated descriptor from the event)",
            },
            "sddl": {
                "type": "string",
                "description": "raw SDDL string to decode directly (fallback; only "
                               "complete if you actually have the whole string)",
            },
        },
        "additionalProperties": False,
    }
    tier = ToolTier.SAFE

    def __init__(self) -> None:
        # event id -> full SDDL, populated per-investigation via bind_events so the
        # model can reference an event without ever holding the (fence-truncated) blob.
        self._sddl_by_id: dict[str, str] = {}
        # (timestamp_millis, sddl) for every descriptor-bearing event, time-ordered.
        # Lets the tool compare the earliest (existing) vs latest (after) descriptor
        # and report the DELTA — the ACEs the attacker ADDED — instead of a flat dump.
        self._descriptors: list[tuple[int, str]] = []

    def bind_events(self, events: list[Any]) -> None:
        mapping: dict[str, str] = {}
        descriptors: list[tuple[int, str]] = []
        for ev in events or []:
            src = getattr(ev, "source", None)
            if not isinstance(src, dict):
                continue
            for path in _SDDL_PATHS:
                val = dotted_get(src, path)
                if val:
                    eid = str(getattr(ev, "id", ""))
                    mapping[eid] = str(val)
                    ts = int(getattr(ev, "timestamp_millis", 0) or 0)
                    descriptors.append((ts, str(val)))
                    break
        self._sddl_by_id = mapping
        # Keep only DISTINCT descriptors (an object rewritten many times logs the same
        # state repeatedly); order by time so [0] is the baseline and [-1] the latest.
        seen: set[str] = set()
        uniq = [(ts, s) for ts, s in sorted(descriptors) if not (s in seen or seen.add(s))]
        self._descriptors = uniq

    async def run(self, **kwargs: Any) -> ToolResult:
        event_id = str(kwargs.get("event_id", "")).strip()
        sddl = str(kwargs.get("sddl", "")).strip()
        source = "sddl-string"
        if event_id:
            full = self._sddl_by_id.get(event_id)
            if full:
                sddl, source = full, f"event {event_id}"
            elif not sddl:
                known = ", ".join(sorted(self._sddl_by_id)) or "none in this case"
                return ToolResult(
                    ok=False,
                    error=f"no SDDL found for event_id '{event_id}'. "
                          f"Events with a decodable descriptor: {known}.",
                )
        if not sddl:
            return ToolResult(ok=False, error="provide event_id (preferred) or a full sddl string")
        try:
            # When the case captured the object BEFORE and AFTER the change (paired
            # Windows 5136 delete-old/add-new events), report the DELTA across the whole
            # change window. Pick the two endpoints by **ACL size, not timestamp**: an
            # attacker appends ACEs, so the SMALLEST descriptor is the pre-change baseline
            # and the LARGEST is the final state. (Timestamp order is unreliable — replay
            # retiming can collapse a burst into near-identical millisecond stamps, which
            # would select two adjacent mid-attack states and hugely under-count the delta.)
            if len(self._descriptors) >= 2:
                by_size = sorted(self._descriptors, key=lambda d: len(self._aces(d[1])))
                baseline_sddl, final_sddl = by_size[0][1], by_size[-1][1]
                if baseline_sddl == final_sddl:
                    res = self._decode_single(sddl)
                else:
                    res = self._decode_delta(baseline_sddl, final_sddl)
            else:
                res = self._decode_single(sddl)
            res.meta = {**res.meta, "decoded_from": source}
            return res
        except Exception as exc:  # noqa: BLE001 — a decoder must never crash the loop
            return ToolResult(ok=False, error=f"could not parse SDDL: {exc}")

    # ----- ACE parsing (shared) ---------------------------------------------
    def _aces(self, sddl: str) -> list[dict[str, Any]]:
        """Decode a descriptor's DACL into a list of classified ACE dicts."""
        aces: list[dict[str, Any]] = []
        for raw in _ACE_RE.findall(self._dacl_region(sddl)):
            fields = raw.split(";")
            if len(fields) < 6:
                continue
            _type, _flags, rights_str, object_guid, _inherit, sid = fields[:6]
            tokens = _split_rights(rights_str)
            guid = object_guid.strip().lower()
            ace: dict[str, Any] = {
                "rights": _name_rights(tokens),
                "trustee_sid": _name_trustee(sid),
            }
            if guid:
                ace["object_guid"] = guid
                ace["object_right"] = _EXTENDED_RIGHTS.get(guid, "unknown extended-right/property")
            if guid in _REPLICATION_GUIDS:
                ace["flag"] = "AD_REPLICATION_RIGHT"
            elif set(tokens) & _DANGEROUS_RIGHTS:
                ace["flag"] = "OBJECT_TAKEOVER_RIGHT"
            aces.append(ace)
        return aces

    @staticmethod
    def _ace_key(ace: dict[str, Any]) -> tuple:
        """Stable identity for diffing: (rights, object-guid, trustee)."""
        return (tuple(ace.get("rights", [])), ace.get("object_guid", ""), ace.get("trustee_sid", ""))

    @staticmethod
    def _classify(aces: list[dict[str, Any]]) -> tuple[list, list]:
        repl = [a for a in aces if a.get("flag") == "AD_REPLICATION_RIGHT"]
        takeover = [a for a in aces if a.get("flag") == "OBJECT_TAKEOVER_RIGHT"]
        return repl, takeover

    @staticmethod
    def _grant_phrase(aces: list[dict[str, Any]]) -> str:
        """'DS-Replication-Get-Changes-All to S-1-…-1121' style summary of grants."""
        by_trustee: dict[str, set[str]] = {}
        for a in aces:
            right = a.get("object_right") or ", ".join(a.get("rights", []))
            by_trustee.setdefault(a["trustee_sid"], set()).add(right)
        return "; ".join(f"{t} -> {', '.join(sorted(rs))}" for t, rs in by_trustee.items())

    def _full_acl_block(self, aces: list[dict[str, Any]], limit: int = 80) -> str:
        """A compact one-line-per-ACE rendering of the ACL (the 'view full'). Bounded so a
        pathologically large descriptor can't blow the audit-record size."""
        lines = []
        for a in aces[:limit]:
            right = a.get("object_right") or ", ".join(a.get("rights", []))
            mark = " *ADDED*" if a.get("_added") else ""
            lines.append(f"  {a['trustee_sid']} -> {right}{mark}")
        if len(aces) > limit:
            lines.append(f"  … ({len(aces) - limit} more ACE(s) not shown)")
        return "\n".join(lines)

    # ----- delta (existing vs added) ----------------------------------------
    def _decode_delta(self, before_sddl: str, after_sddl: str) -> ToolResult:
        before = self._aces(before_sddl)
        after = self._aces(after_sddl)
        before_keys = {self._ace_key(a) for a in before}
        added = [a for a in after if self._ace_key(a) not in before_keys]
        for a in added:
            a["_added"] = True
        removed = [a for a in before if self._ace_key(a) not in {self._ace_key(x) for x in after}]

        added_repl, added_takeover = self._classify(added)
        existing_repl, _ = self._classify(before)

        # DELTA-FIRST summary: what was ADDED is the abuse; the pre-existing rights are
        # the legitimate baseline. Flagging only the ADDED replication/takeover rights
        # is the false-positive guard — a DC object legitimately holds replication
        # rights, so only a NEWLY-added one is the DCSync grant.
        if added_repl:
            head = f"PRIVILEGE ADDED (the change): AD replication rights granted to {self._grant_phrase(added_repl)}"
        elif added_takeover:
            head = f"PRIVILEGE ADDED (the change): object-takeover rights granted to {self._grant_phrase(added_takeover)}"
        elif added:
            head = f"PRIVILEGE ADDED (the change): {len(added)} new ACE(s) -> {self._grant_phrase(added)}"
        else:
            head = "NO PRIVILEGE ADDED: the descriptor changed but no new grant was introduced"
        baseline = (f"Existing baseline: {len(before)} ACE(s)"
                    + (f", {len(existing_repl)} pre-existing (legitimate) replication holder(s)" if existing_repl else "")
                    + f". After: {len(after)} ACE(s).")
        summary = (
            f"{head}. {baseline}"
            + f"\n{_FULL_ACL_MARKER}\n"
            + f"Added ({len(added)}):\n{self._full_acl_block(added) or '  (none)'}"
            + (f"\nRemoved ({len(removed)}):\n{self._full_acl_block(removed)}" if removed else "")
            + f"\nFull ACL after ({len(after)} ACEs):\n{self._full_acl_block(after)}"
        )
        return ToolResult(
            ok=True,
            summary=summary,
            data={
                "mode": "delta",
                "added_privileges": added,
                "removed_privileges": removed,
                "existing_privileges": before,
                "added_replication": added_repl,
                "added_takeover": added_takeover,
                "full_acl_after": after[:60],
            },
        )

    def _decode_single(self, sddl: str) -> ToolResult:
        """No before/after available — decode the one descriptor (legacy behaviour)."""
        aces = self._aces(sddl)
        repl, takeover = self._classify(aces)
        parts = [f"Parsed {len(aces)} ACE(s)."]
        if repl:
            parts.append(f"{len(repl)} grant AD replication rights to: {self._grant_phrase(repl)}. "
                         "NOTE: no before/after available, so cannot tell newly-added from pre-existing.")
        if takeover:
            parts.append(f"{len(takeover)} grant object-takeover rights (Write-DACL/Owner/Generic-All).")
        if not repl and not takeover:
            parts.append("No replication or object-takeover grants found.")
        summary = (" ".join(parts)
                   + f"\n{_FULL_ACL_MARKER}\nFull ACL ({len(aces)} ACEs):\n{self._full_acl_block(aces)}")
        return ToolResult(
            ok=True,
            summary=summary,
            data={"mode": "single", "ace_count": len(aces),
                  "replication_grants": repl, "takeover_grants": takeover, "all_aces": aces[:60]},
        )

    @staticmethod
    def _section(sddl: str, tag: str) -> str | None:
        """Extract the owner (O:) / group (G:) SID, which precede the DACL."""
        idx = sddl.find(tag)
        if idx < 0:
            return None
        rest = sddl[idx + len(tag):]
        # The value runs until the next section tag.
        stop = min((p for p in (rest.find("G:"), rest.find("D:"), rest.find("S:")) if p >= 0), default=len(rest))
        val = rest[:stop].strip()
        return _name_trustee(val) if val else None

    @staticmethod
    def _dacl_region(sddl: str) -> str:
        """The DACL substring (D:...) up to the SACL (S:), where the ACEs live."""
        idx = sddl.find("D:")
        if idx < 0:
            return sddl  # no explicit DACL tag — scan the whole string for ACEs
        rest = sddl[idx + 2:]
        # A SACL, if present, starts at the first "S:" that is NOT inside an ACE.
        sacl = rest.find("S:")
        return rest[:sacl] if sacl >= 0 else rest
