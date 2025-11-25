## 5. Assumptions

The successful execution and outcome of this 1-month Data Modernization Proof of Concept (PoC) for Tranglo Malaysia are predicated on the following key assumptions:

*   **Client Data Access**:
    *   Unrestricted and timely access to the on-premise SQL Server data warehouse, including necessary database credentials, schema information, and sample data for selected tables.
    *   Client will provide network connectivity (e.g., VPN tunnel, Cloud Interconnect) between their on-premise environment and GCP for secure data transfer.
*   **GCP Resources and Credentials**:
    *   Tranglo Malaysia will provide the necessary GCP project with appropriate billing setup and IAM permissions for CloudMile to provision and manage required GCP services (e.g., BigQuery, Cloud Storage, Dataflow, Pub/Sub, Cloud Composer).
    *   All required GCP APIs will be enabled within the designated project.
*   **Client Personnel Availability**:
    *   Key Tranglo Malaysia stakeholders, including data architects, database administrators, and business users, will be available for regular meetings, data validation, feedback, and knowledge transfer sessions as per the PoC timeline.
    *   Prompt responses to queries and requests for information will be provided by the client team to avoid delays.
*   **Scope of Data for PoC**:
    *   The PoC will focus on a clearly defined, limited set of dimension and transaction tables. The specific tables will be jointly agreed upon during the planning phase.
    *   The chosen tables are representative of the larger data estate and present the technical challenges (e.g., lack of timestamps for dimensions, high volume for transactions) that the PoC aims to address.
*   **Data Characteristics**:
    *   The data quality of the source SQL Server tables is assumed to be sufficient for the PoC; extensive data cleansing is out of scope for this PoC.
    *   Schema stability for the selected source tables during the PoC duration. Any changes would require re-evaluation and may impact the PoC timeline.
*   **Data Ingestion Approaches**:
    *   The daily full load approach for dimension tables (due to the absence of `timestamp` or `createdAt` columns) is an acceptable and agreed-upon strategy for the PoC.
    *   The Change Data Capture (CDC) append mode for transaction tables is technically feasible and supported by the existing on-prem SQL Server environment (e.g., SQL Server CDC features enabled) or a mutually agreed-upon third-party tool.
*   **Tooling and Technology**:
    *   The PoC will primarily utilize CloudMile's recommended GCP services and best practices. Any deviation requested by the client may impact the scope and timeline.
*   **Review and Approval**:
    *   Timely review and approval of deliverables (e.g., architecture design, pipeline implementations, validation reports) by Tranglo Malaysia stakeholders.
