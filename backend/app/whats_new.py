"""What's new: the newest release-notes update id this backend build ships (Round 16 D7).

The Console shows a short What's new welcome once per newest release-notes update. The
per-person marker is ``UserPrefs.misc.whats_new_seen`` (``models.WHATS_NEW_SEEN_PREF_KEY``),
written by the Console through ``PUT /api/prefs/user``, which audits it.

An account created after an update must not be welcomed to changes that predate it, so
every path that creates an account (``POST /api/users``, the create branch of single
sign-on provisioning and ``POST /api/setup/account``) stamps the marker with the newest
update id bundled with this build, through :func:`stamp_new_account`. The id comes from
``whats_new_latest.json``, which ``scripts/build_release_notes.py`` writes from
``docs/releases/notes/`` and checks with ``--check``; the wheel and the image ship it.

Everything here fails open: a missing or malformed file reads as "no id", and a failed
stamp is logged and never fails the account create (the ``user.created`` audit row
already records the create, so the stamp writes no row of its own). The marker lives in
the real personal preferences, never a Demo store. With sign-in off every caller shares
the ``default`` bucket, so the welcome is once per installation.

No model call, no new store: one key in the existing ``user_prefs`` KV document (#6, #12).
"""

from __future__ import annotations

import functools
import json
import logging
import re
from pathlib import Path
from typing import Any

from .models import DISMISSED_INTRO_ID_PATTERN, WHATS_NEW_SEEN_PREF_KEY

logger = logging.getLogger(__name__)

#: The generated file, beside this module in ``backend/app``.
LATEST_FILE = Path(__file__).resolve().with_name("whats_new_latest.json")
_UPDATE_ID_RE = re.compile(DISMISSED_INTRO_ID_PATTERN)


@functools.lru_cache(maxsize=1)
def latest_update_id() -> str | None:
    """The newest release-notes update id this build ships, or ``None`` when the file is
    missing, unreadable or holds an id outside the dismissed-intro grammar (fail open)."""
    try:
        data: Any = json.loads(LATEST_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning("whats_new: cannot read %s (%s)", LATEST_FILE.name, type(exc).__name__)
        return None
    value = data.get("latest_update_id") if isinstance(data, dict) else None
    if isinstance(value, str) and _UPDATE_ID_RE.fullmatch(value):
        return value
    logger.warning("whats_new: %s holds no valid update id", LATEST_FILE.name)
    return None


async def stamp_new_account(state: Any, username: str | None) -> None:
    """Mark the newest update as seen for a just-created account (best effort).

    Never raises: the account already exists and its creation is already audited, so a
    preferences failure only means the person sees one welcome they did not need."""
    latest = latest_update_id()
    if not latest or not username:
        return
    try:
        await state.user_prefs.patch(username, misc={WHATS_NEW_SEEN_PREF_KEY: latest})
    except Exception as exc:  # noqa: BLE001 (best effort; the create stands)
        logger.warning("whats_new: could not stamp a new account (%s)", type(exc).__name__)
