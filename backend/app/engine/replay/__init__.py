"""Replay harness: frozen fixtures, an isolated replay stack, and paired scoring.

The harness compares replay CONFIGURATIONS run now, against one pinned corpus
snapshot and one frozen fixture set. It cannot answer a retrospective question about
an already-shipped change and does not try to — see
:data:`app.engine.replay.text.REPLAY_LIMITATIONS`, which is the authoritative
statement and is embedded verbatim in every machine-readable output.
"""

from __future__ import annotations

from .text import FIDELITY_NOTES, REPLAY_LIMITATIONS

__all__ = ["FIDELITY_NOTES", "REPLAY_LIMITATIONS"]
