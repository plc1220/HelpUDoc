"""`_prepare_payload` must include the turn being sent.

A caller that carries its own history gets a fresh thread per run and has no checkpoint
to continue from, so this payload is the entire conversation the model sees. Dropping the
current turn left it answering the last question in the history -- the same reply, every
time, however the user answered.
"""
from helpudoc_agent.api.routes.chat import _prepare_payload


class _Msg:
    def __init__(self, message="", history=None, messageContent=None):
        self.message = message
        self.history = history
        self.messageContent = messageContent


def test_first_turn_is_the_message():
    assert _prepare_payload(_Msg(message="hello")) == [{"role": "user", "content": "hello"}]


def test_history_keeps_the_current_turn():
    history = [
        {"role": "user", "content": "build a weather skill"},
        {"role": "assistant", "content": "which API should it call?"},
    ]
    payload = _prepare_payload(_Msg(message="mock implementation", history=list(history)))
    assert payload[:2] == history, "prior turns must survive"
    assert payload[-1] == {"role": "user", "content": "mock implementation"}, (
        "the turn being sent must reach the model, or it answers the previous question again"
    )


def test_a_caller_that_already_included_the_turn_does_not_duplicate_it():
    history = [
        {"role": "assistant", "content": "which API should it call?"},
        {"role": "user", "content": "mock implementation"},
    ]
    payload = _prepare_payload(_Msg(message="mock implementation", history=list(history)))
    assert payload == history


def test_blank_message_adds_nothing():
    history = [{"role": "user", "content": "build a weather skill"}]
    assert _prepare_payload(_Msg(message="   ", history=list(history))) == history


def test_message_content_still_replaces_the_last_user_turn():
    """Workspace chat sends structured blocks; that path must be untouched."""
    history = [
        {"role": "user", "content": "placeholder"},
        {"role": "assistant", "content": "ok"},
    ]
    blocks = [{"type": "text", "text": "with an attachment"}]
    payload = _prepare_payload(
        _Msg(message="ignored", history=list(history), messageContent=blocks)
    )
    assert payload[0]["content"] == blocks, "blocks replace the last user turn"
    assert len(payload) == 2, "no extra turn is appended when blocks are present"
