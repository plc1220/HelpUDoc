"""Deterministic structure detection from native headings and safe heuristics."""
from __future__ import annotations

import re

from .models import SourceBlock, StructureNode


_HEADING_PATTERN = re.compile(
    r"^(?:chapter|part|section|appendix|book|章|第[一二三四五六七八九十百零〇0-9]+章)\b",
    re.IGNORECASE,
)


def detect_structure(title: str, blocks: list[SourceBlock]) -> list[StructureNode]:
    root = StructureNode(
        id="structure:root",
        title=title,
        level=0,
        blockIds=[block.id for block in blocks],
        signals=["document_root"],
        confidence=1.0,
        sourceStart=blocks[0].id if blocks else None,
        sourceEnd=blocks[-1].id if blocks else None,
    )
    nodes = [root]
    stack: list[StructureNode] = [root]
    current = root
    for block in blocks:
        is_native = block.blockType == "heading"
        is_pattern = bool(_HEADING_PATTERN.match(block.text.strip())) and len(block.text) <= 180
        if is_native or is_pattern:
            level = block.headingLevel or 1
            level = max(1, min(6, level))
            while len(stack) > 1 and stack[-1].level >= level:
                stack.pop()
            parent = stack[-1]
            node = StructureNode(
                id=f"structure:{len(nodes)}",
                title=block.text.strip(),
                level=level,
                parentId=parent.id,
                blockIds=[block.id],
                signals=["native_heading" if is_native else "heading_pattern"],
                confidence=0.98 if is_native else 0.86,
                sourceStart=block.id,
                sourceEnd=block.id,
            )
            parent.childIds.append(node.id)
            nodes.append(node)
            stack.append(node)
            current = node
        elif current is not root:
            current.blockIds.append(block.id)
            current.sourceEnd = block.id
    return nodes
