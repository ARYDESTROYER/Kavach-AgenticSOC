"""``POST /api/chat/entity-question`` — the Ask AI entity question (Round 12 WP-ASK).

An "Ask AI" chip on an IP, host, user, file hash, domain, URL, e-mail address,
detection rule or case id hands the chat page a typed reference ``{kind, value}``
(never free text). The page resolves it HERE to the server-worded question and sends
that question in a new Workspace chat with ``origin: "starter"`` — the topic pattern of
``GET /api/chat/topics/{topic_id}`` (SPEC A7). Because the origin is not ``user``, the
value never counts as analyst-authored for the indicator taint rule (§4.8, #9), and the
engine never puts the question text in a prompt: it sends the question about "the
<kind> in the reference below" with the value in its own UNTRUSTED fence, live and on
every replay (``agents.chat_entity.render_entity_turn``).

Read-only and stateless: it writes nothing, calls no model and reads no store, so it
needs no audit row. It requires the chat grant (``cases:read``) like every chat route.
A value without a question (wrong shape for its kind, invisible characters, too long)
is a 422, never an altered question. POST keeps log-derived values (user names, e-mail
addresses) out of URLs and access logs.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..agents.chat_entity import ChatEntityQuestion, ChatEntityRef, entity_question, entity_value
from .deps import require_permission

router = APIRouter(prefix="/api")

#: The 422 detail when a value has no question (plain, shown as-is by the client).
NO_ENTITY_QUESTION = "There is no question to ask about that value."


@router.post("/chat/entity-question", response_model=ChatEntityQuestion)
async def chat_entity_question(
    body: ChatEntityRef,
    _=Depends(require_permission("cases", "read")),
) -> ChatEntityQuestion:
    """The server's question about one entity value, for the chat page to send with
    ``origin: "starter"``. 422 when the value does not have its kind's shape."""
    value = entity_value(body.kind, body.value)
    if value is None:
        raise HTTPException(status_code=422, detail=NO_ENTITY_QUESTION)
    return ChatEntityQuestion(kind=body.kind, value=value, question=entity_question(body.kind, value))


__all__ = ["NO_ENTITY_QUESTION", "router"]
