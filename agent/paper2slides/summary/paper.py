"""
Paper document processing
Extract structured content from RAG results for paper documents
"""
import re
import asyncio
from typing import Dict, Any, List, Set, TypedDict
from dataclasses import dataclass, field
from pathlib import Path

from .clean import clean_references
from ..llm.genai_client import extract_text, generate_text
from ..rag import RAGQueryResult
from ..prompts.paper_extraction import EXTRACT_PROMPTS


SUMMARY_SECTIONS: List[str] = ["paper_info", "motivation", "solution", "results", "contributions"]

# Sections that need LLM for structured extraction
LLM_SECTIONS: Set[str] = {"motivation", "solution", "results", "contributions"}

# Section titles for the final summary
SECTION_TITLES: Dict[str, str] = {
    "paper_info": "# Paper Information",
    "motivation": "# Motivation",
    "solution": "# Solution / Methodology",
    "results": "# Results",
    "contributions": "# Contributions",
}

# Supplementary sections to include with main sections
SECTION_SUPPLEMENTS: Dict[str, List[tuple]] = {
    "solution": [
        ("figures", "The following are figures descriptions extracted from the paper:"),
        ("equations", "The following are equations extracted from the paper:"),
    ],
    "results": [
        ("tables", "The following are tables extracted from the paper:"),
    ],
}


class RAGResults(TypedDict, total=False):
    """RAG query results organized by section."""
    paper_info: List[RAGQueryResult]
    figures: List[RAGQueryResult]
    tables: List[RAGQueryResult]
    equations: List[RAGQueryResult]
    motivation: List[RAGQueryResult]
    solution: List[RAGQueryResult]
    results: List[RAGQueryResult]
    contributions: List[RAGQueryResult]


@dataclass
class PaperContent:
    """Extracted paper content."""
    paper_info: str = ""
    figures: str = ""
    tables: str = ""
    equations: str = ""
    motivation: str = ""
    solution: str = ""
    results: str = ""
    contributions: str = ""
    # Raw data
    raw_rag_results: Dict[str, Any] = field(default_factory=dict)
    
    def to_summary(
        self, 
        include_titles: bool = True,
        section_titles: Dict[str, str] | None = None,
    ) -> str:
        """Generate the final summary by combining relevant sections.
        
        Args:
            include_titles: Whether to include section titles in the output.
            section_titles: Custom section titles. If None, uses SECTION_TITLES.
        
        Note: figures, tables, equations are NOT included directly as they 
        are already added as supplements to solution and results sections.
        """
        titles = section_titles if section_titles is not None else SECTION_TITLES
        
        parts = []
        for section in SUMMARY_SECTIONS:
            content = getattr(self, section, "")
            if content:
                if include_titles:
                    title = titles.get(section, f"# {section.title()}")
                    parts.append(f"{title}\n\n{content}")
                else:
                    parts.append(content)
        
        return "\n\n---\n\n".join(parts)


def merge_answers(
    rag_results: RAGResults, 
    section: str, 
    clean_refs: bool = True,
    include_supplements: bool = False,
) -> str:
    """Merge all RAG answers for a section.
    
    Args:
        rag_results: RAG query results
        section: Section name to merge
        clean_refs: Whether to clean references
        include_supplements: Whether to include supplementary sections (figures/tables/equations)
    """
    items = rag_results.get(section, [])
    
    texts = []
    for item in items:
        answer = item.get("answer", "")
        if answer and len(answer) > 50:
            if clean_refs:
                answer = clean_references(answer)
            texts.append(answer)
    
    main_content = "\n\n---\n\n".join(texts)
    
    # Optionally include supplements
    if not include_supplements:
        return main_content
    
    supplements = SECTION_SUPPLEMENTS.get(section, [])
    if not supplements:
        return main_content
    
    parts = [main_content] if main_content else []
    for sup_section, description in supplements:
        # Recursive call without supplements to avoid infinite loop
        sup_content = merge_answers(rag_results, sup_section, clean_refs=clean_refs, include_supplements=False)
        if sup_content:
            parts.append(f"{description}\n\n{sup_content}")
    
    return "\n\n---\n\n".join(parts)


async def _extract_section(
    content: str,
    section: str,
    llm_client,
    model: str = "gemini-2.0-flash",
) -> str:
    """Extract structured content for a single section using LLM.
    
    Args:
        content: Merged RAG content for the section
        section: Section name (must be in EXTRACT_PROMPTS)
        llm_client: GenAI client
        model: Model to use
    """
    if not content or len(content) < 100:
        return ""
    
    prompt_template = EXTRACT_PROMPTS.get(section)
    if not prompt_template:
        return ""
    
    prompt = prompt_template.format(content=content)
    
    # Run sync LLM call in executor for async compatibility
    loop = asyncio.get_event_loop()
    response = await loop.run_in_executor(
        None,
        lambda: generate_text(
            llm_client,
            model,
            messages=[{"role": "user", "content": prompt}],
            max_output_tokens=4000,
        )
    )
    
    return extract_text(response)


