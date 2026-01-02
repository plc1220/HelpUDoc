# RAG Query Scenarios

Workspace: `e48581c6-07b9-48c0-b292-58d3c10dc032`
File: `STATEMENT OF WORK for Phase 0 1.0.pdf`

## naive_context

- mode: `naive`
- query: `requirements list and points that require extra care`
- api: `query`


```text
Document Chunks (Each entry has a reference_id refer to the `Reference Document List`):

```json
{"reference_id": "1", "content": "SOURCE: /STATEMENT OF WORK for Phase 0 1.0.pdf\n\nSTATEMENT OF WORK (SOW) – Phase 0 \n\nProject: Datalake & EDW Migration – Migration of Selected Tables to Google BigQuery and daily data ingestion. \n\nDuration: 1 Month \n\n1. Introduction \n\nThis Statement of Work (SOW) defines the scope, objectives, requirements, deliverables, and success criteria for performing a Phase 0 to migrate selected datasets from the existing MapR- Datalake and EDW environment to Google Cloud Platform (GCP) with BigQuery as the target data warehouse. \n\nThis phase aims to validate the feasibility, performance, compatibility, and end-to-end data migration approach from the current on-premise ecosystem to BigQuery. \n\n2. Objectives \n\nThe key objectives of this phase include: \n\n1. Validate the data migration pipeline from source systems (MapR Datalake & EDW) to Google BigQuery.   \n2. Assess compatibility of current ingestion, staging, transformation, and consumption layers.   \n3. Validate schema design, data quality, file format, and reconciliation approach.   \n4. Eval...
```

## hybrid_context

- mode: `hybrid`
- query: `requirements list and points that require extra care`
- api: `query`


```text
Knowledge Graph Data (Entity):

```json
{"entity": "table_d41d8cd98f00b204e9800998ecf8427e", "type": "table", "description": ""}
{"entity": "discarded_d41d8cd98f00b204e9800998ecf8427e", "type": "discarded", "description": ""}
```

Knowledge Graph Data (Relationship):

```json

```

Document Chunks (Each entry has a reference_id refer to the `Reference Document List`):

```json
{"reference_id": "1", "content": "Table Analysis:\nImage Path: \nCaption: None\nStructure: \nFootnotes: None\n\nAnalysis: "}
{"reference_id": "1", "content": "Discarded Content Analysis:\nContent: {'type': 'discarded', 'text': '6 ', 'bbox': [868, 929, 880, 939], 'page_idx': 5}\n\nAnalysis: "}
```

Reference Document List (Each entry starts with a [reference_id] that corresponds to entries in the Document Chunks):

```
[1] STATEMENT OF WORK for Phase 0 1.0.pdf
```
```

## naive_data

- mode: `naive`
- query: `requirements list and points that require extra care`
- api: `query_data`

chunks: 1

```text
SOURCE: /STATEMENT OF WORK for Phase 0 1.0.pdf

STATEMENT OF WORK (SOW) – Phase 0 

Project: Datalake & EDW Migration – Migration of Selected Tables to Google BigQuery and daily data ingestion. 

Duration: 1 Month 

1. Introduction 

This Statement of Work (SOW) defines the scope, objectives, requirements, deliverables, and success criteria for performing a Phase 0 to migrate selected datasets from the existing MapR- Datalake and EDW environment to Google Cloud Platform (GCP) with BigQuery as the target data warehouse. 

This phase aims to validate the feasibility, performance, compatibility, and end-to-end data migration approach from the current on-premise ecosystem to BigQuery. 

2. Objectives 

The key objectives of this phase include: 

1. Validate the data migration pipeline from sou...
```

## hybrid_data

- mode: `hybrid`
- query: `requirements list and points that require extra care`
- api: `query_data`

chunks: 0

(no chunks)

## naive_title_query

- mode: `naive`
- query: `Statement of Work Phase 0`
- api: `query_data`

chunks: 1

```text
SOURCE: /STATEMENT OF WORK for Phase 0 1.0.pdf

STATEMENT OF WORK (SOW) – Phase 0 

Project: Datalake & EDW Migration – Migration of Selected Tables to Google BigQuery and daily data ingestion. 

Duration: 1 Month 

1. Introduction 

This Statement of Work (SOW) defines the scope, objectives, requirements, deliverables, and success criteria for performing a Phase 0 to migrate selected datasets from the existing MapR- Datalake and EDW environment to Google Cloud Platform (GCP) with BigQuery as the target data warehouse. 

This phase aims to validate the feasibility, performance, compatibility, and end-to-end data migration approach from the current on-premise ecosystem to BigQuery. 

2. Objectives 

The key objectives of this phase include: 

1. Validate the data migration pipeline from sou...
```

## hybrid_title_query

- mode: `hybrid`
- query: `Statement of Work Phase 0`
- api: `query_data`

chunks: 2

```text
Discarded Content Analysis:
Content: {'type': 'discarded', 'text': '6 ', 'bbox': [868, 929, 880, 939], 'page_idx': 5}

Analysis:
```
