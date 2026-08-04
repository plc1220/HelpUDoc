"""Structure-aware, token-bounded processing-window planning."""
from __future__ import annotations

import hashlib
import re
from statistics import median

from .models import ProcessingWindow, SourceBlock, StructureNode


def estimate_tokens(text: str) -> int:
    """Deterministic multilingual approximation used when no model counter exists."""
    cjk = len(re.findall(r"[\u3400-\u9fff\uf900-\ufaff]", text))
    remainder = re.sub(r"[\u3400-\u9fff\uf900-\ufaff]", "", text)
    return max(1, cjk + (len(remainder.encode("utf-8")) + 3) // 4)


def _window_hash(blocks: list[SourceBlock]) -> str:
    payload = "\n".join(block.contentHash for block in blocks)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _lexical_features(text: str) -> set[str]:
    lowered = text.lower()
    words = set(re.findall(r"[\w.-]{2,}", lowered))
    cjk_runs = re.findall(r"[\u3400-\u9fff\uf900-\ufaff]+", lowered)
    cjk = {run[index:index + 2] for run in cjk_runs for index in range(max(1, len(run) - 1))}
    return words | cjk


def semantic_change_points(blocks: list[SourceBlock]) -> set[int]:
    """Return ordinals after document-relative lexical-distance peaks."""
    if len(blocks) < 3:
        return set()
    distances: list[float] = []
    for left, right in zip(blocks, blocks[1:]):
        left_features = _lexical_features(left.text)
        right_features = _lexical_features(right.text)
        union = left_features | right_features
        similarity = len(left_features & right_features) / len(union) if union else 1.0
        distances.append(1.0 - similarity)
    center = median(distances)
    deviation = median(abs(value - center) for value in distances)
    threshold = center + 1.5 * deviation
    return {
        blocks[index + 1].ordinal
        for index, value in enumerate(distances)
        if value > threshold
    }


def plan_windows(
    blocks: list[SourceBlock],
    structure: list[StructureNode],
    *,
    target_tokens: int = 2500,
    soft_min_tokens: int = 600,
    hard_max_tokens: int = 4000,
    context_blocks: int = 2,
) -> list[ProcessingWindow]:
    if target_tokens <= 0 or hard_max_tokens < target_tokens:
        raise ValueError("Invalid processing-window token limits")
    replacements: dict[str, list[str]] = {}
    expanded_blocks: list[SourceBlock] = []
    for block in blocks:
        block_tokens = estimate_tokens(block.text)
        if block_tokens <= hard_max_tokens:
            expanded_blocks.append(block)
            continue
        parts: list[SourceBlock] = []
        offset = 0
        part_index = 1
        estimated_chars = max(1, int(len(block.text) * hard_max_tokens / block_tokens))
        while offset < len(block.text):
            end = min(len(block.text), offset + estimated_chars)
            while end > offset + 1 and estimate_tokens(block.text[offset:end]) > hard_max_tokens:
                end -= max(1, (end - offset) // 10)
            text = block.text[offset:end]
            digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
            parts.append(block.model_copy(update={
                "id": f"{block.id}-part{part_index}",
                "text": text,
                "contentHash": f"sha256:{digest}",
            }))
            offset = end
            part_index += 1
        replacements[block.id] = [part.id for part in parts]
        expanded_blocks.extend(parts)
    if replacements:
        blocks[:] = [block.model_copy(update={"ordinal": index}) for index, block in enumerate(expanded_blocks)]
        for node in structure:
            node.blockIds = [
                replacement_id
                for block_id in node.blockIds
                for replacement_id in replacements.get(block_id, [block_id])
            ]
            if node.sourceStart in replacements:
                node.sourceStart = replacements[node.sourceStart][0]
            if node.sourceEnd in replacements:
                node.sourceEnd = replacements[node.sourceEnd][-1]
    owner_by_block: dict[str, str] = {}
    for node in sorted(structure[1:], key=lambda item: item.level, reverse=True):
        for block_id in node.blockIds:
            owner_by_block.setdefault(block_id, node.id)
    for block in blocks:
        owner_by_block.setdefault(block.id, "structure:root")

    windows: list[ProcessingWindow] = []
    core: list[SourceBlock] = []
    core_tokens = 0
    owner = owner_by_block[blocks[0].id] if blocks else "structure:root"
    semantic_boundaries = semantic_change_points(blocks)

    def emit(strategy: str = "structural") -> None:
        nonlocal core, core_tokens, owner
        if not core:
            return
        start = core[0].ordinal
        end = core[-1].ordinal
        before = [item.id for item in blocks[max(0, start - context_blocks):start]]
        after = [item.id for item in blocks[end + 1:end + 1 + context_blocks]]
        windows.append(ProcessingWindow(
            id=f"window-{len(windows) + 1:05d}",
            structureNodeId=owner,
            coreBlockIds=[item.id for item in core],
            contextBeforeBlockIds=before,
            contextAfterBlockIds=after,
            tokenCount=core_tokens,
            contentHash=_window_hash(core),
            strategy=strategy,  # type: ignore[arg-type]
        ))
        core = []
        core_tokens = 0

    for block in blocks:
        block_tokens = estimate_tokens(block.text)
        block_owner = owner_by_block[block.id]
        boundary = core and block_owner != owner
        overflow = core and core_tokens + block_tokens > target_tokens
        semantic_boundary = core and core_tokens >= soft_min_tokens and block.ordinal in semantic_boundaries
        if boundary or overflow or semantic_boundary:
            emit("forced" if any("-part" in item.id for item in core) else ("structural" if boundary else "semantic"))
        if not core:
            owner = block_owner
        core.append(block)
        core_tokens += block_tokens
    emit("forced" if any("-part" in item.id for item in core) else "structural")

    # Verify the most important chunking invariant before returning any plan.
    owned = [block_id for window in windows for block_id in window.coreBlockIds]
    expected = [block.id for block in blocks]
    if owned != expected:
        raise RuntimeError("Processing windows do not provide complete, ordered core ownership")
    if any(window.tokenCount > hard_max_tokens for window in windows):
        raise RuntimeError("Processing window exceeds hard token maximum")
    return windows
