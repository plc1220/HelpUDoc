from typing import List, Dict, Union, Any, TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from .client import RAGClient

from paper2slides.llm.genai_client import create_client, extract_text, generate_text


class RAGQueryResult(TypedDict, total=False):
    """Single RAG query result from batch_query."""
    query: str
    answer: str
    mode: str  # query mode: local, global, hybrid, naive, mix
    success: bool
    error: str  # only present when success=False


RAG_PAPER_QUERIES: Dict[str, List[str]] = {
    "paper_info": [
        "List the paper title, author names and their institutional affiliations.",
    ],
    
    "figures": [
        "Describe the architecture or framework diagram. What are the main components shown?"
    ],
    
    "tables": [
        "Show the main performance comparison table with all methods and metrics. Include exact numbers.",
        "Show the ablation study table with all variants and their results.",
        "Show any dataset statistics table with sizes, splits, and other details."
    ],
    
    "equations": [
        "What is the core model formulation or main equation? Show the exact formula and notation."
    ],
    
    "motivation": [
        "What problem or task does this paper aim to solve? Describe the specific challenges.",
        "What are the limitations or drawbacks of existing approaches mentioned in the introduction or related work?",
        "What gap or unmet need motivates this research? How is it different from prior work?",
    ],
    
    "solution": [
        "What method, approach, or framework does this paper propose? Provide an overview.",

        "What are the main components, modules, or steps of the proposed method?",
        "Describe the system design, model structure, or theoretical framework. Include any architecture diagrams or tables if present.",

        "What are the key equations, formulas, or mathematical formulations? Show the notation and mathematical expressions.",
        "What objective function, optimization goal, or theoretical derivation is used?",

        "What is the algorithm, procedure, or workflow? Describe the key steps.",

        "What are the key parameters, settings, or implementation details mentioned?",
    ],
    
    "results": [
        "What datasets, benchmarks, or experimental setups are used for evaluation?",
        "What evaluation metrics or criteria are used to measure performance?",

        "What are the main results shown in the main results table?",
        "How does the proposed method compare to baseline methods? Show the comparison.",
        "What performance does the method achieve? Report the exact numbers from experiments.",

        "What ablation study or sensitivity analysis is conducted? What are the findings?",
        "What analysis, case study, or discussion of the results is provided?",
    ],
    
    "contributions": [
        "What are the main contributions listed in the introduction or conclusion?",
        "What is novel or new about this work compared to existing methods?",
        "What limitations does the paper acknowledge? What future directions are suggested?",
    ]
}

SKIP_LLM_SECTIONS = {"paper_info", "figures", "tables", "equations"}

RAG_QUERY_MODES: Dict[str, str] = {
    "paper_info": "hybrid",
    "figures": "mix",
    "tables": "mix",
    "equations": "mix",
    "motivation": "mix",
    "solution": "mix",
    "results": "mix",
    "contributions": "mix",
}


GENERAL_OVERVIEW_QUERIES = {
    "Document Type": "What type of document is this? (e.g., academic paper, technical report, tutorial, book chapter, presentation slides, documentation, etc.)",
    "Title": "What is the title of this document?",
    "Content Overview": "What is this document about? Provide a comprehensive overview including the main topic, key themes, and general content.",
    "Purpose": "What is the primary purpose or goal of this document? What does it aim to achieve or explain?",
    "Structure": "How is this document structured? What are the major sections or chapters?",
    "Important Elements": "What are the most important or notable elements? (e.g., key findings, main arguments, important concepts, critical data, core methods, etc.)",
    "Special Features": "Are there any special features? (e.g., diagrams, tables, formulas, equations, code examples, algorithms, case studies, etc.)",
}

_GENERATE_GENERAL_QUERIES_PROMPT = """You are an expert at analyzing documents. Based on the overview below, generate {count} queries to comprehensively understand this document.

=== DOCUMENT OVERVIEW ===
{overview}

=== YOUR TASK ===
Generate {count} queries to deeply extract the document's content. Your queries should cover:

1. **What the document is about**: Main ideas, core concepts, problems addressed, key arguments
2. **Specific content and details**: Methods, techniques, algorithms, formulas, data, results, examples
3. **Domain-specific information**: Technical details, parameters, implementations relevant to this document's field
4. **Different sections/aspects**: Ensure queries cover diverse parts of the document

REQUIREMENTS:
- Each query must be directly answerable from the document
- Ask about concrete specifics (numbers, methods, results, examples)
- Don't repeat information already in the overview
- Cover both conceptual understanding and technical details

OUTPUT FORMAT (JSON only):
[
  {{"id": 1, "query": "What is the main focus or goal of this document?"}},
  {{"id": 2, "query": "What specific method or technique is described? Explain its key components."}},
  {{"id": 3, "query": "What concrete results, data, or findings are presented?"}}
]

Generate exactly {count} queries in this JSON format."""


