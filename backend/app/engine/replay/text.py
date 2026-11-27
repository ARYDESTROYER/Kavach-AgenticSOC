"""The one authoritative statement of what the replay harness can and cannot answer.

Defined once so the shipped payload, the artifact and the documentation cannot drift
apart. Every machine-readable location embeds this exact string.
"""

from __future__ import annotations

REPLAY_LIMITATIONS = (
    "What this harness can and cannot answer.\n"
    "\n"
    "This harness compares replay configurations that are run now, against one pinned "
    "corpus snapshot and one frozen fixture set. It cannot answer a retrospective "
    "question about a change that has already shipped, and it does not try to.\n"
    "\n"
    "Rebuilding a past investigation is not possible in this system. The only two paths "
    "from a stored case back to its alert content either re-query the live log surface — "
    "whose contents roll with retention and whose relative time windows resolve against "
    "the present — or synthesise placeholder events with the record content stripped. No "
    "snapshot of the knowledge corpus as it stood before an earlier change exists either. "
    "A comparison between a replay run now and outcomes logged earlier would therefore "
    "mix at least two changed variables and would be uninterpretable. That comparison is "
    "refused by this API rather than discouraged in prose: there is no parameter through "
    "which it can be expressed.\n"
    "\n"
    "Fixture capture runs forward. What is captured from now on is what the next change "
    "can be measured against.\n"
    "\n"
    "An insufficient-evidence result stays insufficient evidence. It is never converted "
    "into a score, a percentage, a rate, or a recommendation. A difference that does not "
    "clearly exceed this run's own measured self-consistency floor is reported as "
    "indistinguishable from noise, and that judgement appears as a machine-readable "
    "field, not only as prose."
)

# Fidelity differences between a replay cell and the production run it reproduces.
# Reported verbatim in ``report.json`` so a reader never has to infer them.
FIDELITY_NOTES = [
    "Every replayed case is a first investigation against an empty case store; the "
    "no-material-change short-circuit and every attach path never execute.",
    "Enrichment is served from a frozen cache, so a tool observation is reported as "
    "cached.",
    "The platform threshold-tuning audit snapshot is absent in replay; it is an audit "
    "annotation and never a prompt input.",
    "Query time windows are anchored to each fixture's capture instant, so a relative "
    "window resolves identically in every cell.",
]
