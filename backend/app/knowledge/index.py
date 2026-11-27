"""Dependency-free BM25F retrieval over the bundled Help Center corpus (SPEC §5.4).

Product questions use their own small lexical index rather than the RAG store: the
corpus is a few hundred trusted, version-matched sections, retrieval must work at $0
with no embedding key and in Demo Mode, and mixing product pages into the RAG store
would dilute investigator retrieval and change its pinned trust contract.

Scoring is Okapi BM25 over one bag of words per chunk in which each field is repeated
by its weight (BM25F's simple form): heading x3, page title x2, nav breadcrumb x1,
page description x1, body x1. Tokenisation is the RAG tokenizer
(``tools.rag._tokenize``: lower-case ``[a-z0-9][a-z0-9._-]*`` runs of 2+ characters; a
test pins that the two agree) plus sub-tokens split on ``- _ .`` so ``NEEDS_HUMAN``
matches "needs human" and ``auto-close`` matches "auto close", minus a small stop-word
list. Queries are expanded through the curated ``aliases.json`` at half weight. The
operate tier (install, deploy, upgrade) carries a 0.85 prior so "how do I…" favours the
user guides, at most two chunks per page are returned, and a calibrated floor makes the
index abstain instead of returning a weak match.

Pure and deterministic: no I/O, no clock, no randomness. Built once per process from
the integrity-checked corpus (``knowledge.corpus``).
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

# The RAG tokenizer's pattern (tools/rag.py ``_TOKEN_RE``), restated so this module
# stays importable without the RAG service; ``test_app_knowledge`` pins the equality.
_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9._-]*")
_SUBTOKEN_SPLIT_RE = re.compile(r"[-_.]")
STOP_WORDS = frozenset(
    "a an the is are was were be been to of in on for and or how do i we you my what "
    "where which when why does can it this that with from by as at into your our me "
    "there should could would will".split()
)

K1 = 1.4
B = 0.7
FIELD_WEIGHTS = {"heading": 3, "title": 2, "nav": 1, "description": 1, "text": 1}
TIER_PRIOR = {"guide": 1.0, "operate": 0.85}
ALIAS_WEIGHT = 0.5
MAX_PER_PAGE = 2
# A best score below this means the Help Center does not cover the question at all
# (off-topic probes such as "weather in Paris" or "what is T1110" score 0; every golden
# question scores above 5). It is deliberately low: when the model calls ``app_help`` it
# has already judged the question to be about the product. Routing a message to app
# help WITHOUT a model also requires a product cue and no data signal
# (``knowledge.answer.classify_intent``), because data questions ("how many cases did
# the agent auto-close today?") reach scores of 8-17 on product prose.
ABSTAIN_FLOOR = 3.0


def base_tokenize(text: str) -> list[str]:
    """Exactly ``tools.rag._tokenize``."""
    return [t for t in _TOKEN_RE.findall((text or "").lower()) if len(t) >= 2]


def fold(token: str) -> str:
    """A light plural fold applied to index and query alike ("models" ↔ "model",
    "notifications" ↔ "notification"). Deliberately crude: both sides fold the same
    way, so only recall changes, and ``-ss`` words ("access") are left alone."""
    if len(token) > 3 and token.endswith("s") and not token.endswith("ss") and token[-2].isalpha():
        return token[:-1]
    return token


def content_terms(text: str) -> list[str]:
    """The whole (not sub-) tokens of ``text`` that :func:`tokenize` keeps, folded:
    the words a reader would say the question is about."""
    out: list[str] = []
    for token in base_tokenize(text):
        token = token.strip("._-")
        if len(token) >= 2 and token not in STOP_WORDS:
            out.append(fold(token))
    return out


def tokenize(text: str) -> list[str]:
    """Index/query tokens: RAG tokens (edge punctuation trimmed, plural-folded), stop
    words removed, plus the alphabetic ``- _ .`` sub-tokens of compound tokens (a
    version or an IP address keeps its whole token but adds no bare-number parts)."""
    out: list[str] = []
    for token in base_tokenize(text):
        token = token.strip("._-")
        if len(token) < 2 or token in STOP_WORDS:
            continue
        out.append(fold(token))
        if _SUBTOKEN_SPLIT_RE.search(token):
            out.extend(
                fold(part) for part in _SUBTOKEN_SPLIT_RE.split(token)
                if len(part) >= 2 and part not in STOP_WORDS and not part.isdigit()
            )
    return out


@dataclass(frozen=True)
class IndexedDoc:
    """The searchable view of one chunk (fields already neutralised by the loader)."""

    key: str
    group: str            # diversity key (the page)
    tier: str
    heading: str
    title: str
    nav: str
    description: str
    text: str


@dataclass(frozen=True)
class Hit:
    key: str
    score: float


class BM25FIndex:
    """An immutable BM25F index; ``search`` is O(query terms x postings)."""

    def __init__(self, docs: Sequence[IndexedDoc], aliases: Mapping[str, Sequence[str]] | None = None) -> None:
        self._docs = tuple(docs)
        # Alias keys are looked up by QUERY terms, which are plural-folded, so the keys
        # are folded the same way ("teams" must reach the "team" query term); keys that
        # fold together merge their expansions in file order.
        merged: dict[str, list[str]] = {}
        for key, values in (aliases or {}).items():
            bucket = merged.setdefault(fold(key.lower().strip("._-")), [])
            bucket.extend(v for v in values if v not in bucket)
        self._aliases = {k: tuple(v) for k, v in merged.items()}
        bags: list[Counter[str]] = []
        for doc in self._docs:
            bag: Counter[str] = Counter()
            for name, weight in FIELD_WEIGHTS.items():
                for token in tokenize(getattr(doc, name)):
                    bag[token] += weight
            bags.append(bag)
        self._lengths = [sum(bag.values()) for bag in bags]
        self._avg = (sum(self._lengths) / len(self._lengths)) if self._lengths else 1.0
        df: Counter[str] = Counter()
        postings: dict[str, list[tuple[int, int]]] = {}
        for position, bag in enumerate(bags):
            df.update(bag.keys())
            for term, freq in bag.items():
                postings.setdefault(term, []).append((position, freq))
        self._n = len(bags)
        self._idf = {
            term: math.log(1 + (self._n - count + 0.5) / (count + 0.5)) for term, count in df.items()
        }
        self._postings = postings

    def __len__(self) -> int:
        return self._n

    @property
    def vocabulary_size(self) -> int:
        return len(self._idf)

    def knows(self, term: str) -> bool:
        """Whether the (folded) term occurs anywhere in the corpus."""
        return term in self._idf

    def unknown_terms(self, query: str) -> list[str]:
        """The query's :func:`content_terms` that occur nowhere in the corpus: a name,
        an account or a hostname the Help Center has never written down."""
        return [term for term in dict.fromkeys(content_terms(query)) if term not in self._idf]

    def alias_keys(self) -> frozenset[str]:
        return frozenset(self._aliases)

    def query_weights(self, query: str) -> dict[str, float]:
        """Query terms (weight 1.0) plus their alias expansions (weight 0.5)."""
        terms = tokenize(query)
        weights: dict[str, float] = {term: 1.0 for term in terms}
        for term in terms:
            for alias in self._aliases.get(term, ()):
                for token in tokenize(alias):
                    weights.setdefault(token, ALIAS_WEIGHT)
        return weights

    def scores(self, query: str) -> dict[int, float]:
        totals: dict[int, float] = {}
        for term, weight in self.query_weights(query).items():
            idf = self._idf.get(term)
            if idf is None:
                continue
            for position, freq in self._postings[term]:
                norm = K1 * (1 - B + B * self._lengths[position] / self._avg)
                totals[position] = totals.get(position, 0.0) + weight * idf * freq * (K1 + 1) / (freq + norm)
        for position in list(totals):
            totals[position] *= TIER_PRIOR.get(self._docs[position].tier, 1.0)
        return totals

    def search(self, query: str, k: int = 4, *, floor: float = ABSTAIN_FLOOR) -> list[Hit]:
        """The top ``k`` hits (at most :data:`MAX_PER_PAGE` per page), best first; ``[]``
        when the best score is below ``floor``. Ties break on corpus order, so the
        result is deterministic."""
        ranked = sorted(self.scores(query).items(), key=lambda item: (-item[1], item[0]))
        if not ranked or ranked[0][1] < floor:
            return []
        per_group: Counter[str] = Counter()
        out: list[Hit] = []
        for position, score in ranked:
            doc = self._docs[position]
            if per_group[doc.group] >= MAX_PER_PAGE:
                continue
            per_group[doc.group] += 1
            out.append(Hit(doc.key, round(score, 6)))
            if len(out) >= k:
                break
        return out

    def best_score(self, query: str) -> float:
        totals = self.scores(query)
        return max(totals.values()) if totals else 0.0


def build_index(docs: Iterable[IndexedDoc], aliases: Mapping[str, Sequence[str]] | None = None) -> BM25FIndex:
    return BM25FIndex(list(docs), aliases)
