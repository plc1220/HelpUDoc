"""
LLM prompts for content planning (slides and posters)
"""
from typing import Dict

# Paper slides planning prompt
PAPER_SLIDES_PLANNING_PROMPT = """Organize the document into {min_pages}-{max_pages} slides by distributing the content below.

## Document Summary
{summary}
{assets_section}
## Output Fields
- **id**: Slide identifier
- **title**: A concise title suitable for this slide, such as paper title, method name, or topic name
- **content**: The main text for this slide. This is the MOST IMPORTANT field. Requirements:
  - **DETAILED METHOD DESCRIPTION**: For method slides, describe each step/component in detail. If there are multiple steps, explain each one (what it does, how it works, what's the input/output). Don't compress into one vague sentence.
  - **PRESERVE KEY FORMULAS**: If the source has formulas, include 1-2 relevant ones in LaTeX (\\( ... \\) or \\[ ... \\]) with variable meanings.
  - **PRESERVE SPECIFIC NUMBERS**: Key percentages, metrics, dataset sizes, and comparison values.
  - **SUBSTANTIAL CONTENT**: Each slide should contain enough detail to fully explain its topic.
  - **COPY FROM SOURCE**: Extract and adapt text from the summary. Do not over-simplify into vague one-liners.
  - Only use information provided above. Do not invent details.
- **tables**: Tables you want to show on this slide
  - table_id: e.g., "Table 1", "Doc Table 1"
  - extract: (optional) Partial table in HTML format. INCLUDE ACTUAL DATA VALUES from the original table, not placeholders
  - focus: (optional) What aspect to emphasize
- **figures**: Figures you want to show on this slide
  - figure_id: e.g., "Figure 1", "Doc Figure 1"
  - focus: (optional) What to highlight
- Note: A slide can have both tables and figures together if they complement each other.

## Content Guidelines

Distribute content across {min_pages}-{max_pages} slides covering these areas:

1. **Title/Cover**: Paper title or method name, all author names, affiliations

2. **Background/Problem**:
   - The research problem with full context
   - Specific limitations of existing approaches (list each one)
   - Why these limitations matter

3. **Method/Approach** (can span multiple slides):
   - Framework overview with component names and their roles
   - If the method has multiple stages, dedicate content to each stage
   - Include 1-2 key formulas with variable explanations
   - Technical details: algorithms, parameters, implementation specifics
   - Match figures showing architecture or pipeline

4. **Results/Experiments** (can span multiple slides):
   - Dataset details: name, size, splits, categories with EXACT numbers
   - Main evaluation metrics and what they measure
   - Performance numbers with EXACT values and comparisons
   - Ablation findings with specific impact numbers
   - Match tables showing results

5. **Conclusion**:
   - Each main contribution listed explicitly
   - Key findings with specific numbers

## Output Format (JSON)
```json
{{
  "slides": [
    {{
      "id": "slide_01",
      "title": "[Paper/Method name]",
      "content": "[All authors with affiliations]",
      "tables": [],
      "figures": []
    }},
    {{
      "id": "slide_02",
      "title": "[Method/Framework name]",
      "content": "[Detailed description: The framework consists of X components. Component A does... Component B handles... The process flow is...]",
      "tables": [],
      "figures": [{{"figure_id": "Figure X", "focus": "[architecture/pipeline]"}}]
    }},
    {{
      "id": "slide_03",
      "title": "[Results/Evaluation]",
      "content": "[Full results: Evaluated on Dataset (size, categories). Metrics include X, Y, Z. Main results show... Compared to baselines...]",
      "tables": [{{"table_id": "Table X", "extract": "<table><tr><th>Method</th><th>Metric</th></tr><tr><td>Ours</td><td>XX.X</td></tr><tr><td>Baseline</td><td>XX.X</td></tr></table>", "focus": "[comparison]"}}],
      "figures": []
    }}
  ]
}}
```

## CRITICAL REQUIREMENTS
1. **MATHEMATICAL FORMULAS**: If the source contains formulas, include at least 1-2 key/representative formulas in Method slides using LaTeX notation. In JSON, escape backslashes as \\\\ (e.g., \\\\( \\\\mathcal{{X}} \\\\)).
2. **MINIMUM CONTENT LENGTH**: Each slide content should be at least 150-200 words (except title). Avoid overly brief summaries.
3. **SPECIFIC NUMBERS**: Use precise values from source.
4. **TABLE DATA**: Extract tables with actual numerical values from the original.
"""