def _truncate_overview(overview: str, max_length: int = 6000) -> str:
    if len(overview) <= max_length:
        return overview
    return overview[:max_length] + "\n\n[Note: Overview truncated due to length]"

def _parse_queries_from_response(text: str) -> List[str]:
    """Parse LLM response to extract query strings."""
    import re
    import json
    
    try:
        json_match = re.search(r'```json\s*(\[.*?\])\s*```', text, re.DOTALL)
        if not json_match:
            json_match = re.search(r'\[.*\]', text, re.DOTALL)
        
        if json_match:
            json_str = json_match.group(1) if json_match.lastindex else json_match.group(0)
            query_objects = json.loads(json_str)
            return [obj['query'] for obj in query_objects if isinstance(obj, dict) and 'query' in obj]
    except (json.JSONDecodeError, ValueError, KeyError):
        pass
    
    # Fallback: parse line by line
    queries = []
    for line in text.strip().split('\n'):
        line = line.strip()
        if not line:
            continue
        q = re.sub(r'^[\d]+[\.\)\-\s]+', '', line).strip()
        if q and ('?' in q or '？' in q or len(q) > 20):
            queries.append(q)
    
    return queries

def generate_general_queries(
    rag_client: "RAGClient",
    overview: str,
    count: int = 20,
) -> List[str]:
    """
    Generate queries for general document analysis using LLM.
    
    Args:
        rag_client: RAG client for API config
        overview: Document overview text
        count: Number of queries to generate
    """
    prompt = _GENERATE_GENERAL_QUERIES_PROMPT.format(
        overview=_truncate_overview(overview),
        count=count,
    )
    
    try:
        config = rag_client.config.api
        
        client = create_client(
            api_key=config.llm_api_key,
            vertexai=config.use_vertexai,
            project=config.project,
            location=config.location,
        )
        
        response = generate_text(
            client,
            config.llm_model,
            messages=[{
                "role": "user",
                "content": prompt
            }]
        )
        
        result = extract_text(response)
        if not result:
            return []
        
        return _parse_queries_from_response(result)
        
    except Exception as e:
        print(f"[Error] Query generation failed: {e}")
        return []

async def get_general_overview(
    rag_client: "RAGClient",
    mode: str = "mix",
    max_section_length: int = 0,  # 0 = no truncation
) -> str:
    from paper2slides.summary.clean import clean_references
    
    overview_parts = []
    
    for label, query in GENERAL_OVERVIEW_QUERIES.items():
        try:
            response = await rag_client.query(query, mode=mode)
            if response:
                # Clean references first
                response_cleaned = clean_references(response.strip())
                if max_section_length > 0 and len(response_cleaned) > max_section_length:
                    response_cleaned = response_cleaned[:max_section_length] + "..."
                overview_parts.append(f"[{label}]\n{response_cleaned}")
        except Exception as e:
            print(f"[Warning] Overview query '{label}' failed: {e}")
            continue
    
    if not overview_parts:
        raise ValueError("Failed to get any document overview information.")
    
    return "\n\n".join(overview_parts)

async def get_queries(
    rag_client: "RAGClient" = None,
    use_predefined_paper_queries: bool = True,
    count: int = 8,
) -> Union[Dict[str, List[Dict[str, Any]]], List[str]]:
    """
    Get queries for document analysis.
    
    Returns:
        If use_predefined_paper_queries=True: Dict with query configs
        Otherwise: List of query strings
    """
    if use_predefined_paper_queries:
        return RAG_PAPER_QUERIES.copy()
    
    if rag_client is None:
        raise ValueError("RAG client is required for dynamic query generation.")
    
    overview = await get_general_overview(rag_client, mode="mix")
    return await generate_general_queries(rag_client, overview, count)
