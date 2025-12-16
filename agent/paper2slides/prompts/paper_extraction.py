"""
LLM prompts for extracting structured content from paper RAG results
"""
from typing import Dict

# LLM prompts for structured extraction
EXTRACT_PROMPTS: Dict[str, str] = {
    "motivation": """Organize the following research motivation text into a structured format.
IMPORTANT: Keep ALL information, do NOT summarize or omit any details.

Text:
{content}

Output format (use exact headers):
## RESEARCH PROBLEM
[Complete description of the main research problem with full context]

## LIMITATIONS OF EXISTING METHODS
[List ALL limitations mentioned, with full details]
- [limitation 1 with complete explanation]
- [limitation 2 with complete explanation]
...

## RESEARCH GAP
[Complete description of the gap being addressed]

## KEY CHALLENGES
[List all challenges mentioned with details]
- [challenge 1 with explanation]
- [challenge 2 with explanation]
...

## BACKGROUND CONTEXT
[Any relevant background information mentioned]""",

    "solution": """Organize the following methodology text into a structured format.
CRITICAL: Keep ALL technical details, ALL formulas/equations, and ALL component descriptions. Do NOT summarize.

Text:
{content}

Output format (use exact headers):
## FRAMEWORK OVERVIEW
[Complete description of the framework/approach]

## KEY COMPONENTS
[List ALL components with their FULL descriptions]
1. **[Component Name]**: [Complete description of how it works, including sub-components]
2. **[Component Name]**: [Complete description of how it works, including sub-components]
...

## MATHEMATICAL FORMULATIONS
[List ALL formulas and equations exactly as they appear]
- Formula 1: [exact formula]
  - Notation: [explain each symbol]
  - Purpose: [what this formula computes]
- Formula 2: [exact formula]
  - Notation: [explain each symbol]
  - Purpose: [what this formula computes]
...

## TECHNICAL PIPELINE
[Describe the complete processing pipeline step by step]
1. [Step 1 with details]
2. [Step 2 with details]
...

## IMPLEMENTATION DETAILS
[Any specific parameters, settings, or implementation notes mentioned]

## KEY INNOVATIONS
[What makes this approach novel or different from prior work]""",

    "results": """Organize the following experimental results into a structured format.
CRITICAL: Keep ALL numbers, ALL percentages, ALL table data EXACTLY as they appear. Do NOT round or omit any values.
IMPORTANT: Use HTML table format (<table>) for ALL tables, NOT markdown format (| xxx |).

Text:
{content}

Output format (use exact headers):
## DATASET / BENCHMARK
[If available, complete dataset information]
- Name: [exact name]
- Size: [exact statistics - samples, videos, hours, etc.]
- Categories/Splits: [if available]
  - [Category 1]: [exact numbers]
  - [Category 2]: [exact numbers]
  ...
- Other details: [any other dataset info]

## EVALUATION METRICS
[List all metrics used with definitions]
- [Metric 1]: [what it measures]
- [Metric 2]: [what it measures]
...

## MAIN RESULTS
[Reproduce the COMPLETE performance comparison table with ALL methods and ALL metrics]
[Use HTML table format as shown below - this is REQUIRED]
<table>
<tr><th>Method</th><th>Metric1</th><th>Metric2</th><th>...</th></tr>
<tr><td>Method1</td><td>value</td><td>value</td><td>...</td></tr>
<tr><td>Method2</td><td>value</td><td>value</td><td>...</td></tr>
</table>

## PERFORMANCE BY CATEGORY/SPLIT
[If available, show detailed breakdown by category/task/dataset using HTML table]
<table>
<tr><th>Category</th><th>Metric1</th><th>Metric2</th><th>...</th></tr>
<tr><td>Category1</td><td>value</td><td>value</td><td>...</td></tr>
</table>

## ABLATION STUDY
[If available, complete ablation results with ALL numbers using HTML table]
<table>
<tr><th>Variant</th><th>Metric1</th><th>Metric2</th><th>...</th></tr>
<tr><td>-Component</td><td>value</td><td>value</td><td>...</td></tr>
</table>

## DETAILED FINDINGS
[List ALL findings with specific numbers]
- [Finding 1 with exact numbers and percentages]
- [Finding 2 with exact numbers and percentages]
...

## COMPARISON ANALYSIS
[If available, detailed comparison with baseline methods, explaining performance differences]""",

    "contributions": """Extract all contributions, novelty claims, limitations, and future directions from the text.
Keep ALL details, do NOT summarize.

Text:
{content}

Output format (use exact headers):
## MAIN CONTRIBUTIONS
[List ALL contributions with complete explanations]
1. [Contribution 1]: [Full description of what was contributed]
2. [Contribution 2]: [Full description of what was contributed]
...

## NOVELTY & INNOVATIONS
[Detailed explanation of what's new]
- [Innovation 1 with comparison to prior work]
- [Innovation 2 with comparison to prior work]
...

## LIMITATIONS
[All acknowledged limitations]
- [Limitation 1 with details]
- [Limitation 2 with details]
...

## FUTURE DIRECTIONS
[All suggested future work]
- [Direction 1 with explanation]
- [Direction 2 with explanation]
...

## BROADER IMPACT
[If mentioned, any discussion of impact, applications, or societal implications]""",
}

