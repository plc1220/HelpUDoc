"""
Clean RAG results by removing references.
"""
import re
from typing import Dict, List, Any

def clean_references(text: str) -> str:
    if not text:
        return text
    
    # Remove block references: "### References" followed by list items
    text = re.sub(
        r'###\s*References\s*\n(?:[-*]\s*\[[^\]]+\][^\n]*\n?)*',
        '',
        text,
        flags=re.IGNORECASE
    )
    
    # Remove inline references: (Reference [1]) or (Reference [1], [2])
    text = re.sub(
        r'\s*\(Reference\s*\[[^\]]+\](?:\s*,\s*\[[^\]]+\])*\)',
        '',
        text,
        flags=re.IGNORECASE
    )
    
    # Remove extra blank lines (more than 2 consecutive)
    text = re.sub(r'\n{3,}', '\n\n', text)
    
    return text.strip()

def clean_rag_results(rag_results: Dict[str, List[Dict[str, Any]]]) -> Dict[str, List[Dict[str, Any]]]:
    cleaned = {}
    
    for section, items in rag_results.items():
        cleaned[section] = []
        for item in items:
            cleaned_item = item.copy()
            if "answer" in cleaned_item and cleaned_item["answer"]:
                cleaned_item["answer"] = clean_references(cleaned_item["answer"])
            cleaned[section].append(cleaned_item)
    
    return cleaned
