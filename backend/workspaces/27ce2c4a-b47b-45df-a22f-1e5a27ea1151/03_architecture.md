## High-Level Architecture for Data Modernization PoC

The proposed architecture outlines a robust, scalable, and secure data modernization platform on Google Cloud Platform (GCP) for Tranglo Malaysia. This high-level design focuses on ingesting diverse data types from on-premise SQL Server databases, transforming them, and making them available for advanced analytics and business intelligence. The architecture is built with a strong emphasis on automation, governance, and future scalability, leveraging key GCP services to ensure an efficient and reliable data pipeline.

### Data Ingestion Layer

The initial phase involves establishing secure and efficient data ingestion from on-premise SQL Server. For **dimension tables**, which typically undergo daily full loads, a batch-oriented approach will be employed. Data will be extracted from the SQL Server, potentially using existing ETL tools or custom scripts, and landed securely into **Cloud Storage**. From Cloud Storage, **Dataflow** (or **Data Fusion** for a more visual, managed ETL experience) will be utilized to process these batch loads, performing initial cleansing and schema enforcement before ingesting them into a raw layer within **BigQuery**.

For **transaction tables**, which require near real-time updates and are sensitive to data freshness, a Change Data Capture (CDC) strategy will be implemented. An on-premise CDC mechanism (e.g., Debezium, a commercial CDC solution, or SQL Server’s native CDC capabilities) will capture data changes (inserts, updates, deletes). These events will be published to **Pub/Sub**, acting as a highly scalable message queuing service. A streaming **Dataflow** pipeline will subscribe to these Pub/Sub topics, process the incoming events in an append-only mode, and land them into a raw transaction table in **BigQuery**. This ensures that transactional data is available for analysis with minimal latency, supporting operational reporting and timely insights. Cloud Storage will also serve as a durable landing zone for raw CDC streams before processing by Dataflow, offering cost-effective storage and disaster recovery capabilities.

### Data Processing and Storage Layer

Once raw data resides in BigQuery and Cloud Storage, the next step involves transformation and curation. **BigQuery** serves as the central analytical data warehouse, designed for petabyte-scale data analysis with unparalleled speed and efficiency. Raw data, whether from batch or streaming ingestion, will first land in dedicated raw datasets within BigQuery.

Data transformation pipelines will be orchestrated using **Cloud Composer** (managed Apache Airflow) to define, schedule, and monitor complex workflows. These workflows will trigger **Dataform** jobs, allowing for SQL-based data transformation directly within BigQuery. Dataform promotes software engineering best practices for data teams, enabling version control, testing, and documentation of data transformations. This ensures data quality, consistency, and traceability as data is refined from raw to curated layers within BigQuery. Datasets will be structured into raw, staging, and curated layers, with the curated layer optimized for business intelligence and advanced analytics. For extremely large-scale, complex transformations or machine learning feature engineering that might require custom code execution beyond SQL, **Dataproc** clusters can be spun up on demand to process data stored in Cloud Storage or BigQuery.

### Analytics and Visualization Layer

The curated data in BigQuery becomes the single source of truth for analytics. **BigQuery ML (BQML)** will be leveraged to build and deploy machine learning models directly within BigQuery using standard SQL queries, enabling predictive analytics without moving data to separate ML platforms. This simplifies the ML workflow and accelerates time-to-insight for use cases like fraud detection, customer churn prediction, or demand forecasting.

For business intelligence and data visualization, **Looker** will connect directly to BigQuery. Looker provides a modern, intuitive platform for exploring data, creating interactive dashboards, and delivering actionable insights to business users. Its semantic modeling layer (LookML) ensures consistent metrics and definitions across the organization, fostering data literacy and self-service analytics.

### Architecture Diagram

```mermaid
graph LR
    subgraph On-Premise
        A[SQL Server Databases]
        B(CDC Mechanism)
    end

    subgraph Secure Connectivity
        C(Cloud VPN / Interconnect)
    end

    subgraph Ingestion & Landing
        A -- Daily Full Load (Dimension Tables) --> C
        C -- Batch Extract --> D[Cloud Storage (Raw Landing)]
        D -- Dataflow (Batch) / Data Fusion --> F[BigQuery (Raw Layer)]

        A -- Transactional Data (CDC) --> B
        B -- Real-time Events --> E[Pub/Sub]
        E -- Streaming --> G[Dataflow (Streaming)]
        G -- Append Mode --> H[Cloud Storage (Raw CDC Streams)]
        H -- Real-time Ingestion --> F

    end

    subgraph Transformation & Orchestration
        F -- Data Transformation (SQL) --> I[Dataform]
        I -- Curated Datasets --> J[BigQuery (Curated Layer)]
        K[Cloud Composer (Orchestration)] -- Triggers --> I
        K -- Manages --> G
        K -- Manages --> D
        J -- Complex Processing / Feature Engineering --> L[Dataproc (Optional)]
    end

    subgraph Analytics & Visualization
        J -- ML Models --> M[BQML]
        J -- Business Intelligence --> N[Looker Dashboards]
        L -- Advanced Analytics --> N
        M -- Insights --> N
    end

    style A fill:#f9f,stroke:#333,stroke-width:2px
    style B fill:#f9f,stroke:#333,stroke-width:2px
    style C fill:#ccf,stroke:#333,stroke-width:2px
    style D fill:#bbf,stroke:#333,stroke-width:2px
    style E fill:#fcf,stroke:#333,stroke-width:2px
    style F fill:#88f,stroke:#333,stroke-width:2px
    style G fill:#fcf,stroke:#333,stroke-width:2px
    style H fill:#bbf,stroke:#333,stroke-width:2px
    style I fill:#cdf,stroke:#333,stroke-width:2px
    style J fill:#88f,stroke:#333,stroke-width:2px
    style K fill:#ccf,stroke:#333,stroke-width:2px
    style L fill:#fcf,stroke:#333,stroke-width:2px
    style M fill:#fcf,stroke:#333,stroke-width:2px
    style N fill:#afa,stroke:#333,stroke-width:2px
```