## 3. Proposed Target Architecture

### 3.1 Architecture Overview

CloudMile proposes a modern, scalable, and serverless data platform architecture on Google Cloud Platform (GCP) designed to address the challenges of the current on-premises environment. This "To-Be" architecture leverages the power of the Data Cloud to decouple storage from compute, enabling elastic scaling and cost optimization while providing a unified view of data across the enterprise.

The architecture follows a Lakehouse paradigm, utilizing **Cloud Storage** as the scalable data lake for raw ingestion and **BigQuery** as the highly performant serverless data warehouse. This approach allows for the migration of legacy MapR workloads and SQL Server data into a centralized, governed environment.

### 3.2 Architectural Diagram

The following diagram illustrates the high-level data flow from on-premises source systems through the GCP ingestion, processing, and serving layers.

```mermaid
graph TD
    subgraph "On-Premises Data Sources"
        MapR[MapR Hadoop Cluster]
        SQL[SQL Server]
    end

    subgraph "Hybrid Connectivity"
        Interconnect[Cloud Interconnect]
    end

    subgraph "Google Cloud Platform"
        subgraph "Ingestion & Data Lake"
            GCS[Cloud Storage (GCS)<br/>Raw Landing Zone]
        end

        subgraph "Processing & Transformation"
            Dataproc[Dataproc<br/>Spark Migrations]
            Dataform[Dataform<br/>SQL Pipelines]
            BQ[BigQuery<br/>Enterprise Data Warehouse]
            BQML[BigQuery ML<br/>Predictive Models]
        end

        subgraph "Serving & Analytics"
        Looker[Looker<br/>Business Intelligence]
        end
    end

    %% Flows
    MapR -->|Batch/Streaming| Interconnect
    SQL -->|CDC/Batch| Interconnect
    Interconnect --> GCS
    
    GCS -->|Load| BQ
    GCS -->|Process| Dataproc
    Dataproc -->|Write| BQ
    
    BQ <-->|Transform| Dataform
    BQ -->|Train/Predict| BQML
    
    BQ -->|Query| Looker
    
    classDef cloud fill:#e8f0fe,stroke:#4285f4,stroke-width:2px;
    classDef onprem fill:#fce8e6,stroke:#ea4335,stroke-width:2px;
    classDef network fill:#e6f4ea,stroke:#34a853,stroke-width:2px;
    
    class GCS,Dataproc,Dataform,BQ,BQML,Looker cloud;
    class MapR,SQL onprem;
    class Interconnect network;
```

### 3.3 Component Detail

#### 3.3.1 Ingestion Layer
To ensure secure and high-throughput connectivity between the on-premises data center and GCP, **Cloud Interconnect** (Dedicated or Partner) will serve as the backbone network. This establishes a private, low-latency connection essential for transferring large volumes of historical data from MapR and continuous updates from SQL Server.
*   **Batch Ingestion:** Historical data and periodic snapshots will be transferred directly to **Cloud Storage (GCS)** buckets.
*   **Streaming Ingestion:** For real-time requirements, **Pub/Sub** can be introduced to capture event streams, acting as a buffer before downstream processing.

#### 3.3.2 Storage Layer
The architecture employs a multi-tiered storage strategy:
*   **Cloud Storage (GCS):** Acts as the immutable Raw Landing Zone (Data Lake). It stores data in its native format (Parquet, Avro, CSV) effectively replacing the HDFS storage component of MapR. GCS offers high durability and cost-effective lifecycle management.
*   **BigQuery:** Serves as the central Enterprise Data Warehouse. It separates storage from compute, allowing the client to store petabytes of data without provisioning resources. BigQuery's columnar storage format is optimized for analytical queries.

#### 3.3.3 Processing & Transformation Layer
Processing is handled by fit-for-purpose compute engines:
*   **Dataproc:** A fully managed Spark and Hadoop service used to lift-and-shift existing complex Spark jobs from the MapR cluster. This minimizes code refactoring during the initial migration phase. Dataproc clusters are ephemeral, spun up for specific jobs and terminated afterwards to save costs.
*   **BigQuery & Dataform:** For ELT (Extract, Load, Transform) workflows, we utilize BigQuery's native SQL capabilities managed by **Dataform**. Dataform allows data engineers to build reliable, version-controlled SQL pipelines, handling dependency management and testing directly within the warehouse.
*   **BigQuery ML (BQML):** Machine learning models are developed and executed directly within BigQuery using standard SQL. This eliminates the need to move data out of the warehouse for training, significantly reducing complexity and latency for predictive analytics use cases.

#### 3.3.4 Serving Layer
The serving layer democratizes access to insights:
*   **Looker:** As the primary enterprise BI platform, Looker connects directly to BigQuery. Unlike traditional BI tools that require data extraction (cubes or extracts), Looker leverages BigQuery’s processing power to query live data. It provides a semantic modeling layer (LookML) ensuring consistent metric definitions (single source of truth) across all dashboards and reports.

#### 3.3.5 Security & Governance
Security is woven into every layer of the architecture, adhering to the principle of least privilege:
*   **Identity & Access Management (IAM):** Granular access control for all GCP resources.
*   **Encryption:** Data is encrypted by default at rest (AES-256) and in transit.
*   **VPC Service Controls:** Defines a security perimeter around Google Cloud resources to mitigate data exfiltration risks.
*   **BigQuery Security:** Implements column-level and row-level security to restrict access to sensitive PII data based on user roles.

This architecture ensures scalability to handle future data growth, agility to accelerate time-to-insight through serverless technologies, and robust security to meet enterprise compliance standards.