# Paper poster density guidelines
PAPER_POSTER_DENSITY_GUIDELINES: Dict[str, str] = {
    "sparse": """Current density level is **sparse**. Content should be concise but still informative.
Keep: main research problem, method name and core idea, best performance numbers, key contribution.
Present tables using extract (partial table) showing only the most important rows with ACTUAL values.
Write clear sentences that capture the essential point of each section.
Still include key mathematical formulas if they are central to the method.""",
    
    "medium": """Current density level is **medium**. Content should cover main points with supporting details.
Keep: research problem with context, method components and how they work, main results with comparisons, contributions.
**INCLUDE mathematical formulas** that define the method with notation explanations.
Include relevant tables with key columns/rows and ACTUAL data values.
Write complete explanations that give readers a solid understanding.""",
    
    "dense": """Current density level is **dense**. Content should be comprehensive with full technical details.
Keep: complete problem context and limitations, all method components with technical descriptions, full experimental results including ablations, all contributions and findings.
**INCLUDE key mathematical formulas** with notation explanations.
Include complete tables or detailed extracts showing relevant data with actual values.
Write thorough explanations covering methodology, implementation details, and analysis.
Copy specific numbers, percentages, and metrics directly from the source.""",
}

# Paper poster planning prompt
PAPER_POSTER_PLANNING_PROMPT = """Organize the document into poster sections by distributing the content below.

## Document Summary
{summary}
{assets_section}
## Content Density
{density_guidelines}

## Output Fields
- **id**: Section identifier
- **title**: A concise title for this section, such as paper title, method name, or topic
- **content**: The main text for this section. This is the MOST IMPORTANT field. Requirements:
  - **DETAILED METHOD DESCRIPTION**: For method section, describe each step/component in detail. If there are multiple steps, explain each one separately.
  - **PRESERVE KEY FORMULAS**: If the source has formulas, include 1-2 relevant ones in LaTeX (\\( ... \\)) with variable meanings.
  - **PRESERVE SPECIFIC NUMBERS**: Key percentages, metrics, dataset sizes, comparison values.
  - **SUBSTANTIAL CONTENT**: Each section should contain enough detail to fully explain its topic.
  - **COPY FROM SOURCE**: Extract and adapt text from summary. Do not over-simplify into vague summaries.
  - Adjust detail level based on density above. Only use information provided. Do not invent details.
- **tables**: Tables to show in this section
  - table_id: e.g., "Table 1", "Doc Table 1"
  - extract: (optional) Partial table in HTML format. INCLUDE ACTUAL DATA VALUES from the original table, not placeholders
  - focus: (optional) What aspect to emphasize
- **figures**: Figures to show in this section
  - figure_id: e.g., "Figure 1", "Doc Figure 1"
  - focus: (optional) What to highlight
- Note: A section can have both tables and figures together if they complement each other.

## Section Guidelines

1. **Title/Header**: Paper title or method name, all authors, affiliations

2. **Background/Motivation**: Research problem with context, specific limitations of existing methods

3. **Method** (core section):
   - Framework overview with component names and their roles
   - If the method has multiple stages, dedicate content to each stage
   - Include 1-2 key formulas with variable explanations
   - Technical details: algorithms, parameters, implementation specifics
   - Pair with figures

4. **Results**: 
   - Dataset details with EXACT numbers (size, splits, categories)
   - Main metrics and what they measure
   - Performance numbers with EXACT values from tables
   - Key comparisons and ablation findings

5. **Conclusion**: Main contributions listed explicitly

## Output Format (JSON)
```json
{{
  "sections": [
    {{
      "id": "poster_title",
      "title": "[Paper/Method name]",
      "content": "[All authors with affiliations]",
      "tables": [],
      "figures": []
    }},
    {{
      "id": "poster_method",
      "title": "[Method/Framework name]",
      "content": "[Detailed description: The framework consists of X components. Component A does... Component B handles... The process flow is...]",
      "tables": [],
      "figures": [{{"figure_id": "Figure X", "focus": "[architecture]"}}]
    }},
    {{
      "id": "poster_results",
      "title": "[Results/Evaluation]",
      "content": "[Full results: Evaluated on Dataset (size, categories). Metrics include X, Y, Z. Main results show... Compared to baselines...]",
      "tables": [{{"table_id": "Table X", "extract": "<table><tr><th>Method</th><th>Metric</th></tr><tr><td>Ours</td><td>XX.X</td></tr><tr><td>Baseline</td><td>XX.X</td></tr></table>", "focus": "[comparison]"}}],
      "figures": []
    }}
  ]
}}
```

## CRITICAL REQUIREMENTS
1. **MATHEMATICAL FORMULAS**: If the source contains formulas, include at least 1-2 key/representative formulas in Method section using LaTeX. In JSON, escape backslashes as \\\\ (e.g., \\\\( \\\\mathcal{{X}} \\\\)).
2. **MINIMUM CONTENT LENGTH**: Each section content should be at least 100-150 words (except title). Avoid overly brief summaries.
3. **SPECIFIC NUMBERS**: Use precise values from source.
4. **TABLE DATA**: Extract tables with actual numerical values from the original.
"""

