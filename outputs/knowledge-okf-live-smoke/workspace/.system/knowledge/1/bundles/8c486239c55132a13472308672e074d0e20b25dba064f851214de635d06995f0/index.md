---
okf_version: "0.2"
---

# knowledge-okf-enrichment-spec.md

Knowledge Ingestion, Semantic Enrichment, and OKF Retrieval Specification

# Source

* [knowledge-okf-enrichment-spec.md](source.md)

# Concepts

* [Reciprocal-Rank Fusion](concepts/algorithm/reciprocal-rank-fusion.md) - Referenced Algorithm in the source.
* [Admin APIs](concepts/api/admin-apis.md) - Administrative API endpoints for managing knowledge enrichment ingestions and bundle access.
* [knowledge_neighbors](concepts/api/knowledge-neighbors.md) - A tool for traversing graph relationships.
* [knowledge_read](concepts/api/knowledge-read.md) - A tool for reading specific concepts or evidence.
* [Knowledge Search APIs](concepts/api/knowledge-search-apis.md) - Interfaces for interacting with the knowledge search system.
* [knowledge_search](concepts/api/knowledge-search.md) - A retrieval tool for hybrid candidate search.
* [knowledgeApi.ts](concepts/api/knowledgeapi-ts.md) - Typed API contracts for knowledge-related services.
* [knowledgeService.ts](concepts/api/knowledgeservice-ts.md) - Referenced API in the source.
* [Progress/Report APIs](concepts/api/progress-report-apis.md) - Referenced API in the source.
* [rag_query](concepts/api/rag-query.md) - A legacy retrieval tool.
* [OKF bundle](concepts/artifact/okf-bundle.md) - A published hierarchy of linked Markdown concept documents.
* [Redis](concepts/cache/redis.md) - Referenced Cache in the source.
* [pgvector support](concepts/capability/pgvector-support.md) - Referenced capability in the source.
* [Ye Wenjie](concepts/character/ye-wenjie.md) - A central character whose experiences and decisions shape humanity's contact with Trisolaris.
* [Retrieval index](concepts/component/retrieval-index.md) - Referenced component in the source.
* [Canonical concept](concepts/concept/canonical-concept.md) - Referenced concept in the source.
* [Domain concepts replace page-as-concept output](concepts/concept/domain-concepts-replace-page-as-concept-output.md) - Referenced concept in the source.
* [Every assertion has valid evidence](concepts/concept/every-assertion-has-valid-evidence.md) - Referenced concept in the source.
* [Graph Hierarchy](concepts/concept/graph-hierarchy.md) - The hierarchical organization derived from graph clustering results.
* [Job States](concepts/concept/job-states.md) - Referenced Concept in the source.
* [Knowledge Unit](concepts/concept/knowledge-unit.md) - Referenced Concept in the source.
* [Rerunning unchanged windows uses cached map results](concepts/concept/rerunning-unchanged-windows-uses-cached-map-results.md) - Referenced concept in the source.
* [Semantic Enrichment Pipeline](concepts/concept/semantic-enrichment-pipeline.md) - Referenced concept in the source.
* [Source block](concepts/concept/source-block.md) - Normalized text and layout metadata representing one or more source units.
* [Source unit](concepts/concept/source-unit.md) - Addressable source element such as a PDF page, DOCX paragraph, table, cell, list item, or caption.
* [Structure node](concepts/concept/structure-node.md) - Container representing a structural unit like a book, chapter, section, or topic.
* [Evidence of Necessity](concepts/condition/evidence-of-necessity.md) - Referenced condition in the source.
* [Hard Maximum (4,000)](concepts/configuration-parameter/hard-maximum-4-000.md) - Referenced Configuration Parameter in the source.
* [Soft Minimum (600)](concepts/configuration-parameter/soft-minimum-600.md) - Referenced Configuration Parameter in the source.
* [Target Tokens (2,500)](concepts/configuration-parameter/target-tokens-2-500.md) - Referenced Configuration Parameter in the source.
* [Rate Card](concepts/configuration/rate-card.md) - A versioned configuration used to track and calculate costs for usage reports independently of provider pricing changes.
* [Boundary Preference](concepts/constraint/boundary-preference.md) - Referenced constraint in the source.
* [Core Span Uniqueness](concepts/constraint/core-span-uniqueness.md) - Referenced constraint in the source.
* [Future Scalability](concepts/constraint/future-scalability.md) - Referenced constraint in the source.
* [Non-goal: Inference Accuracy Guarantee](concepts/constraint/non-goal-inference-accuracy-guarantee.md) - Guaranteeing model inference accuracy without evidence/review.
* [Non-goal: Neo4j Requirement](concepts/constraint/non-goal-neo4j-requirement.md) - Requiring Neo4j for the initial release.
* [Non-goal: OKF Replacement](concepts/constraint/non-goal-okf-replacement.md) - Treating OKF as a replacement for the original document.
* [Token Constraints](concepts/constraint/token-constraints.md) - Referenced Constraint in the source.
* [Token Maximums](concepts/constraint/token-maximums.md) - Referenced constraint in the source.
* [Knowledge Source Scope](concepts/constraints/knowledge-source-scope.md) - Referenced constraints in the source.
* [OKF v0.2 bundles](concepts/data-format/okf-v0-2-bundles.md) - Referenced data-format in the source.
* [Original workspace file storage](concepts/data-source/original-workspace-file-storage.md) - Referenced data-source in the source.
* [SourceBlock](concepts/data-structure/sourceblock.md) - Referenced data-structure in the source.
* [Structure Node](concepts/data-structure/structure-node.md) - Referenced data_structure in the source.
* [Concept Embeddings](concepts/data-type/concept-embeddings.md) - Referenced data-type in the source.
* [PostgreSQL](concepts/database/postgresql.md) - Referenced Database in the source.
* [Defer Graph Database Implementation](concepts/decision/defer-graph-database-implementation.md) - Strategic decision regarding the implementation of specialized graph storage.
* [Atomic Current-Bundle Pointer](concepts/deliverable/atomic-current-bundle-pointer.md) - Referenced Deliverable in the source.
* [Baseline Deliverables](concepts/deliverable/baseline-deliverables.md) - Referenced Deliverable in the source.
* [Bundle Validation and Link Checking](concepts/deliverable/bundle-validation-and-link-checking.md) - Referenced Deliverable in the source.
* [Canonical Concept/Assertion/Relationship Tables](concepts/deliverable/canonical-concept-assertion-relationship-tables.md) - Referenced Deliverable in the source.
* [Deterministic OKF Publisher and Manifest](concepts/deliverable/deterministic-okf-publisher-and-manifest.md) - Referenced Deliverable in the source.
* [Immutable Enrichment Snapshots](concepts/deliverable/immutable-enrichment-snapshots.md) - Referenced Deliverable in the source.
* [NetworkX Clustering and Graph Audit](concepts/deliverable/networkx-clustering-and-graph-audit.md) - Referenced Deliverable in the source.
* [Phase 5 Deliverables](concepts/deliverable/phase-5-deliverables.md) - The tangible outputs required for Phase 5.
* [Knowledge Worker Deployment](concepts/deployment-procedure/knowledge-worker-deployment.md) - Referenced deployment-procedure in the source.
* [Extraction Workflow](concepts/document-processing-flow/extraction-workflow.md) - Referenced document_processing_flow in the source.
* [Untrusted content handling](concepts/document-processing/untrusted-content-handling.md) - Referenced document-processing in the source.
* [Example OKF concept](concepts/documentexample/example-okf-concept.md) - A markdown-based structural example of how an OKF concept is defined for a character.
* [Evaluation Metrics](concepts/evaluation-procedure/evaluation-metrics.md) - Quantitative and qualitative measures used to assess system performance and extraction accuracy.
* [First Contact](concepts/event/first-contact.md) - A significant event involving alien contact, facilitated by Ye Wenjie.
* [Phase 1](concepts/event/phase-1.md) - Referenced event in the source.
* [Phase 2: Gemini Lite map/reduce enrichment](concepts/event/phase-2-gemini-lite-map-reduce-enrichment.md) - A project phase focused on map/reduce enrichment using Gemini Lite models.
* [Phase 5: backfill, evaluation, and controlled rollout](concepts/event/phase-5-backfill-evaluation-and-controlled-rollout.md) - The final phase focused on backfilling data, evaluating performance, and managing the rollout process.
* [Three-Body PDF QC Case Study](concepts/event/three-body-pdf-qc-case-study.md) - A specific quality control test case using a 950-page document.
* [KnowledgeBundleExplorer](concepts/feature/knowledgebundleexplorer.md) - Referenced feature in the source.
* [OKF bundle](concepts/fileformat/okf-bundle.md) - A portable, linked, and valid data format for storing enrichment knowledge, based on OKF v0.2.
* [OKF Concept Format](concepts/format-specification/okf-concept-format.md) - Standard schema definition for an OKF concept document.
* [OKF v0.2](concepts/format/okf-v0-2.md) - Open Knowledge Format (OKF) v0.2 is the canonical, portable, human-readable output format for the HelpUDoc system.
* [Agent Framework](concepts/framework/agent-framework.md) - Referenced framework in the source.
* [Canonicalization candidates](concepts/functionality/canonicalization-candidates.md) - Referenced functionality in the source.
* [Dynamic chunk planning](concepts/functionality/dynamic-chunk-planning.md) - Referenced functionality in the source.
* [Gemini Lite structured extraction and reduction](concepts/functionality/gemini-lite-structured-extraction-and-reduction.md) - Referenced functionality in the source.
* [Graph analysis and community detection](concepts/functionality/graph-analysis-and-community-detection.md) - Referenced functionality in the source.
* [Layout and heading analysis](concepts/functionality/layout-and-heading-analysis.md) - Referenced functionality in the source.
* [PDF/DOCX extraction adapters](concepts/functionality/pdf-docx-extraction-adapters.md) - Referenced functionality in the source.
* [Query-time reranking and evidence selection](concepts/functionality/query-time-reranking-and-evidence-selection.md) - Referenced functionality in the source.
* [Validation helpers](concepts/functionality/validation-helpers.md) - Referenced functionality in the source.
* [HelpUDoc System Goals](concepts/goal/helpudoc-system-goals.md) - The strategic objectives for the HelpUDoc system to ensure efficient, reliable, and semantically rich knowledge extraction.
* [Pgvector-enabled Database Path](concepts/infrastructure-requirement/pgvector-enabled-database-path.md) - Infrastructure requirements for establishing database connectivity with vector search capabilities.
* [Pipeline Inputs](concepts/input/pipeline-inputs.md) - Referenced Input in the source.
* [Reciprocal-rank Fusion](concepts/method/reciprocal-rank-fusion.md) - A method to combine candidate rankings from different retrieval streams without requiring comparable raw scores.
* [Evaluation Metrics](concepts/metric-framework/evaluation-metrics.md) - A set of metrics used to assess the quality and performance of the system.
* [Phase 0 Metrics](concepts/metrics/phase-0-metrics.md) - Key performance indicators and quality metrics used to evaluate the correctness and observability of the extraction system.
* [Gemini Lite](concepts/model/gemini-lite.md) - An AI model used for structured data extraction and reduction.
* [knowledge_ingestion](concepts/module/knowledge-ingestion.md) - Module handling document extraction and internal ingestion routes.
* [Document Processing and Semantic Organization](concepts/objective/document-processing-and-semantic-organization.md) - The primary goal of transforming unstructured uploads into provenance-backed, semantically rich, queryable knowledge.
* [Red Coast Base](concepts/organization/red-coast-base.md) - An organization or facility where Ye Wenjie worked.
* [Ingestion Metadata](concepts/output/ingestion-metadata.md) - Referenced Output in the source.
* [System Performance](concepts/performance-metric/system-performance.md) - Referenced performance-metric in the source.
* [Ye Wenjie](concepts/person/ye-wenjie.md) - A central character whose actions at Red Coast Base precipitate significant events.
* [Phase 0: Correctness and Observability Baseline](concepts/phase/phase-0-correctness-and-observability-baseline.md) - The initial stage focused on establishing a baseline for system correctness and observability.
* [Implementation Plan](concepts/plan/implementation-plan.md) - The overall roadmap for implementing the system.
* [Access Control](concepts/policies/access-control.md) - Referenced policies in the source.
* [Retention Policy](concepts/policies/retention-policy.md) - Referenced policies in the source.
* [Adapter Design Policy](concepts/policy/adapter-design-policy.md) - Policy governing the design of system adapters.
* [API Idempotency Policy](concepts/policy/api-idempotency-policy.md) - Requirement that API calls must be idempotent based on task ID and content hash.
* [Bundle Management Policy](concepts/policy/bundle-management-policy.md) - Rules governing the persistence and updates of Knowledge bundles.
* [Chunking Policy](concepts/policy/chunking-policy.md) - Guidelines governing how documents are partitioned into windows for processing.
* [Concurrency Policy](concepts/policy/concurrency-policy.md) - Policies governing parallel and serial execution of system tasks.
* [Data Integrity Policy](concepts/policy/data-integrity-policy.md) - Referenced policy in the source.
* [Data Retention Policy](concepts/policy/data-retention-policy.md) - Referenced policy in the source.
* [Deployment Exclusion Policy](concepts/policy/deployment-exclusion-policy.md) - Policies regarding initial system requirements and exclusions.
* [Enrichment Policy](concepts/policy/enrichment-policy.md) - Standards for generating semantic knowledge maps from document segments.
* [Graph Traversal Policy](concepts/policy/graph-traversal-policy.md) - Requirement that graph expansion must be bounded and relation-aware to prevent context flooding.
* [Knowledge-grant Policy](concepts/policy/knowledge-grant-policy.md) - Policy governing access to knowledge resources within workspaces.
* [Knowledge Upgrade Policy](concepts/policy/knowledge-upgrade-policy.md) - Policy for upgrading existing knowledge sources while preserving previous bundles and enabling comparison/rollback.
* [OCR Provider Policy](concepts/policy/ocr-provider-policy.md) - Referenced policy in the source.
* [OKF Policy](concepts/policy/okf-policy.md) - Rules and validation standards for OKF bundles.
* [OKF v0.2](concepts/policy/okf-v0-2.md) - Standard for document frontmatter in the knowledge system.
* [Output Contracts](concepts/policy/output-contracts.md) - Specifications defining expected outputs from various system components during the knowledge processing pipeline.
* [Persistence Model](concepts/policy/persistence-model.md) - Data storage design centered on ingestion runs and immutable snapshots.
* [Product Principles](concepts/policy/product-principles.md) - A set of ten guiding rules for product development, emphasizing evidence-based knowledge and structural integrity.
* [Retrieval Rules](concepts/policy/retrieval-rules.md) - Operating guidelines for the retrieval system.
* [Rollout and Compatibility Policy](concepts/policy/rollout-and-compatibility-policy.md) - Policies governing compatibility, versioning, and rollback procedures for Knowledge bundles.
* [Rollout Compatibility Policy](concepts/policy/rollout-compatibility-policy.md) - Operational policies for rollout and versioning of knowledge bundles.
* [Safety against document instructions](concepts/policy/safety-against-document-instructions.md) - Safety policy for processing untrusted documents.
* [Safety Policy](concepts/policy/safety-policy.md) - Protocols for handling untrusted content to prevent prompt injection or execution of document instructions.
* [Security and Governance Policy](concepts/policy/security-and-governance-policy.md) - Guidelines for maintaining data security, privacy, and system governance in knowledge jobs.
* [Security and Governance](concepts/policy/security-and-governance.md) - Standards and operational constraints for data privacy and system security.
* [Selective Enrichment Policy](concepts/policy/selective-enrichment-policy.md) - Rule preventing redundant enrichment of unchanged data.
* [Snapshot Mutability Policy](concepts/policy/snapshot-mutability-policy.md) - Policy stating that changes to prompts, schemas, or models must create a new enrichment version rather than mutating existing snapshots.
* [Token Constraints Policy](concepts/policy/token-constraints-policy.md) - Operational limits defined for optimal window extraction, including target, soft minimum, and hard maximum token counts.
* [Tracing Privacy Policy](concepts/policy/tracing-privacy-policy.md) - Policy governing data capture in tracing systems.
* [Versioning Policy](concepts/policy/versioning-policy.md) - Rules governing the creation and mutation of enrichment versions.
* [Adapter Modularity Principle](concepts/principle/adapter-modularity-principle.md) - Architectural design principle to maintain system modularity for future scalability.
* [Page Indexing Limitations](concepts/problem/page-indexing-limitations.md) - The inadequacy of using raw document pages as the primary unit for knowledge organization, as they act as transport boundaries rather than semantic units.
* [Chunk Planning](concepts/procedure-step/chunk-planning.md) - Referenced procedure-step in the source.
* [Extraction Planning and Execution](concepts/procedure-step/extraction-planning-and-execution.md) - Referenced procedure-step in the source.
* [Graph Analysis](concepts/procedure-step/graph-analysis.md) - Referenced procedure-step in the source.
* [Map Extraction](concepts/procedure-step/map-extraction.md) - Referenced procedure-step in the source.
* [Optional Query Reranking](concepts/procedure-step/optional-query-reranking.md) - Referenced procedure-step in the source.
* [Reduce/Canonicalization](concepts/procedure-step/reduce-canonicalization.md) - Referenced procedure-step in the source.
* [Structure Detection](concepts/procedure-step/structure-detection.md) - Referenced procedure-step in the source.
* [Acceptance Gate](concepts/procedure/acceptance-gate.md) - Quality and integrity criteria that must be satisfied before a job can be considered published.
* [Adaptive Threshold Calculation](concepts/procedure/adaptive-threshold-calculation.md) - A statistical method to calculate an adaptive threshold for determining boundaries.
* [Atomic Version Switching](concepts/procedure/atomic-version-switching.md) - A safety mechanism ensuring readers access either the old or new bundle version, preventing partially written states.
* [boundary-adjudication-process](concepts/procedure/boundary-adjudication-process.md) - The system for determining boundaries between information segments.
* [Boundary signal analysis](concepts/procedure/boundary-signal-analysis.md) - Referenced procedure in the source.
* [Caching Methodology](concepts/procedure/caching-methodology.md) - Strategy for system performance optimization.
* [Caching Strategy](concepts/procedure/caching-strategy.md) - A multi-level caching strategy designed to optimize cost and performance in enrichment processing.
* [Canonicalization Process](concepts/procedure/canonicalization-process.md) - The process of consolidating entity candidates into a single canonical representation using various validation signals.
* [Chunking Procedure](concepts/procedure/chunking-procedure.md) - Procedures for partitioning document text.
* [Community Detection](concepts/procedure/community-detection.md) - The algorithmic determination of community structures within the knowledge graph.
* [Community naming](concepts/procedure/community-naming.md) - Referenced procedure in the source.
* [Concurrency Control](concepts/procedure/concurrency-control.md) - Mechanisms governing parallel execution of tasks to manage system load.
* [Current Ingestion Process](concepts/procedure/current-ingestion-process.md) - The legacy or current methodology for processing documents.
* [Data Extraction Procedure](concepts/procedure/data-extraction-procedure.md) - The procedure for processing and structuring knowledge from documents.
* [Deterministic Extraction Process](concepts/procedure/deterministic-extraction-process.md) - The first stage of data extraction, focusing on native text layout analysis.
* [Deterministic OKF Publication](concepts/procedure/deterministic-okf-publication.md) - The process of deterministically generating output based on an enrichment snapshot.
* [Deterministic Publication](concepts/procedure/deterministic-publication.md) - Referenced procedure in the source.
* [Document-level Synthesis](concepts/procedure/document-level-synthesis.md) - Referenced Procedure in the source.
* [Domain Profile Substitution](concepts/procedure/domain-profile-substitution.md) - A template for defining concept types based on source material context.
* [Domain-specific Profiling](concepts/procedure/domain-specific-profiling.md) - The method of using context-specific concept types (e.g., Policy, API) depending on the source material domain.
* [Dynamic chunk planning](concepts/procedure/dynamic-chunk-planning.md) - Referenced procedure in the source.
* [Dynamic Chunking](concepts/procedure/dynamic-chunking.md) - Referenced procedure in the source.
* [Embedding Caching](concepts/procedure/embedding-caching.md) - Referenced procedure in the source.
* [Enrichment Procedure](concepts/procedure/enrichment-procedure.md) - Procedures for enriching document knowledge and assertions.
* [enrichment-process](concepts/procedure/enrichment-process.md) - Referenced procedure in the source.
* [Enrichment](concepts/procedure/enrichment.md) - Model-assisted production of structured concepts, assertions, and relationships.
* [Error Handling Procedure](concepts/procedure/error-handling-procedure.md) - Error handling mechanism that triggers backoff and retains sibling results upon failure.
* [Extraction Validation](concepts/procedure/extraction-validation.md) - A process that rejects malformed outputs such as missing evidence or unsupported relationship directions.
* [Extraction](concepts/procedure/extraction.md) - Deterministic conversion of the original document into source blocks.
* [File Fingerprinting](concepts/procedure/file-fingerprinting.md) - Referenced Procedure in the source.
* [Gemini Lite Map Extraction](concepts/procedure/gemini-lite-map-extraction.md) - The process utilized for extracting structured knowledge graphs from document processing windows.
* [Golden corpora](concepts/procedure/golden-corpora.md) - Small, curated datasets used for validation and benchmarking.
* [Graph analysis and community detection](concepts/procedure/graph-analysis-and-community-detection.md) - Referenced procedure in the source.
* [Graph Expansion](concepts/procedure/graph-expansion.md) - Referenced procedure in the source.
* [Header/Footer Removal](concepts/procedure/header-footer-removal.md) - Referenced procedure in the source.
* [Hierarchical Reduction](concepts/procedure/hierarchical-reduction.md) - The sixth stage of the synthesis process, involving the reduction of leaf results into higher-level syntheses.
* [Hierarchical Splitting Algorithm](concepts/procedure/hierarchical-splitting-algorithm.md) - An algorithm used to segment hierarchical document nodes into processing windows based on token limits and structural properties.
* [Human Review Workflow](concepts/procedure/human-review-workflow.md) - Referenced procedure in the source.
* [Immutable Enrichment Snapshot](concepts/procedure/immutable-enrichment-snapshot.md) - An immutable data package created before publication containing all relevant graph processing artifacts and metadata.
* [In-memory Graph Construction](concepts/procedure/in-memory-graph-construction.md) - The process of aggregating concepts and relationships into a unified data structure.
* [Ingestion Management](concepts/procedure/ingestion-management.md) - Referenced procedure in the source.
* [Ingestion Migration](concepts/procedure/ingestion-migration.md) - Referenced Procedure in the source.
* [Ingestion Pipeline](concepts/procedure/ingestion-pipeline.md) - A sequence of stages to process and persist knowledge extraction results.
* [Integration Tests](concepts/procedure/integration-tests.md) - Tests for system behavior across stages, including failure recovery, state changes, and update handling.
* [Knowledge Graph Processing Pipeline](concepts/procedure/knowledge-graph-processing-pipeline.md) - The multi-stage pipeline process used for managing knowledge graph operations.
* [Language Distribution Analysis](concepts/procedure/language-distribution-analysis.md) - Referenced procedure in the source.
* [Layout and heading analysis](concepts/procedure/layout-and-heading-analysis.md) - Referenced procedure in the source.
* [Leaf semantic extraction](concepts/procedure/leaf-semantic-extraction.md) - Referenced procedure in the source.
* [Lexical Retrieval](concepts/procedure/lexical-retrieval.md) - Referenced procedure in the source.
* [Line-wrap Repair](concepts/procedure/line-wrap-repair.md) - Referenced procedure in the source.
* [Low-confidence alias adjudication](concepts/procedure/low-confidence-alias-adjudication.md) - Referenced procedure in the source.
* [Low-confidence structural boundary adjudication](concepts/procedure/low-confidence-structural-boundary-adjudication.md) - Referenced procedure in the source.
* [Map Tasks Execution](concepts/procedure/map-tasks-execution.md) - Parallel execution of tasks constrained by workspace and global quotas.
* [Model Map Result Caching](concepts/procedure/model-map-result-caching.md) - Referenced procedure in the source.
* [Normalization Stage](concepts/procedure/normalization-stage.md) - A deterministic, language-aware process that refines source units into normalized artifacts while preserving original mapping.
* [OCR Fallback Procedure](concepts/procedure/ocr-fallback-procedure.md) - A process to handle pages with insufficient native text via Optical Character Recognition.
* [OCR Handling Procedure](concepts/procedure/ocr-handling-procedure.md) - Protocol for handling pages with insufficient native text content.
* [OKF Bundle Publication](concepts/procedure/okf-bundle-publication.md) - Protocol for identifying and publishing OKF bundles.
* [OKF Generation](concepts/procedure/okf-generation.md) - Referenced procedure in the source.
* [Optional top-candidate reranking](concepts/procedure/optional-top-candidate-reranking.md) - Referenced procedure in the source.
* [Page-Based Indexing](concepts/procedure/page-based-indexing.md) - The practice of using document pages as the primary unit of organization.
* [Page Boundary Joining](concepts/procedure/page-boundary-joining.md) - Referenced procedure in the source.
* [PDF/DOCX extraction](concepts/procedure/pdf-docx-extraction.md) - Referenced procedure in the source.
* [Phase 0 Implementation](concepts/procedure/phase-0-implementation.md) - The initial phase of the implementation plan focused on establishing a baseline for correctness and observability.
* [Phase 2 Prerequisites](concepts/procedure/phase-2-prerequisites.md) - A list of technical and policy decisions required to be resolved before moving to the next initiative phase.
* [Processing Window Caching](concepts/procedure/processing-window-caching.md) - Referenced procedure in the source.
* [Processing Window Synthesis](concepts/procedure/processing-window-synthesis.md) - Referenced Procedure in the source.
* [Publication procedure](concepts/procedure/publication-procedure.md) - A procedure for atomic deployment of knowledge bundles to ensure data integrity.
* [Publication Process](concepts/procedure/publication-process.md) - The procedure for finalizing and deploying knowledge bundles, ensuring atomic transitions between versions.
* [Query Flow Procedure](concepts/procedure/query-flow-procedure.md) - The sequential process for handling user inquiries, involving analysis, retrieval, fusion, expansion, filtering, and synthesis.
* [Query Flow](concepts/procedure/query-flow.md) - The process for handling user queries from analysis to final answer generation, utilizing lexical/vector search, graph expansion, and reranking.
* [Query-time reranking](concepts/procedure/query-time-reranking.md) - Referenced procedure in the source.
* [Re-enrichment Action](concepts/procedure/re-enrichment-action.md) - Referenced Procedure in the source.
* [Reduce Tasks Execution](concepts/procedure/reduce-tasks-execution.md) - Process where reduction tasks wait for completion of structural children.
* [Refactor knowledgeService](concepts/procedure/refactor-knowledgeservice.md) - Refactoring knowledgeService.ts into orchestration and deterministic publishing.
* [Relationship Validation Process](concepts/procedure/relationship-validation-process.md) - The verification and categorization of relationships between concepts in the knowledge graph.
* [Retrieval Evaluation Set](concepts/procedure/retrieval-evaluation-set.md) - A testing framework used to verify retrieval system performance and accuracy.
* [Retrieval Methodology](concepts/procedure/retrieval-methodology.md) - The overarching process for retrieving and synthesizing information.
* [Schema Migration and Redis Setup](concepts/procedure/schema-migration-and-redis-setup.md) - Implementing Knex-backed schema creation/migrations and Redis progress publication.
* [Section and document reductions](concepts/procedure/section-and-document-reductions.md) - Referenced procedure in the source.
* [Semantic Enrichment Pipeline](concepts/procedure/semantic-enrichment-pipeline.md) - A planned pipeline to replace the current publisher, focused on deep extraction and semantic organization rather than simple lexical scanning.
* [Source Extraction Caching](concepts/procedure/source-extraction-caching.md) - Referenced procedure in the source.
* [Source Mapping Retention](concepts/procedure/source-mapping-retention.md) - Referenced procedure in the source.
* [Stage 0: Intake and Fingerprinting](concepts/procedure/stage-0-intake-and-fingerprinting.md) - The initial phase of the pipeline involving file processing and metadata validation.
* [Structure Detection](concepts/procedure/structure-detection.md) - Stage 3 of processing where document hierarchy is reconstructed using boundary signals.
* [Structured extraction and reduction](concepts/procedure/structured-extraction-and-reduction.md) - Referenced procedure in the source.
* [Synthesis Pipeline](concepts/procedure/synthesis-pipeline.md) - The iterative process of aggregating data from processing windows up to the document level.
* [System infrastructure decisions](concepts/procedure/system-infrastructure-decisions.md) - Referenced procedure in the source.
* [Task Retry and Recovery](concepts/procedure/task-retry-and-recovery.md) - The mechanism for handling failed tasks, involving a retry delay and lease expiration.
* [Test Case](concepts/procedure/test-case.md) - Specific scenarios verified during integration testing.
* [Text Normalization](concepts/procedure/text-normalization.md) - Process of preparing raw text by cleaning, normalizing, and standardizing content before analysis.
* [Three-Body QC](concepts/procedure/three-body-qc.md) - Quality control process for verifying document extraction completeness.
* [Unicode Normalization](concepts/procedure/unicode-normalization.md) - Referenced procedure in the source.
* [Unit testing strategy](concepts/procedure/unit-testing-strategy.md) - The collection of test cases and validation procedures applied to individual system modules, particularly focusing on PDF/DOCX processing and data extraction pipelines.
* [Unit Tests](concepts/procedure/unit-tests.md) - Specific tests for isolated system components like document processing, hierarchy construction, and semantic boundaries.
* [Untrusted Document Handling](concepts/procedure/untrusted-document-handling.md) - The procedure of treating document content as untrusted data rather than executable instructions.
* [Vector Retrieval](concepts/procedure/vector-retrieval.md) - Referenced procedure in the source.
* [Window Merge Logic](concepts/procedure/window-merge-logic.md) - Strategy for combining adjacent windows that remain below token limits and share structural context.
* [Window Merging Policy](concepts/procedure/window-merging-policy.md) - A procedure for merging window chunks when they are small and logically related.
* [Chunking Procedure](concepts/procedures/chunking-procedure.md) - Procedures for segmenting text into processing windows.
* [Completeness Audit](concepts/procedures/completeness-audit.md) - Validation process ensuring total coverage of ingested documents.
* [Source Deletion Procedure](concepts/procedures/source-deletion-procedure.md) - Procedure for removing knowledge sources and associated data.
* [Stage 1: Deterministic Extraction](concepts/process-stage/stage-1-deterministic-extraction.md) - The initial stage of a data extraction workflow characterized by deterministic processing.
* [Document Processing Pipeline](concepts/process/document-processing-pipeline.md) - Referenced Process in the source.
* [Knowledge Source Upgrade](concepts/process/knowledge-source-upgrade.md) - Referenced process in the source.
* [Exit Criteria](concepts/project-goal/exit-criteria.md) - Required outcomes for the completion of Phase 1.
* [Phase 1: Durable Extraction and Dynamic Chunk Planning](concepts/project-phase/phase-1-durable-extraction-and-dynamic-chunk-planning.md) - The first phase of the helpudoc project, focusing on durable extraction and dynamic chunk planning.
* [Phase 3: Canonical Graph and Deterministic OKF v0.2](concepts/project-phase/phase-3-canonical-graph-and-deterministic-okf-v0-2.md) - The third phase of project development, focused on establishing canonical graphs and deterministic OKF v0.2.
* [Phase 4: Hybrid Retrieval](concepts/project-phase/phase-4-hybrid-retrieval.md) - The fourth phase of project development.
* [Idempotency](concepts/property/idempotency.md) - Referenced Property in the source.
* [Completeness QC](concepts/quality-gates/completeness-qc.md) - Referenced quality-gates in the source.
* [Acceptance Gate](concepts/requirement/acceptance-gate.md) - A validation requirement ensuring data integrity and successful processing before publication.
* [Access Preservation](concepts/requirement/access-preservation.md) - Requirement to inherit governance and workspace boundaries.
* [Add admin coverage and warning fields](concepts/requirement/add-admin-coverage-and-warning-fields.md) - Referenced requirement in the source.
* [Ambiguity Resolution Requirement](concepts/requirement/ambiguity-resolution-requirement.md) - Requirements for the reducer to resolve conflicts, aliases, broken ordering, or uncertain relationships.
* [Atomic Publication](concepts/requirement/atomic-publication.md) - Referenced Requirement in the source.
* [Bundle Validation](concepts/requirement/bundle-validation.md) - The standard or requirement that a bundle must satisfy to be considered valid under OKF v0.2.
* [Complete Coverage](concepts/requirement/complete-coverage.md) - Requirement to process all supported source units or report failures.
* [Complete Document Accounting](concepts/requirement/complete-document-accounting.md) - Referenced Requirement in the source.
* [Core-Window Coverage](concepts/requirement/core-window-coverage.md) - Referenced Requirement in the source.
* [Cost Control](concepts/requirement/cost-control.md) - Requirement to use efficient models and caching strategies.
* [Deterministic Publishing](concepts/requirement/deterministic-publishing.md) - Requirement for generating identical OKF files from snapshots.
* [DOCX Extraction Standard](concepts/requirement/docx-extraction-standard.md) - Requirements for extracting structured data from DOCX files using python-docx.
* [Durable Processing](concepts/requirement/durable-processing.md) - Requirement to survive system restarts without full reprocessing.
* [Efficient Retrieval](concepts/requirement/efficient-retrieval.md) - Requirement to combine lexical, vector, and graph retrieval strategies.
* [Embedding Dependency Policy](concepts/requirement/embedding-dependency-policy.md) - A set of constraints regarding embedding dependencies in the chunk-planning release.
* [Evaluation Set Composition](concepts/requirement/evaluation-set-composition.md) - The specific criteria required for a retrieval evaluation set.
* [Evidence-level Provenance](concepts/requirement/evidence-level-provenance.md) - Requirement that factual assertions resolve to source spans.
* [Evidence-span PDF/DOCX location exposure](concepts/requirement/evidence-span-pdf-docx-location-exposure.md) - Referenced Requirement in the source.
* [Evidence Validation](concepts/requirement/evidence-validation.md) - Referenced requirement in the source.
* [Exact retrieval beyond page 50](concepts/requirement/exact-retrieval-beyond-page-50.md) - Referenced Requirement in the source.
* [Exit Criteria](concepts/requirement/exit-criteria.md) - The set of requirements that must be met to consider Phase 5 complete.
* [Extraction Failure Constraint](concepts/requirement/extraction-failure-constraint.md) - Referenced requirement in the source.
* [Fix filename encoding](concepts/requirement/fix-filename-encoding.md) - Referenced requirement in the source.
* [Hard Split Policy](concepts/requirement/hard-split-policy.md) - A hard constraint on chunk size to prevent single-element overflows.
* [Initial Technology Exclusions](concepts/requirement/initial-technology-exclusions.md) - List of technologies and systems that are explicitly not required for the initial implementation phase.
* [Knowledge Retrieval Requirements](concepts/requirement/knowledge-retrieval-requirements.md) - The functional requirements for retrieving information from complex sources, necessitating semantic organization rather than just lexical matching.
* [Multilingual Support](concepts/requirement/multilingual-support.md) - Requirement to process non-English content without whitespace assumptions.
* [No Silent Caps](concepts/requirement/no-silent-caps.md) - Requirement that safety limits fail visibly or produce resumable status.
* [Observable Quality](concepts/requirement/observable-quality.md) - Requirement to report coverage, stats, and confidence.
* [Output Contract](concepts/requirement/output-contract.md) - The definition and requirements for the output generated by the processing pipeline.
* [Output contracts](concepts/requirement/output-contracts.md) - Requirements for the publication and structure of the knowledge system.
* [PDF Extraction Requirements](concepts/requirement/pdf-extraction-requirements.md) - Standard data elements required from the PDF extraction process.
* [Portable Knowledge](concepts/requirement/portable-knowledge.md) - Requirement to emit OKF v0.2 bundles independent of specific infrastructure.
* [Preserve page/paragraph locators](concepts/requirement/preserve-page-paragraph-locators.md) - Referenced requirement in the source.
* [Prevent silent partial document publishing](concepts/requirement/prevent-silent-partial-document-publishing.md) - Referenced requirement in the source.
* [Publication procedure](concepts/requirement/publication-procedure.md) - Referenced requirement in the source.
* [Quality Gates and Acceptance Criteria](concepts/requirement/quality-gates-and-acceptance-criteria.md) - Validation requirements for document processing integrity.
* [Record source-unit counts](concepts/requirement/record-source-unit-counts.md) - Referenced requirement in the source.
* [Relationship Attribution](concepts/requirement/relationship-attribution.md) - Referenced requirement in the source.
* [Remove 50-section truncation](concepts/requirement/remove-50-section-truncation.md) - Referenced requirement in the source.
* [Restart-Safe Extraction](concepts/requirement/restart-safe-extraction.md) - Referenced Requirement in the source.
* [Retrieval Acceptance Expectations](concepts/requirement/retrieval-acceptance-expectations.md) - Operational benchmarks for assessing retrieval system success.
* [Safety Requirement](concepts/requirement/safety-requirement.md) - Requirement that enrichment prompts must explicitly define document instructions as data to be analyzed, not commands to be executed.
* [Semantic and multi-hop evaluation target success](concepts/requirement/semantic-and-multi-hop-evaluation-target-success.md) - Referenced Requirement in the source.
* [Semantic Concepts](concepts/requirement/semantic-concepts.md) - Requirement to generate domain-appropriate concepts rather than page-based metadata.
* [Snapshot Mutability Policy](concepts/requirement/snapshot-mutability-policy.md) - Referenced Requirement in the source.
* [Source Unit Accounting Consistency](concepts/requirement/source-unit-accounting-consistency.md) - Referenced requirement in the source.
* [Structured Output Constraint](concepts/requirement/structured-output-constraint.md) - Strict requirements for Gemini Lite to return validated structured results and avoid hidden reasoning.
* [Version Tracking Requirement](concepts/requirement/version-tracking-requirement.md) - Requirement that all model-assisted outputs must record specific metadata (e.g., provider, model ID, prompt version, tokens).
* [Acceptance Criteria](concepts/requirements/acceptance-criteria.md) - Expectations for the performance and output quality of the system retrieval and generation capabilities.
* [Definition of Done](concepts/requirements/definition-of-done.md) - The criteria defining the successful completion of the initiative.
* [Display Requirements](concepts/requirements/display-requirements.md) - Referenced Requirements in the source.
* [Exit Criteria](concepts/requirements/exit-criteria.md) - The specific conditions required to finalize Phase 2.
* [Initiative Completion Criteria](concepts/requirements/initiative-completion-criteria.md) - The criteria defining the successful completion of the system ingestion and processing initiative.
* [Knowledge Job Requirements](concepts/requirements/knowledge-job-requirements.md) - Requirements for executing and managing knowledge processing jobs, including scope inheritance and access controls.
* [Phase 2 Readiness Items](concepts/requirements/phase-2-readiness-items.md) - Pending requirements and operational definitions to be resolved before transitioning to Phase 2.
* [Product Principles](concepts/requirements/product-principles.md) - Guiding tenets for developing and managing the knowledge documentation system.
* [Required System Outputs](concepts/requirements/required-system-outputs.md) - List of mandatory artifacts produced during the system lifecycle.
* [Baseline search method](concepts/role/baseline-search-method.md) - Referenced role in the source.
* [Deterministic publisher](concepts/role/deterministic-publisher.md) - Referenced Role in the source.
* [Artifact Isolation](concepts/security/artifact-isolation.md) - Referenced security in the source.
* [Data Privacy](concepts/security/data-privacy.md) - Referenced security in the source.
* [Hybrid Retrieval Service](concepts/service/hybrid-retrieval-service.md) - Service for hybrid knowledge retrieval.
* [helpudoc_agent/knowledge_ingestion](concepts/software-module/helpudoc-agent-knowledge-ingestion.md) - Referenced Software Module in the source.
* [OKF v0.2](concepts/specification/okf-v0-2.md) - Open Knowledge Format version 0.2, the canonical format for knowledge storage.
* [Retrieval Result Contract](concepts/specification/retrieval-result-contract.md) - Standard JSON structure for returning retrieval results, containing query, snapshot, concepts, and evidence pointers.
* [SourceBlock Type](concepts/specification/sourceblock-type.md) - Data structure definition for source blocks extracted from documents.
* [Open Knowledge Format v0.2](concepts/specifications/open-knowledge-format-v0-2.md) - Referenced specifications in the source.
* [OKF v0.2](concepts/standard/okf-v0-2.md) - The Open Knowledge Format (OKF) specification, version 0.2, governing document structure and bundle validation.
* [Boundary Preference](concepts/standards/boundary-preference.md) - Referenced standards in the source.
* [Semantically weak](concepts/state/semantically-weak.md) - Referenced state in the source.
* [Workspace storage](concepts/storage/workspace-storage.md) - Referenced storage in the source.
* [Testing Strategy](concepts/strategy/testing-strategy.md) - The overarching strategy for verifying the system, comprising unit and integration testing components.
* [Gemini Lite](concepts/system-ai-model/gemini-lite.md) - The AI model used for performing enrichment tasks.
* [Internal Agent Endpoints](concepts/system-api/internal-agent-endpoints.md) - Internal authenticated endpoints used by the backend for processing and analyzing data.
* [Knowledge API Routes](concepts/system-api/knowledge-api-routes.md) - A set of routes for accessing knowledge-related data, supporting both global admin and workspace-scoped contexts.
* [Agent](concepts/system-component/agent.md) - Agent logic responsible for document processing, extraction, and planning.
* [Artifact Staging](concepts/system-component/artifact-staging.md) - Referenced System Component in the source.
* [Backend](concepts/system-component/backend.md) - Backend infrastructure for data ingestion and orchestration.
* [Dynamic Processing Window](concepts/system-component/dynamic-processing-window.md) - A mechanism for defining the scope and size of content chunks for processing, configured by token counts and context boundaries.
* [Enrichment Snapshot](concepts/system-component/enrichment-snapshot.md) - A data structure containing the processed knowledge components used as the source for deterministic publication.
* [Explorer](concepts/system-component/explorer.md) - A tool for inspecting the results, structure, and telemetry of knowledge extraction processes.
* [Extraction Pipeline](concepts/system-component/extraction-pipeline.md) - Referenced System Component in the source.
* [Frontend](concepts/system-component/frontend.md) - User interface components for visualizing document processing progress.
* [Gemini Lite Reranking](concepts/system-component/gemini-lite-reranking.md) - Referenced System Component in the source.
* [Gemini Lite](concepts/system-component/gemini-lite.md) - An AI model responsible for processing document windows to generate structured candidate entities and relationships.
* [Hybrid Retrieval Service](concepts/system-component/hybrid-retrieval-service.md) - A core service component utilizing reciprocal-rank fusion to improve search results.
* [Knowledge Jobs](concepts/system-component/knowledge-jobs.md) - Processes that inherit workspace settings and grants, used for ingestion and querying of knowledge sources.
* [Knowledge source card](concepts/system-component/knowledge-source-card.md) - A UI component or administrative dashboard that provides status and telemetry regarding a knowledge processing or extraction task.
* [Knowledge Worker](concepts/system-component/knowledge-worker.md) - Referenced system-component in the source.
* [OKF Publisher](concepts/system-component/okf-publisher.md) - Referenced System Component in the source.
* [Processing Window](concepts/system-component/processing-window.md) - A unit of document text used as input for processing, defined by its structural boundaries and content.
* [Structure Node](concepts/system-component/structure-node.md) - A node representing a hierarchical structure in a document, used for processing and mapping.
* [System File Structure](concepts/system-component/system-file-structure.md) - Organizational structure of the system file repository.
* [TypeScript Backend](concepts/system-component/typescript-backend.md) - The server-side component of the architecture.
* [Internal Agent Endpoints](concepts/system-feature/internal-agent-endpoints.md) - Referenced System Feature in the source.
* [Project Goals](concepts/system-goal/project-goals.md) - Referenced System Goal in the source.
* [Usage Metrics](concepts/system-metric/usage-metrics.md) - Telemetry data tracked for LLM-based operations including model calls, token counts, costs, and performance metrics.
* [Integration Tests](concepts/system-procedure/integration-tests.md) - A set of automated testing scenarios ensuring system resilience and data integrity across various failure and state change conditions.
* [Knowledge Worker Deployment](concepts/system-procedure/knowledge-worker-deployment.md) - The process and operational environment for the Knowledge worker.
* [Rollback Procedure](concepts/system-process/rollback-procedure.md) - Referenced system-process in the source.
* [Infrastructure Requirements](concepts/system-requirement/infrastructure-requirements.md) - Technical prerequisites and configuration needed for the Knowledge worker deployment.
* [950-page novel](concepts/system-resource/950-page-novel.md) - Referenced System Resource in the source.
* [DOCX Fixtures](concepts/system-resource/docx-fixtures.md) - Referenced System Resource in the source.
* [Golden Corpora](concepts/system-resource/golden-corpora.md) - A collection of small, committed, or license-safe fixtures used for testing document processing capabilities.
* [PDF Fixtures](concepts/system-resource/pdf-fixtures.md) - Referenced System Resource in the source.
* [Table/Caption Fixtures](concepts/system-resource/table-caption-fixtures.md) - Referenced System Resource in the source.
* [Knowledge System](concepts/system-software/knowledge-system.md) - Referenced System/Software in the source.
* [PostgreSQL](concepts/system-software/postgresql.md) - The primary database for storing semantic state and graph adjacency.
* [OKF v0.2](concepts/system-standard/okf-v0-2.md) - The portable published format for Knowledge bundles.
* [Publication System](concepts/system-standard/publication-system.md) - Referenced System/Standard in the source.
* [950-page Novel Fixture](concepts/system/950-page-novel-fixture.md) - A 950-page novel used for local performance/QC testing.
* [Adapters](concepts/system/adapters.md) - System components responsible for handling future-proofing and operational scaling options.
* [Admin Portal](concepts/system/admin-portal.md) - Referenced system in the source.
* [Agent Module](concepts/system/agent-module.md) - The helpudoc_agent module for document processing and knowledge extraction.
* [Agent Processing Layer](concepts/system/agent-processing-layer.md) - Agent processing layer handling data analysis pipelines.
* [Agent processing](concepts/system/agent-processing.md) - Processing layer for agents.
* [Agent System](concepts/system/agent-system.md) - The backend agent responsible for knowledge ingestion, processing, and retrieval, undergoing refactoring to support new ingestion routes and service architectures.
* [API/Orchestration Layer](concepts/system/api-orchestration-layer.md) - The API and orchestration layer handling lifecycle and validation.
* [API/orchestration](concepts/system/api-orchestration.md) - API and orchestration layer.
* [Artifact layout](concepts/system/artifact-layout.md) - The directory structure for knowledge system artifacts.
* [Backend Changes](concepts/system/backend-changes.md) - Required modifications to the backend architecture to support new knowledge management capabilities.
* [Backend Services](concepts/system/backend-services.md) - The backend architecture responsible for knowledge service orchestration.
* [Canonical entity registry](concepts/system/canonical-entity-registry.md) - Referenced system in the source.
* [Chapter/section reducers](concepts/system/chapter-section-reducers.md) - Referenced system in the source.
* [chunk-planning-release](concepts/system/chunk-planning-release.md) - The initial release for chunk planning functionality.
* [Chunking Algorithm](concepts/system/chunking-algorithm.md) - Referenced System in the source.
* [context-span](concepts/system/context-span.md) - Secondary content surrounding a core span.
* [Control Plane](concepts/system/control-plane.md) - The management layer of the system handling authorization, ingestion lifecycles, and publication.
* [core-span](concepts/system/core-span.md) - The primary content source within a processing window.
* [Current Bundle Pointer](concepts/system/current-bundle-pointer.md) - A configuration file indicating which directory constitutes the published OKF bundle.
* [Database](concepts/system/database.md) - Referenced system in the source.
* [Deliverables](concepts/system/deliverables.md) - Set of outputs required for the successful completion of Phase 2.
* [deterministic-publication](concepts/system/deterministic-publication.md) - Referenced system in the source.
* [Document Extraction System](concepts/system/document-extraction-system.md) - Referenced system in the source.
* [Document Hierarchy Model](concepts/system/document-hierarchy-model.md) - A hierarchical representation of document structure from major divisions to subsections.
* [Document Processing System](concepts/system/document-processing-system.md) - Referenced system in the source.
* [DOCX Evidence Locators](concepts/system/docx-evidence-locators.md) - Mechanism for locating evidence within DOCX files, relying on stable document coordinates rather than rendered line numbers.
* [Elasticsearch/OpenSearch](concepts/system/elasticsearch-opensearch.md) - Referenced system in the source.
* [Enrichment Metadata](concepts/system/enrichment-metadata.md) - Technical metadata attributes for an enrichment process.
* [Enrichment Process](concepts/system/enrichment-process.md) - Referenced system in the source.
* [Enrichment System](concepts/system/enrichment-system.md) - A system for standardizing enrichment processing, requiring valid evidence spans for assertions.
* [Enrichment Versioning System](concepts/system/enrichment-versioning-system.md) - Referenced system in the source.
* [Evaluation Dashboard](concepts/system/evaluation-dashboard.md) - Referenced System in the source.
* [Evaluation Document Types](concepts/system/evaluation-document-types.md) - Document types used for evaluating system capabilities.
* [Evaluation Metrics](concepts/system/evaluation-metrics.md) - Metrics used to measure system performance.
* [Existing System Stack](concepts/system/existing-system-stack.md) - The existing technical architecture being reused for the system.
* [Extraction Pipeline](concepts/system/extraction-pipeline.md) - The system infrastructure responsible for ingesting, parsing, and extracting structured knowledge from document sources.
* [Feature Flags](concepts/system/feature-flags.md) - Referenced System in the source.
* [FileService](concepts/system/fileservice.md) - System component responsible for reading source files after validation.
* [Frontend Interface](concepts/system/frontend-interface.md) - Frontend components for visualizing and managing knowledge bundles.
* [Frontend Layer](concepts/system/frontend-layer.md) - The frontend technology stack for admin interfaces and data visualization.
* [Frontend System](concepts/system/frontend-system.md) - The user interface component responsible for visualizing knowledge bundles and managing page-level states.
* [Frontend](concepts/system/frontend.md) - Frontend system for administration, exploration, and visualization.
* [Future Technology Options](concepts/system/future-technology-options.md) - Potential architectural technologies for future system scalability.
* [Gemini Lite Generation](concepts/system/gemini-lite-generation.md) - Referenced system in the source.
* [Gemini Lite](concepts/system/gemini-lite.md) - The LLM model configured to perform entity extraction and semantic analysis within the new pipeline.
* [Graph Persistence System](concepts/system/graph-persistence-system.md) - Mechanism for storing graph structures in the database.
* [Graph Persistence](concepts/system/graph-persistence.md) - Persistence layer for the knowledge graph utilizing directed adjacency structures.
* [Helpudoc Agent](concepts/system/helpudoc-agent.md) - Agent system responsible for document ingestion and navigation.
* [HelpUDoc](concepts/system/helpudoc.md) - The document processing and retrieval platform designed to turn uploaded documents into semantically organized knowledge sources.
* [Hybrid Retrieval System](concepts/system/hybrid-retrieval-system.md) - Referenced system in the source.
* [Immutable Enrichment Snapshot](concepts/system/immutable-enrichment-snapshot.md) - Referenced system in the source.
* [Indexes](concepts/system/indexes.md) - Mechanisms used to facilitate retrieval within the methodology.
* [Infrastructure Layer](concepts/system/infrastructure-layer.md) - The supporting infrastructure layer for the knowledge processing system, requiring database extensions and specialized worker deployments.
* [Infrastructure Stack](concepts/system/infrastructure-stack.md) - The underlying technologies used for data storage, processing, and management within the pipeline.
* [Infrastructure](concepts/system/infrastructure.md) - Referenced system in the source.
* [Kafka](concepts/system/kafka.md) - Referenced system in the source.
* [Knex](concepts/system/knex.md) - Referenced system in the source.
* [Knowledge bundle](concepts/system/knowledge-bundle.md) - An immutable unit of knowledge storage.
* [Knowledge Documentation System](concepts/system/knowledge-documentation-system.md) - Referenced system in the source.
* [Knowledge Enrichment System](concepts/system/knowledge-enrichment-system.md) - Referenced system in the source.
* [Knowledge Graph System](concepts/system/knowledge-graph-system.md) - A system that processes documents (like PDFs/DOCXs) to extract semantic knowledge graphs, ensuring auditable structure, evidence-backed concepts, and valid output bundles.
* [Knowledge Infrastructure](concepts/system/knowledge-infrastructure.md) - Referenced system in the source.
* [Knowledge Ingestion Job State](concepts/system/knowledge-ingestion-job-state.md) - The lifecycle state of a knowledge ingestion job.
* [Knowledge Ingestion Jobs](concepts/system/knowledge-ingestion-jobs.md) - Referenced System in the source.
* [Knowledge Ingestion Tables](concepts/system/knowledge-ingestion-tables.md) - Specific database tables used to track ingestion progress, source data, structural hierarchy, and derived knowledge graphs.
* [Knowledge Ingestion Tasks](concepts/system/knowledge-ingestion-tasks.md) - Referenced System in the source.
* [Knowledge Jobs](concepts/system/knowledge-jobs.md) - Processing units responsible for data handling and artifact management.
* [Knowledge Management System](concepts/system/knowledge-management-system.md) - System managing knowledge sources, ingestion, and retrieval capabilities.
* [Knowledge Processing Consent Flag](concepts/system/knowledge-processing-consent-flag.md) - Referenced system in the source.
* [Knowledge Retrieval Service](concepts/system/knowledge-retrieval-service.md) - A service responsible for retrieving knowledge, intended to replace legacy Markdown tree scans.
* [Knowledge Service](concepts/system/knowledge-service.md) - Referenced system in the source.
* [Knowledge Snapshots](concepts/system/knowledge-snapshots.md) - Referenced System in the source.
* [Knowledge Usage Events](concepts/system/knowledge-usage-events.md) - Referenced System in the source.
* [Knowledge Worker](concepts/system/knowledge-worker.md) - TypeScript worker responsible for processing knowledge ingestion jobs.
* [KnowledgeBundleExplorer.tsx](concepts/system/knowledgebundleexplorer-tsx.md) - Frontend component for visualizing knowledge bundles, featuring tabs for hierarchy, graph, evidence, processing, and cost.
* [KnowledgeBundleExplorer](concepts/system/knowledgebundleexplorer.md) - Referenced System in the source.
* [KnowledgePage.tsx](concepts/system/knowledgepage-tsx.md) - Frontend page for knowledge interaction with progress tracking and state management.
* [Langfuse](concepts/system/langfuse.md) - Referenced system in the source.
* [Legacy Knowledge Publisher](concepts/system/legacy-knowledge-publisher.md) - The current (legacy) mechanism for extracting document text, criticized for page-as-concept equating and limitation to 50 files.
* [Lexical Index System](concepts/system/lexical-index-system.md) - A retrieval mechanism utilizing normalized concept data for multilingual search.
* [Lexical Index](concepts/system/lexical-index.md) - A data retrieval mechanism for storing and searching normalized concept data.
* [Lexical Indexes](concepts/system/lexical-indexes.md) - A type of index relying on lexical properties.
* [Lexical Search System](concepts/system/lexical-search-system.md) - The initial multilingual search capability system using lexical methods.
* [lexical-vector-graph-signals](concepts/system/lexical-vector-graph-signals.md) - Referenced system in the source.
* [LLM Integration](concepts/system/llm-integration.md) - LLM integration layer for AI-driven processing.
* [LLM](concepts/system/llm.md) - LLM provider for map, reduce, and analysis tasks.
* [Local PostgreSQL](concepts/system/local-postgresql.md) - Relational database system used for local storage, requiring upgrade to PostgreSQL 16 with pgvector support.
* [Model-Assisted Output](concepts/system/model-assisted-output.md) - A record of output generated by a model, containing provenance and technical details.
* [Model-result caching](concepts/system/model-result-caching.md) - Referenced system in the source.
* [multilingual-boundary-benchmarks](concepts/system/multilingual-boundary-benchmarks.md) - Benchmark tests used to validate embedding models.
* [Neo4j](concepts/system/neo4j.md) - Referenced system in the source.
* [NetworkX](concepts/system/networkx.md) - A Python library for the creation, manipulation, and study of the structure, dynamics, and functions of complex networks.
* [Normalized Artifact](concepts/system/normalized-artifact.md) - The output of the normalization process, distinct from the final semantic OKF bundle.
* [OCR Policy](concepts/system/ocr-policy.md) - Referenced system in the source.
* [OKF bundle](concepts/system/okf-bundle.md) - The standard output format for the knowledge product.
* [OKF Directory](concepts/system/okf-directory.md) - Referenced System in the source.
* [OKF Enrichment Pipeline](concepts/system/okf-enrichment-pipeline.md) - The system responsible for converting source documents into an OKF-compliant knowledge structure.
* [OKF Generation](concepts/system/okf-generation.md) - Referenced system in the source.
* [OKF (Organized Knowledge Framework)](concepts/system/okf-organized-knowledge-framework.md) - The system for organizing knowledge, involving an enrichment pipeline that produces structured concepts, assertions, relationships, and summaries.
* [OKF v0.2 Bundle Emission](concepts/system/okf-v0-2-bundle-emission.md) - Referenced system in the source.
* [OKF v0.2 Specification](concepts/system/okf-v0-2-specification.md) - The specification for the Open Knowledge Format, version 0.2.
* [OKF v0.2](concepts/system/okf-v0-2.md) - The portable published format for knowledge bundles.
* [PDF Extractor](concepts/system/pdf-extractor.md) - A system or process for extracting content from PDF documents, specifically Stage 1: deterministic extraction.
* [Persistence Layer](concepts/system/persistence-layer.md) - Persistence layer for jobs, concepts, evidence, and graph data.
* [Persistence Model](concepts/system/persistence-model.md) - The database schema and strategy for storing knowledge ingestion data, using namespaced, immutable snapshots.
* [Persistence](concepts/system/persistence.md) - Database layer for job, concept, and graph data.
* [pg_trgm](concepts/system/pg-trgm.md) - Trigram extension for PostgreSQL, used as a baseline solution for text processing.
* [pgvector and pg_trgm](concepts/system/pgvector-and-pg-trgm.md) - Database extensions required for knowledge infrastructure.
* [pgvector](concepts/system/pgvector.md) - PostgreSQL extension for vector similarity search.
* [PostgreSQL Full-Text Search](concepts/system/postgresql-full-text-search.md) - PostgreSQL native full-text search capabilities for tokenization.
* [PostgreSQL pg_trgm](concepts/system/postgresql-pg-trgm.md) - A PostgreSQL extension providing trigram matching for lexical search.
* [PostgreSQL (pgvector)](concepts/system/postgresql-pgvector.md) - Referenced system in the source.
* [PostgreSQL Recursive CTEs](concepts/system/postgresql-recursive-ctes.md) - PostgreSQL Recursive Common Table Expressions used for graph traversal.
* [PostgreSQL](concepts/system/postgresql.md) - Database system used for storing runtime indexes derived from the OKF bundle.
* [processing-window](concepts/system/processing-window.md) - A unit of content processed by the system.
* [Progress](concepts/system/progress.md) - System for tracking live stages and progress.
* [Provenance Tracking](concepts/system/provenance-tracking.md) - System for tracking the origin and versioning of extracted data to ensure idempotency and re-use efficiency.
* [Publisher System](concepts/system/publisher-system.md) - The existing system responsible for document publishing.
* [Pydantic schemas and prompts](concepts/system/pydantic-schemas-and-prompts.md) - Referenced system in the source.
* [PyMuPDF](concepts/system/pymupdf.md) - A primary Python adapter for PDF text extraction.
* [PyPDF](concepts/system/pypdf.md) - A secondary Python adapter used for metadata and fallback extraction.
* [Python agent service](concepts/system/python-agent-service.md) - The processing plane service responsible for extraction, analysis, and ML-driven tasks.
* [python-docx](concepts/system/python-docx.md) - Referenced system in the source.
* [Redis Streams](concepts/system/redis-streams.md) - Referenced system in the source.
* [Redis](concepts/system/redis.md) - Cache service for live progress events; not required for job recovery.
* [Reducer](concepts/system/reducer.md) - The entity responsible for consolidating child outputs and resolving ambiguities or conflicts in the synthesis process.
* [Relational Adjacency Tables](concepts/system/relational-adjacency-tables.md) - Referenced system in the source.
* [Relationship and evidence validation](concepts/system/relationship-and-evidence-validation.md) - Referenced system in the source.
* [Retrieval Methodology](concepts/system/retrieval-methodology.md) - Referenced system in the source.
* [Retrieval Result Contract](concepts/system/retrieval-result-contract.md) - The structural format for retrieval operation results, including query, concepts, and evidence.
* [Retrieval Result JSON Schema](concepts/system/retrieval-result-json-schema.md) - Referenced system in the source.
* [Retrieval system](concepts/system/retrieval-system.md) - System for retrieving information using multiple signal types.
* [Runtime Indexes](concepts/system/runtime-indexes.md) - Computational structures derived from the OKF bundle.
* [Semantic Fallback Boundaries System](concepts/system/semantic-fallback-boundaries-system.md) - A mechanism for identifying document boundaries when headings are unreliable.
* [Semantic Retrieval System](concepts/system/semantic-retrieval-system.md) - Referenced System in the source.
* [semantic-state-store](concepts/system/semantic-state-store.md) - Referenced system in the source.
* [Snapshot Content](concepts/system/snapshot-content.md) - The set of data components included in the enrichment snapshot.
* [SourceBlock Schema](concepts/system/sourceblock-schema.md) - Schema definition for SourceBlock objects ensuring standardized output format.
* [Storage plane](concepts/system/storage-plane.md) - The storage architecture supporting persistence and state management.
* [Structured map extraction](concepts/system/structured-map-extraction.md) - Referenced system in the source.
* [System Additions](concepts/system/system-additions.md) - New technologies being introduced to the stack.
* [System Enrichment Pipeline](concepts/system/system-enrichment-pipeline.md) - The technical architecture and operational procedures governing the enrichment pipeline.
* [Target Architecture](concepts/system/target-architecture.md) - The pipeline design for processing documents into indexed knowledge.
* [Terminology System](concepts/system/terminology-system.md) - Definitions for technical terms used within the document system.
* [Three-Body PDF QC Case Study](concepts/system/three-body-pdf-qc-case-study.md) - Referenced system in the source.
* [Three-Body QC](concepts/system/three-body-qc.md) - Quality control system for PDF document processing.
* [Tracing System](concepts/system/tracing-system.md) - Tracing and evaluation system.
* [Tracing](concepts/system/tracing.md) - Tracing system for monitoring model performance.
* [TypeScript Backend](concepts/system/typescript-backend.md) - The backend service responsible for control plane operations in the target architecture.
* [TypeScript Knowledge Worker](concepts/system/typescript-knowledge-worker.md) - A dedicated worker process responsible for managing and processing knowledge enrichment tasks.
* [Usage/cost capture](concepts/system/usage-cost-capture.md) - Referenced system in the source.
* [Vector Database](concepts/system/vector-database.md) - Referenced system in the source.
* [Vector Search System](concepts/system/vector-search-system.md) - A system for semantic vector-based search using embeddings.
* [Workspace File Storage](concepts/system/workspace-file-storage.md) - Referenced system in the source.
* [Workspace Storage](concepts/system/workspace-storage.md) - Referenced system in the source.
* [Usage Report](concepts/systemfeature/usage-report.md) - A system-generated report produced after every task run, containing operational and cost metrics.
* [Elapsed time by stage](concepts/systemmetric/elapsed-time-by-stage.md) - Referenced SystemMetric in the source.
* [Embedding and OCR units](concepts/systemmetric/embedding-and-ocr-units.md) - Referenced SystemMetric in the source.
* [Estimated cost and rate-card version](concepts/systemmetric/estimated-cost-and-rate-card-version.md) - Referenced SystemMetric in the source.
* [Model call counts by stage](concepts/systemmetric/model-call-counts-by-stage.md) - Referenced SystemMetric in the source.
* [Retry and validation-repair counts](concepts/systemmetric/retry-and-validation-repair-counts.md) - Referenced SystemMetric in the source.
* [Token usage](concepts/systemmetric/token-usage.md) - Referenced SystemMetric in the source.
* [Admin Explorer](concepts/systems/admin-explorer.md) - Administrative interface for managing knowledge sources.
* [Knowledge Documentation System](concepts/systems/knowledge-documentation-system.md) - The overarching system for managing, enriching, and retrieving knowledge from documents.
* [Knowledge Source Card](concepts/systems/knowledge-source-card.md) - The dashboard or UI component showing progress and health metrics for the knowledge processing system.
* [Knowledge Workspace](concepts/systems/knowledge-workspace.md) - Referenced systems in the source.
* [Langfuse Tracing](concepts/systems/langfuse-tracing.md) - Tracing and observability system for AI operations.
* [OKF Bundle](concepts/systems/okf-bundle.md) - The published hierarchy of linked Markdown concept documents and indexes.
* [Target Architecture Pipeline](concepts/systems/target-architecture-pipeline.md) - The operational pipeline and data flow for converting source documents into structured knowledge.
* [Authorization](concepts/task/authorization.md) - Referenced Task in the source.
* [Extraction and Analysis Tasks](concepts/task/extraction-and-analysis-tasks.md) - Data processing operations performed by the internal agent endpoints.
* [Ingestion Job Lifecycle](concepts/task/ingestion-job-lifecycle.md) - Referenced Task in the source.
* [Publication Lifecycle](concepts/task/publication-lifecycle.md) - Referenced Task in the source.
* [Exact Phrase Search](concepts/technique/exact-phrase-search.md) - Referenced Technique in the source.
* [Full-Text Search](concepts/technique/full-text-search.md) - Referenced Technique in the source.
* [Trigram Search (pg_trgm)](concepts/technique/trigram-search-pg-trgm.md) - Referenced Technique in the source.
* [Agent Framework](concepts/technology/agent-framework.md) - Referenced technology in the source.
* [Astryx components](concepts/technology/astryx-components.md) - Referenced technology in the source.
* [Durable Task Orchestration](concepts/technology/durable-task-orchestration.md) - Referenced Technology in the source.
* [Elasticsearch/OpenSearch](concepts/technology/elasticsearch-opensearch.md) - Referenced technology in the source.
* [Express](concepts/technology/express.md) - Referenced technology in the source.
* [FastAPI](concepts/technology/fastapi.md) - Referenced technology in the source.
* [Gemini Lite](concepts/technology/gemini-lite.md) - Referenced technology in the source.
* [Kafka](concepts/technology/kafka.md) - Referenced technology in the source.
* [Knex](concepts/technology/knex.md) - Referenced technology in the source.
* [Langfuse](concepts/technology/langfuse.md) - Referenced technology in the source.
* [Neo4j](concepts/technology/neo4j.md) - Referenced technology in the source.
* [NetworkX](concepts/technology/networkx.md) - Referenced technology in the source.
* [Node.js/Express](concepts/technology/node-js-express.md) - Referenced technology in the source.
* [Node.js](concepts/technology/node-js.md) - Referenced technology in the source.
* [OCR Adapter Interface](concepts/technology/ocr-adapter-interface.md) - Referenced technology in the source.
* [pgvector](concepts/technology/pgvector.md) - Referenced technology in the source.
* [PostgreSQL/Knex](concepts/technology/postgresql-knex.md) - Referenced technology in the source.
* [PostgreSQL pg_trgm](concepts/technology/postgresql-pg-trgm.md) - Referenced technology in the source.
* [PostgreSQL recursive CTEs](concepts/technology/postgresql-recursive-ctes.md) - Referenced technology in the source.
* [PostgreSQL](concepts/technology/postgresql.md) - Referenced technology in the source.
* [Pydantic/JSON Schema](concepts/technology/pydantic-json-schema.md) - Referenced technology in the source.
* [Pydantic](concepts/technology/pydantic.md) - Referenced technology in the source.
* [PyMuPDF and OCR Adapters](concepts/technology/pymupdf-and-ocr-adapters.md) - Referenced Technology in the source.
* [PyMuPDF](concepts/technology/pymupdf.md) - Referenced technology in the source.
* [Python/FastAPI](concepts/technology/python-fastapi.md) - Referenced technology in the source.
* [Python](concepts/technology/python.md) - Referenced technology in the source.
* [React/TypeScript/Astryx](concepts/technology/react-typescript-astryx.md) - Referenced technology in the source.
* [React](concepts/technology/react.md) - Referenced technology in the source.
* [Redis Streams](concepts/technology/redis-streams.md) - Referenced technology in the source.
* [TypeScript](concepts/technology/typescript.md) - Referenced technology in the source.
* [Vector Database](concepts/technology/vector-database.md) - Referenced technology in the source.
* [Zod](concepts/technology/zod.md) - Referenced technology in the source.
* [Source-specific Test Fixtures](concepts/testing-tool/source-specific-test-fixtures.md) - Referenced Testing Tool in the source.
* [knowledge_navigation.py](concepts/tool/knowledge-navigation-py.md) - Tool for knowledge navigation using hybrid retrieval and evidence-read services.
* [Explorer Dashboard](concepts/user-interface/explorer-dashboard.md) - Referenced User Interface in the source.
* [PostgreSQL 16](concepts/version/postgresql-16.md) - Referenced version in the source.
