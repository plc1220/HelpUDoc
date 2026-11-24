"""ARIA's settings for LangChain's SummarizationMiddleware (runtime/summarization.py).

Below the trigger nothing may change: those are the conversations UAT validated. Above
it, the user's latest message must survive, the summary must be built from the real
history, and one turn must not summarize twice.
"""
from typing import Any, List

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field

from helpudoc_agent.runtime.summarization import (
    ARIA_SUMMARY_PROMPT,
    SUMMARY_KEEP_TOKENS,
    SUMMARY_READ_TOKENS,
    AriaSummarizationMiddleware,
    build_summarization_middleware,
)

TRIGGER = 50000
# The approximate counter is about four characters per token.
TOKENS = 4


class RecordingChatModel(BaseChatModel):
    prompts: List[List[BaseMessage]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "recording-chat"

    def _get_ls_params(self, stop=None, **kwargs: Any):
        return {"ls_provider": "recording"}

    def _generate(self, messages, stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
        self.prompts.append(list(messages))
        return ChatResult(generations=[ChatGeneration(message=AIMessage("## Current request\nRecorded summary"))])


def _text(tokens: int, marker: str = "") -> str:
    return (marker + " " if marker else "") + "w " * (tokens * TOKENS // 2)


def _history(turns: int, tokens_per_message: int) -> List[BaseMessage]:
    messages: List[BaseMessage] = []
    for turn in range(turns):
        messages.append(HumanMessage(_text(tokens_per_message, f"USER-TURN-{turn}")))
        messages.append(AIMessage(_text(tokens_per_message, f"REPLY-{turn}")))
    return messages


def _middleware(model: RecordingChatModel) -> AriaSummarizationMiddleware:
    return build_summarization_middleware(model, TRIGGER)


def _run(middleware: AriaSummarizationMiddleware, messages: List[BaseMessage]):
    return middleware.before_model({"messages": messages}, runtime=None)


def _summary_prompt_text(model: RecordingChatModel) -> str:
    assert len(model.prompts) == 1, f"expected one summary call, got {len(model.prompts)}"
    return "\n".join(str(message.content) for message in model.prompts[0])


def test_below_trigger_nothing_changes():
    model = RecordingChatModel()

    result = _run(_middleware(model), _history(turns=10, tokens_per_message=2000))  # ~40k tokens

    assert result is None
    assert model.prompts == []


def test_latest_user_message_is_kept_when_the_current_turn_is_large():
    # The current turn's tool result alone exceeds the keep budget. With "keep the last
    # 6 messages" or a pure token budget, the user's question would be summarized away.
    model = RecordingChatModel()
    messages = _history(turns=6, tokens_per_message=3000)
    question = HumanMessage("Show how it looks using template 2a and 2b")
    messages += [
        question,
        AIMessage("", tool_calls=[{"id": "read-1", "name": "read_file", "args": {"path": "templates/2a.md"}}]),
        ToolMessage(_text(SUMMARY_KEEP_TOKENS + 10000), tool_call_id="read-1"),
    ]

    result = _run(_middleware(model), messages)

    new_messages = result["messages"][1:]  # [0] is RemoveMessage(REMOVE_ALL_MESSAGES)
    assert new_messages[0].additional_kwargs.get("lc_source") == "summarization"
    assert new_messages[1] is question
    assert [m.type for m in new_messages[1:]] == ["human", "ai", "tool"]


def test_summary_reads_the_older_history_not_only_the_last_4000_tokens():
    model = RecordingChatModel()

    _run(_middleware(model), _history(turns=12, tokens_per_message=3000))  # ~72k tokens

    prompt = _summary_prompt_text(model)
    assert "USER-TURN-0" in prompt
    assert "## Decisions and preferences" in prompt


def test_a_turn_does_not_summarize_twice():
    # The kept messages still report the pre-summary token usage. With "keep 6 messages"
    # that re-triggered on the next model call of the same turn.
    model = RecordingChatModel()
    messages = _history(turns=12, tokens_per_message=3000)
    messages[-1] = AIMessage(
        messages[-1].content,
        usage_metadata={"input_tokens": 90000, "output_tokens": 500, "total_tokens": 90500},
        response_metadata={"model_provider": "recording"},
    )
    messages.append(HumanMessage("Next question"))
    middleware = _middleware(model)

    first = _run(middleware, messages)
    second = _run(middleware, first["messages"][1:])

    assert first is not None
    assert second is None
    assert len(model.prompts) == 1


def test_a_previous_summary_is_not_treated_as_the_user_turn():
    model = RecordingChatModel()
    old_summary = HumanMessage(
        "Here is a summary of the conversation to date:\n\nearlier",
        additional_kwargs={"lc_source": "summarization"},
    )
    messages = [old_summary] + _history(turns=12, tokens_per_message=3000)
    messages.append(HumanMessage("LATEST-QUESTION"))

    result = _run(_middleware(model), messages)

    kept = result["messages"][1:]
    assert any(m.content == "LATEST-QUESTION" for m in kept)
    assert old_summary not in kept


def test_settings_and_node_name():
    middleware = _middleware(RecordingChatModel())

    # The chat stream filter matches the "SummarizationMiddleware..." graph node.
    assert middleware.name == "SummarizationMiddleware"
    assert middleware.trigger == ("tokens", TRIGGER)
    assert middleware.keep == ("tokens", SUMMARY_KEEP_TOKENS)
    assert middleware.trim_tokens_to_summarize == SUMMARY_READ_TOKENS
    # LangChain fills the prompt with str.format; {messages} must be the only field.
    assert ARIA_SUMMARY_PROMPT.format(messages="X").count("X") >= 1


def test_after_compaction_the_answer_call_still_has_the_early_detail_and_the_question():
    # End to end through create_agent (#121): force summarization with a low trigger, then
    # check what the answering model call receives.
    from langchain.agents import create_agent

    detail = "The approved budget is RM 42,000"

    class ScriptedModel(RecordingChatModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
            self.prompts.append(list(messages))
            text = "\n".join(str(m.content) for m in messages)
            if "You are compressing an ARIA conversation" in text:
                # A summary that carries the detail forward, as the prompt asks.
                reply = f"## Decisions and preferences\n{detail}."
            else:
                reply = "The budget is RM 42,000."
            return ChatResult(generations=[ChatGeneration(message=AIMessage(reply))])

    model = ScriptedModel()
    agent = create_agent(
        model=model,
        tools=[],
        middleware=[build_summarization_middleware(model, trigger_tokens=20000)],
    )
    history: List[BaseMessage] = [HumanMessage(f"Note this: {detail}."), AIMessage("Noted.")]
    history += _history(turns=15, tokens_per_message=3000)  # ~90k tokens: over the trigger and the keep budget
    question = HumanMessage("What budget did we agree on?")

    result = agent.invoke({"messages": history + [question]})

    summary_call, answer_call = model.prompts
    assert detail in "\n".join(str(m.content) for m in summary_call)
    answer_input = "\n".join(str(m.content) for m in answer_call)
    assert detail in answer_input  # via the stored summary
    assert answer_call[-1].content == question.content  # the question itself was kept
    assert result["messages"][-1].content == "The budget is RM 42,000."


def _pdf_base64(pages: int, padding: int) -> str:
    import base64
    import io

    from pypdf import PdfWriter

    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=100, height=100)
    writer.add_metadata({"/Padding": "x" * padding})
    buffer = io.BytesIO()
    writer.write(buffer)
    return base64.b64encode(buffer.getvalue()).decode()


def _attached_turn(data: str) -> HumanMessage:
    return HumanMessage(content=[
        {"type": "text", "text": "ASSESS-THIS"},
        {"type": "file", "base64": data, "mime_type": "application/pdf", "filename": "bundle.pdf"},
    ])


def test_an_attached_pdf_is_counted_by_page_not_by_base64():
    # Base64 counted as text exceeded the trigger on every step.
    model = RecordingChatModel()
    messages = [*_history(3, 1000), _attached_turn(_pdf_base64(11, 1_000_000))]
    middleware = _middleware(model)
    assert middleware.token_counter(messages) < TRIGGER
    assert _run(middleware, messages) is None
    assert model.prompts == []


def test_a_truly_large_attachment_still_triggers_a_summary_once():
    model = RecordingChatModel()
    middleware = _middleware(model)
    messages = [*_history(3, 1000), _attached_turn(_pdf_base64(200, 10))]
    update = _run(middleware, messages)
    assert update is not None and len(model.prompts) == 1
    kept = update["messages"][1:]
    assert any("ASSESS-THIS" in str(message.content)[:200] for message in kept)
    # Later steps of the same turn: nothing new to compress, so no second summary.
    for step in range(5):
        kept = [*kept, AIMessage(f"step {step}")]
        assert _run(middleware, kept) is None
    assert len(model.prompts) == 1


def test_text_only_counts_are_unchanged():
    from langchain_core.messages.utils import count_tokens_approximately

    messages = _history(4, 500)
    assert _middleware(RecordingChatModel()).token_counter(messages) == count_tokens_approximately(
        messages, use_usage_metadata_scaling=True
    )


def test_an_unreadable_attachment_never_fails_the_run():
    for data in ("A" * 300_001, "!!!" * 1000, "é" * 500, ""):
        assert _middleware(RecordingChatModel()).token_counter([_attached_turn(data)]) > 0


def test_the_page_count_cache_does_not_hold_files():
    from helpudoc_agent.runtime import summarization

    data = _pdf_base64(3, 10)
    _middleware(RecordingChatModel()).token_counter([_attached_turn(data)])
    assert summarization._PDF_TOKENS
    assert all(len(key) == 32 for key in summarization._PDF_TOKENS)