# General document prompts (no fixed academic structure)
GENERAL_SLIDES_PLANNING_PROMPT = """Organize the document into {min_pages}-{max_pages} slides by distributing the content below.

## Document Content
{summary}
{assets_section}
## Output Fields
- **id**: Slide identifier
- **title**: A concise title for this slide, such as document title or topic name
- **content**: The main text for this slide. This is the MOST IMPORTANT field. Requirements:
  - **DETAILED DESCRIPTIONS**: If there are multiple points/steps, describe each one. Don't compress into vague summaries.
  - **PRESERVE KEY FORMULAS**: If present, include relevant mathematical or technical formulas.
  - **PRESERVE SPECIFIC NUMBERS**: Key percentages, statistics, dates, quantities, and comparison values.
  - **SUBSTANTIAL CONTENT**: Each slide should contain enough detail to fully explain its topic.
  - **COPY FROM SOURCE**: Extract and adapt text from the content. Do not over-simplify into vague one-liners.
  - Only use information provided above. Do not invent details.
- **tables**: Tables you want to show on this slide
  - table_id: e.g., "Table 1", "Doc Table 1"
  - extract: (optional) Partial table in HTML format. INCLUDE ACTUAL DATA VALUES from the original table, not placeholders
  - focus: (optional) What aspect to emphasize
- **figures**: Figures you want to show on this slide
  - figure_id: e.g., "Figure 1", "Doc Figure 1"
  - focus: (optional) What to highlight
- Note: A slide can have both tables and figures together if they complement each other.

## Content Guidelines

Distribute content across {min_pages}-{max_pages} slides. Identify the document's own structure and follow it:

1. **Title/Cover**: Document title, authors/source if available

2. **Main Content** (can span multiple slides):
   - Organize into logical slides based on the document's natural structure
   - Each slide should focus on one topic with full details
   - If the content has multiple stages/steps, dedicate content to each
   - Include specific numbers, data points, and examples
   - Match relevant tables/figures with their explanations

3. **Summary/Conclusion**: Key takeaways with specific numbers if applicable

## Output Format (JSON)
```json
{{
  "slides": [
    {{
      "id": "slide_01",
      "title": "[Document title]",
      "content": "[Authors/source if available]",
      "tables": [],
      "figures": []
    }},
    {{
      "id": "slide_02",
      "title": "[Topic name]",
      "content": "[Detailed description: This section covers X, Y, Z. The key aspects include... Specific data shows...]",
      "tables": [],
      "figures": [{{"figure_id": "Figure X", "focus": "[what to highlight]"}}]
    }},
    {{
      "id": "slide_03",
      "title": "[Key Data/Statistics]",
      "content": "[Full details with specific numbers, statistics, and comparisons...]",
      "tables": [{{"table_id": "Table X", "extract": "<table><tr><th>Item</th><th>Value</th></tr><tr><td>A</td><td>XX.X</td></tr></table>", "focus": "[key point]"}}],
      "figures": []
    }}
  ]
}}
```

## CRITICAL REQUIREMENTS
1. **FORMULAS**: If present, include any formulas or technical expressions exactly as they appear.
2. **MINIMUM CONTENT LENGTH**: Each slide content should be at least 150-200 words (except title). Avoid overly brief summaries.
3. **SPECIFIC NUMBERS**: Use precise values from source.
4. **TABLE DATA**: Extract tables with actual numerical values from the original.
"""