async def extract_paper(
    rag_results: RAGResults,
    llm_client,
    model: str = "gemini-2.0-flash",
    clean_refs: bool = True,
    parallel: bool = True,
    max_concurrency: int = 5,
) -> PaperContent:
    """
    Extract structured content from RAG results for a paper.
    
    Args:
        rag_results: RAG query results
        llm_client: OpenAI client
        model: Model to use
        clean_refs: Whether to clean references from RAG answers
        parallel: If True, process LLM sections in parallel
        max_concurrency: Maximum concurrent LLM calls (only used when parallel=True)
    """
    result = PaperContent(raw_rag_results=rag_results)
    
    # Prepare sections that need LLM processing
    llm_tasks = {}
    for section in SUMMARY_SECTIONS:
        if section in LLM_SECTIONS:
            merged = merge_answers(rag_results, section, clean_refs=clean_refs, include_supplements=True)
            if merged:
                llm_tasks[section] = merged
        else:
            # Direct use without LLM (e.g., paper_info)
            merged = merge_answers(rag_results, section, clean_refs=clean_refs)
            if merged:
                setattr(result, section, merged)
    
    # Process LLM sections
    if llm_tasks:
        if parallel:
            # Parallel processing with semaphore for rate limiting
            semaphore = asyncio.Semaphore(max_concurrency)
            
            async def extract_with_semaphore(section: str, content: str) -> tuple:
                async with semaphore:
                    extracted = await _extract_section(content, section, llm_client, model)
                    return section, extracted
            
            tasks = [extract_with_semaphore(s, c) for s, c in llm_tasks.items()]
            results = await asyncio.gather(*tasks)
            for section, extracted in results:
                if extracted:
                    setattr(result, section, extracted)
        else:
            # Sequential processing
            for section, content in llm_tasks.items():
                extracted = await _extract_section(content, section, llm_client, model)
                if extracted:
                    setattr(result, section, extracted)
    
    return result


def _extract_text_from_markdown(md_path: str, max_chars: int = 3000) -> str:
    """
    Extract plain text from markdown file, removing image links.
    
    Args:
        md_path: Path to markdown file
        max_chars: Maximum characters to read (metadata is usually at the beginning)
    """
    try:
        with open(md_path, 'r', encoding='utf-8') as f:
            content = f.read(max_chars)
        
        # Remove image links: ![](images/xxx.jpg) or ![alt](path)
        content = re.sub(r'!\[.*?\]\(.*?\)', '', content)
        
        # Remove excessive blank lines
        content = re.sub(r'\n{3,}', '\n\n', content)
        
        return content.strip()
    except Exception as e:
        print(f"[Warning] Failed to read markdown {md_path}: {e}")
        return ""


def _build_single_file_prompt(text: str) -> str:
    """Build simple prompt for single file extraction."""
    return f"""Extract the paper's basic information from the text below:

Text:
{text}

Output Format:
**Title**: [exact paper title]
**Authors**: [Author1 (Institution1), Author2 (Institution2), ...]

Format example:
**Title**: Deep Learning for Computer Vision
**Authors**: John Smith (MIT), Jane Doe (Stanford University), Bob Johnson (Google Research)

If affiliation is not clear for an author, just write the name without parentheses.
If information is missing or unclear, omit that field entirely.
"""


def _build_multi_file_prompt(file_headers: List[Dict]) -> str:
    """Build prompt for multiple file extraction (assumes independent papers)."""
    documents_text = ""
    for header in file_headers:
        documents_text += f"""

━━━━━━━━━━━━━━━━━━━━━━
Document {header['index']}: {header['filename']}
━━━━━━━━━━━━━━━━━━━━━━

{header['text']}
"""
    
    return f"""You are given {len(file_headers)} different document files. Each file is an independent paper.
Extract the metadata for each paper separately.

Documents:
{documents_text}

Output Format:

**Paper 1** (from Document 1: {file_headers[0]['filename']})
Title: [exact title]
Authors: [Author1 (Institution1), Author2 (Institution2), ...]

**Paper 2** (from Document 2: {file_headers[1]['filename'] if len(file_headers) > 1 else '...'})
Title: [exact title]
Authors: [Author1 (Institution1), Author2 (Institution2), ...]

... (continue for all papers)

If affiliation is not clear for an author, just write the name without parentheses.
If information is missing or unclear for a paper, omit that field.
"""


async def extract_paper_metadata_from_markdown(
    markdown_paths: List[str],
    llm_client,
    model: str = "gemini-2.0-flash",
    max_chars_per_file: int = 3000,
) -> str:
    """
    Extract paper metadata (title, authors, affiliations) directly from markdown files.
    Bypasses RAG queries and extracts from raw markdown text.
    """
    if not markdown_paths:
        return "Unable to extract paper metadata: No markdown files found."
    
    # Read beginning section from each markdown file separately
    file_headers = []
    for i, md_path in enumerate(markdown_paths, 1):
        text = _extract_text_from_markdown(md_path, max_chars=max_chars_per_file)
        if text:
            file_name = Path(md_path).stem
            file_headers.append({
                "index": i,
                "filename": file_name,
                "text": text
            })
    
    if not file_headers:
        return "Unable to extract paper metadata: All markdown files are empty."
    
    # Choose prompt strategy based on number of files
    if len(file_headers) == 1:
        # Single file: simple direct prompt
        prompt = _build_single_file_prompt(file_headers[0]['text'])
    else:
        # Multiple files: complex multi-scenario prompt
        prompt = _build_multi_file_prompt(file_headers)
    
    loop = asyncio.get_event_loop()
    response = await loop.run_in_executor(
        None,
        lambda: generate_text(
            llm_client,
            model,
            messages=[{"role": "user", "content": prompt}],
            max_output_tokens=1500,
            temperature=0.1,  # Low temperature for accuracy
        )
    )
    
    return extract_text(response)
