# Research Context for Tranglo Malaysia Data Modernization PoC

## Client and Project Overview:
- Client: Tranglo Malaysia
- Project: Data Modernization Proof of Concept (PoC)
- Objective: Migrating data warehouse from on-premise SQL Server to Google Cloud Platform (GCP).
- PoC Duration: 1 month

## Key Technical Challenges & Requirements:
- **Dimension Tables:**
    - Issue: Data lacks `timestamp` or `createdAt` columns.
    - Implication: Batch incremental loading is not viable.
    - Proposed Solution: Daily full load and truncate/drop.
- **Transaction Tables:**
    - Proposed Solution: Change Data Capture (CDC) in append mode.

## GCP Stack Exploration:
- The client is exploring GCP stacks, implying a need to recommend and integrate appropriate GCP services for data warehousing, ETL/ELT, and potentially other related services.

## High-Level Requirements:
1.  **Data Ingestion:** Efficiently move data from on-prem SQL Server to GCP, handling both dimension and transaction table specific requirements.
2.  **Data Storage:** Establish a scalable and cost-effective data warehouse on GCP.
3.  **Data Processing:** Transform and prepare data for consumption.
4.  **Data Consumption:** Enable reporting and analytics.
5.  **Security & Compliance:** Ensure data security and compliance with relevant regulations.

## Potential GCP Services to Consider:
- **Data Ingestion:**
    - Cloud Data Fusion (for CDC, ETL)
    - Cloud Pub/Sub (for streaming data from CDC)
    - Storage Transfer Service (for bulk transfer)
    - Database Migration Service (for initial load)
- **Data Storage:**
    - BigQuery (primary data warehouse)
    - Cloud Storage (landing zone, data lake)
- **Data Processing/Transformation:**
    - Dataflow (for complex transformations, streaming data)
    - Dataproc (for Spark/Hadoop workloads)
    - BigQuery (for SQL-based transformations)
- **Orchestration:**
    - Cloud Composer (Apache Airflow on GCP)
- **Monitoring & Logging:**
    - Cloud Monitoring
    - Cloud Logging

## Architecture Considerations:
- Hybrid cloud approach during migration.
- Scalability and cost-optimization.
- Automation of data pipelines.

## Success Criteria (Implicit from PoC nature):
- Successful migration and processing of selected dimension and transaction tables.
- Demonstrated viability of the proposed GCP stack and architectural patterns.
- Performance and cost considerations.