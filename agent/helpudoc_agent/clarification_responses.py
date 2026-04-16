"""Helpers for normalizing clarification resume payloads."""
from __future__ import annotations

import json
from typing import Any, Dict, List


def _normalize_answer_value(value: Any) -> str | List[str] | None:
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    if isinstance(value, list):
        normalized_items = [str(item).strip() for item in value if str(item).strip()]
        return normalized_items or None
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _extract_structured_answers_from_message(
    message: str,
    questions: List[Dict[str, Any]],
) -> Dict[str, str | List[str]]:
    answers: Dict[str, str | List[str]] = {}
    lines = [line.strip() for line in str(message or "").splitlines() if line.strip()]
    if not lines:
        return answers

    for question in questions:
        question_id = str(question.get("id") or "").strip()
        header = str(question.get("header") or "").strip()
        prefixes = [
            f"{question_id.lower()}:"
            for question_id in [question_id]
            if question_id
        ] + [
            f"{header.lower()}:"
            for header in [header]
            if header
        ]
        if not prefixes:
            continue
        for line in lines:
            lowered = line.lower()
            prefix = next((candidate for candidate in prefixes if lowered.startswith(candidate)), None)
            if prefix is None:
                continue
            value = line[len(prefix):].strip()
            if value:
                answers[question_id or header.lower().replace(" ", "-")] = value
            break
    return answers


def _build_selected_values(
    selected_choice_ids: List[str],
    selected_values: List[str],
    choices: List[Dict[str, Any]],
) -> List[str]:
    values = [value for value in selected_values if isinstance(value, str) and value.strip()]
    if values:
        return values
    choice_map = {
        str(choice.get("id") or "").strip(): str(choice.get("value") or choice.get("label") or "").strip()
        for choice in choices
        if isinstance(choice, dict)
    }
    return [choice_map[choice_id] for choice_id in selected_choice_ids if choice_map.get(choice_id)]


def _build_question_answers(
    questions: List[Dict[str, Any]],
    answers_by_question_id: Dict[str, str | List[str]],
) -> List[Dict[str, Any]]:
    question_answers: List[Dict[str, Any]] = []
    for question in questions:
        question_id = str(question.get("id") or "").strip()
        if not question_id or question_id not in answers_by_question_id:
            continue
        question_answers.append(
            {
                "id": question_id,
                "header": str(question.get("header") or "").strip(),
                "question": str(question.get("question") or "").strip(),
                "answer": answers_by_question_id[question_id],
            }
        )
    return question_answers


def _build_summary_lines(
    question_answers: List[Dict[str, Any]],
    message: str,
    selected_values: List[str],
) -> List[str]:
    summary_lines: List[str] = []
    for item in question_answers:
        header = str(item.get("header") or item.get("id") or "Answer").strip()
        answer = item.get("answer")
        if isinstance(answer, list):
            rendered = ", ".join(str(value).strip() for value in answer if str(value).strip())
        else:
            rendered = str(answer or "").strip()
        if rendered:
            summary_lines.append(f"{header}: {rendered}")

    if selected_values and not question_answers:
        summary_lines.append(f"Selected: {', '.join(selected_values)}")

    normalized_message = str(message or "").strip()
    normalized_summary = "\n".join(summary_lines).strip()
    if normalized_message and normalized_message != normalized_summary:
        summary_lines.append(f"Notes: {normalized_message}")
    return summary_lines


def normalize_clarification_resume_payload(
    response: Any,
    *,
    questions: List[Dict[str, Any]] | None = None,
    choices: List[Dict[str, Any]] | None = None,
) -> str:
    """Return a deterministic JSON payload for clarification responses."""
    if not isinstance(response, dict):
        return str(response)

    resolved_questions = [question for question in (questions or []) if isinstance(question, dict)]
    resolved_choices = [choice for choice in (choices or []) if isinstance(choice, dict)]
    raw_message = str(response.get("message") or "").strip()
    selected_choice_ids = [
        str(item).strip()
        for item in response.get("selectedChoiceIds", [])
        if str(item).strip()
    ]
    selected_values = _build_selected_values(
        selected_choice_ids,
        [
            str(item).strip()
            for item in response.get("selectedValues", [])
            if str(item).strip()
        ],
        resolved_choices,
    )

    answers_by_question_id: Dict[str, str | List[str]] = {}
    raw_answers = response.get("answersByQuestionId")
    if isinstance(raw_answers, dict):
        for key, value in raw_answers.items():
            normalized_value = _normalize_answer_value(value)
            normalized_key = str(key or "").strip()
            if normalized_key and normalized_value is not None:
                answers_by_question_id[normalized_key] = normalized_value

    if resolved_questions and not answers_by_question_id and raw_message:
        answers_by_question_id.update(_extract_structured_answers_from_message(raw_message, resolved_questions))

    question_answers = _build_question_answers(resolved_questions, answers_by_question_id)
    summary_lines = _build_summary_lines(question_answers, raw_message, selected_values)
    normalized_payload: Dict[str, Any] = {
        "message": raw_message or None,
        "selectedChoiceIds": selected_choice_ids,
        "selectedValues": selected_values,
        "answersByQuestionId": answers_by_question_id,
        "questionAnswers": question_answers,
        "summary": "\n".join(summary_lines).strip() or None,
    }
    return json.dumps(normalized_payload, ensure_ascii=False)
