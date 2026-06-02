"""Detect when a skill run asked for user input in prose without a formal interrupt."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Pattern

KNOWN_INTERACTIVE_SKILLS = frozenset({"frontend-slides"})

_STRONG_GATE_PATTERNS: tuple[Pattern[str], ...] = (
    re.compile(r"\bconfirm\b.{0,60}\boutline\b", re.IGNORECASE),
    re.compile(r"\boutline\b.{0,60}\bconfirm\b", re.IGNORECASE),
    re.compile(r"\b(?:please\s+)?confirm\b.{0,40}\b(?:form|UI)\b", re.IGNORECASE),
    re.compile(r"\b(?:select|choose)\b.{0,60}\b(?:form|options?|UI|selector|chooser|previews?|styles?)\b", re.IGNORECASE),
    re.compile(r"\b(?:once|after)\s+(?:confirmed|you\s+confirm)", re.IGNORECASE),
    re.compile(
        r"\b(?:once|after)\s+(?:submitted|you\s+submit)\b.{0,260}\b(?:outline|style\s+discovery|visual\s+aesthetic|proposal|review|generate|move)\b",
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r"\bto\s+ensure\b.{0,260}\b(?:deck|slides?|presentation)\b.{0,260}\b(?:expectations|ideal\s+length|length|structure|technical\s+features|audience|visual\s+style)\b",
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r"\b(?:custom\s+html\s+slide\s+style\s+options?|html\s+style\s+previews?|visual\s+theme\s+selection)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:style|theme)\s*[a-c]\s*:", re.IGNORECASE),
    re.compile(r"\boption\s*[1-3]\s*:", re.IGNORECASE),
    re.compile(r"\bnext\s+steps\b.{0,120}\b(?:sidebar|form)", re.IGNORECASE),
)

_SELECTION_PROMPT_PATTERNS: tuple[Pattern[str], ...] = (
    re.compile(r"\b(?:please\s+)?select\b", re.IGNORECASE),
    re.compile(r"\b(?:please\s+)?choose\b", re.IGNORECASE),
    re.compile(r"\bwhich\s+(?:one|option|style|mood|vibe)", re.IGNORECASE),
    re.compile(r"\bwhat\s+(?:style|mood|vibe)", re.IGNORECASE),
    re.compile(r"\bready to (?:proceed|continue|move)", re.IGNORECASE),
    re.compile(r"\bshall I\b", re.IGNORECASE),
)

_WEAK_COURTESY_PATTERNS: tuple[Pattern[str], ...] = (
    re.compile(r"\bwould you like\b", re.IGNORECASE),
    re.compile(r"\bany refinements?\b", re.IGNORECASE),
    re.compile(r"\blet me know if\b", re.IGNORECASE),
    re.compile(r"\banything else\b", re.IGNORECASE),
    re.compile(r"\bneed any changes\b", re.IGNORECASE),
)

_UI_FORM_MISREF_PATTERNS: tuple[Pattern[str], ...] = (
    re.compile(r"\b(?:from|in|using|via)\s+the\s+(?:form|options?|UI)\s+(?:above|below)", re.IGNORECASE),
    re.compile(r"\b(?:fill\s+out|complete|submit)\s+the\s+(?:form|questions?)\s+(?:above|below)", re.IGNORECASE),
    re.compile(r"\b(?:fill\s+out|complete|submit)\s+the\s+[\w\s&-]{1,120}?\s+(?:form|questions?)\s+(?:above|below)", re.IGNORECASE),
    re.compile(r"\b(?:prepared|created|generated|provided)\s+(?:a\s+)?(?:context\s+)?form\s+(?:above|below)", re.IGNORECASE),
    re.compile(r"\bfill\s+(?:this|it)\s+out\b.{0,180}\b(?:submit|proceed|continue|outline|review)\b", re.IGNORECASE | re.DOTALL),
    re.compile(r"\b(?:forms?|options?|choices?|selectors?|choosers?)\s+in\s+the\s+sidebar", re.IGNORECASE),
    re.compile(
        r"\buse\s+the\s+(?:forms?|options?|choices?|selectors?|choosers?)\s+(?:in\s+the\s+sidebar|below|above)",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:interactive|thumbnail)\s+(?:selector|chooser|window)\s+(?:above|below)?", re.IGNORECASE),
    re.compile(r"\b(?:select|choose|pick|review).{0,120}\b(?:selector|chooser|preview|style).{0,80}\b(?:above|below|window)\b", re.IGNORECASE),
    re.compile(r"\bselect.*(?:above|below)", re.IGNORECASE),
    re.compile(r"\bpick.*(?:above|below)", re.IGNORECASE),
    re.compile(r"\bconfirm.*(?:form|UI)\s+above", re.IGNORECASE),
)

_ENUM_BULLETS = re.compile(r"(?:^|\n)\s*[-•*]\s+.+(?:\n\s*[-•*]\s+.+){2,}", re.MULTILINE)
_ENUM_NUMBERED = re.compile(r"(?:^|\n)\s*\d+\.\s+.+(?:\n\s*\d+\.\s+.+){1,}", re.MULTILINE)
_TRAILING_QUESTION = re.compile(r"[^.!?\n]*\?\s*$")
_SIDEBAR_PROMPT = re.compile(r"Please use the\s+.+?(?:\n\s*\d+\.\s+.+)+", re.IGNORECASE | re.DOTALL)

_STRONG_SIGNALS = frozenset({"phantom_ui_reference", "strong_gate", "enumerated_choices"})


@dataclass(frozen=True)
class ImplicitInputDetection:
    awaiting: bool
    prompt: str | None = None


def _collect_signals(last_paragraphs: str) -> set[str]:
    signals: set[str] = set()

    if _TRAILING_QUESTION.search(last_paragraphs):
        signals.add("ends_with_question")

    if any(pattern.search(last_paragraphs) for pattern in _STRONG_GATE_PATTERNS):
        signals.add("strong_gate")

    if any(pattern.search(last_paragraphs) for pattern in _SELECTION_PROMPT_PATTERNS):
        signals.add("selection_prompt")

    if any(pattern.search(last_paragraphs) for pattern in _WEAK_COURTESY_PATTERNS):
        signals.add("weak_courtesy")

    if any(pattern.search(last_paragraphs) for pattern in _UI_FORM_MISREF_PATTERNS):
        signals.add("phantom_ui_reference")

    if _ENUM_BULLETS.search(last_paragraphs) or _ENUM_NUMBERED.search(last_paragraphs):
        signals.add("enumerated_choices")

    if re.search(
        r"\b(?:propose|generate)\s+a?\s*(?:proposed\s+)?slide\s+outline\b",
        last_paragraphs,
        re.IGNORECASE,
    ) and re.search(
        r"\b(?:move|proceed|continue)\s+to\s+(?:style\s+discovery|visual\s+(?:direction|aesthetic)|style\s+selection)\b",
        last_paragraphs,
        re.IGNORECASE,
    ):
        signals.add("enumerated_choices")

    return signals


def _should_await_input(signals: set[str]) -> bool:
    """Conservative guard: avoid blocking completion on post-deck courtesy questions."""
    if not signals:
        return False

    if signals <= {"weak_courtesy", "ends_with_question"}:
        return False

    if "phantom_ui_reference" in signals or "strong_gate" in signals:
        return True

    if "enumerated_choices" in signals and signals & (
        {"phantom_ui_reference", "strong_gate", "selection_prompt"}
    ):
        return True

    if len(signals & _STRONG_SIGNALS) >= 2:
        return True

    if "phantom_ui_reference" in signals and (
        "selection_prompt" in signals or "enumerated_choices" in signals
    ):
        return True

    return False


def detect_implicit_input_awaiting(
    *,
    skill_id: str | None,
    assistant_text: str,
) -> ImplicitInputDetection:
    """Return whether assistant prose appears to await user input without a tool interrupt."""
    if not skill_id or not str(skill_id).strip():
        return ImplicitInputDetection(awaiting=False)

    text = (assistant_text or "").strip()
    if not text:
        return ImplicitInputDetection(awaiting=False)

    last_paragraphs = text[-1500:]
    signals = _collect_signals(last_paragraphs)

    if not _should_await_input(signals):
        return ImplicitInputDetection(awaiting=False)

    prompt_match = _TRAILING_QUESTION.search(last_paragraphs)
    sidebar_match = _SIDEBAR_PROMPT.search(last_paragraphs)
    prompt = (
        prompt_match.group(0).strip()
        if prompt_match
        else sidebar_match.group(0).strip()
        if sidebar_match
        else None
    )
    return ImplicitInputDetection(awaiting=True, prompt=prompt)