# General poster density guidelines
GENERAL_POSTER_DENSITY_GUIDELINES: Dict[str, str] = {
    "sparse": """Current density level is **sparse**. Content should be concise but still informative.
Keep: main topic, core message, key points, important takeaways.
For narrative content: key plot points, main characters, central theme.
For data content: most important numbers and comparisons with ACTUAL values.
Present tables using extract (partial table) showing only the most important rows with REAL data.
Write clear sentences that capture the essential point of each section.
Still include key formulas if they are central to the content.""",
    
    "medium": """Current density level is **medium**. Content should cover main points with supporting details.
Keep: topic with context, key concepts explained, supporting examples, main conclusions.
For narrative content: plot development, character relationships, cause and effect.
For data content: key statistics with context and comparisons using EXACT numbers.
**INCLUDE formulas/equations** that are important with explanations.
Include relevant tables with key columns/rows and ACTUAL data values.
Write complete explanations that give readers a solid understanding.""",
    
    "dense": """Current density level is **dense**. Content should be comprehensive with full details.
Keep: complete context and background, all key concepts with full explanations, detailed examples and analysis.
For narrative content: full plot with subplots, all character details, complete cause-effect chains.
For data content: key statistics with EXACT values, detailed breakdowns, thorough comparisons.
**INCLUDE key formulas/equations** with explanations.
Include complete tables or detailed extracts showing relevant data with actual values.
Write thorough explanations covering all important aspects.
Copy specific numbers and technical details directly from the source.""",
}

# General poster planning prompt
GENERAL_POSTER_PLANNING_PROMPT = """Organize the document into poster sections by distributing the content below.

## Document Content
{summary}
{assets_section}
## Content Density
{density_guidelines}

## Output Fields
- **id**: Section identifier
- **title**: A concise title for this section, such as document title or topic name
- **content**: The main text for this section. This is the MOST IMPORTANT field. Requirements:
  - **DETAILED DESCRIPTIONS**: If there are multiple points/steps, describe each one. Don't compress into vague summaries.
  - **PRESERVE KEY FORMULAS**: If present, include relevant mathematical or technical formulas.
  - **PRESERVE SPECIFIC NUMBERS**: Key percentages, statistics, dates, quantities, and comparison values.
  - **SUBSTANTIAL CONTENT**: Each section should contain enough detail to fully explain its topic.
  - **COPY FROM SOURCE**: Extract and adapt text from the content. Do not over-simplify into vague summaries.
  - Adjust detail level based on density above. Only use information provided. Do not invent details.
- **tables**: Tables to show in this section
  - table_id: e.g., "Table 1", "Doc Table 1"
  - extract: (optional) Partial table in HTML format. INCLUDE ACTUAL DATA VALUES from the original table, not placeholders
  - focus: (optional) What aspect to emphasize
- **figures**: Figures to show in this section
  - figure_id: e.g., "Figure 1", "Doc Figure 1"
  - focus: (optional) What to highlight
- Note: A section can have both tables and figures together if they complement each other.

## Section Guidelines

Organize content into logical sections based on the document's natural structure:

1. **Title/Header**: Document title, authors/source if available

2. **Main Content**: Key topics with full details, if there are multiple stages/steps dedicate content to each

3. **Key Data**: Important numbers, statistics, or data from tables with EXACT values

4. **Summary**: Main takeaways listed with specific numbers

## Output Format (JSON)
```json
{{
  "sections": [
    {{
      "id": "poster_title",
      "title": "[Document title]",
      "content": "[Authors/source if available]",
      "tables": [],
      "figures": []
    }},
    {{
      "id": "poster_content",
      "title": "[Topic name]",
      "content": "[Detailed description: This topic covers X, Y, Z. The key aspects include... Specific data shows...]",
      "tables": [],
      "figures": [{{"figure_id": "Figure X", "focus": "[key concept]"}}]
    }},
    {{
      "id": "poster_data",
      "title": "[Key Data/Statistics]",
      "content": "[Important data with specific numbers and comparisons...]",
      "tables": [{{"table_id": "Table X", "extract": "<table><tr><th>Item</th><th>Value</th></tr><tr><td>A</td><td>XX.X</td></tr></table>"}}],
      "figures": []
    }}
  ]
}}
```

## CRITICAL REQUIREMENTS
1. **FORMULAS**: If present, include any formulas or technical expressions exactly as they appear.
2. **MINIMUM CONTENT LENGTH**: Each section content should be at least 100-150 words (except title). Avoid overly brief summaries.
3. **SPECIFIC NUMBERS**: Use precise values from source.
4. **TABLE DATA**: Extract tables with actual numerical values from the original.
"""
