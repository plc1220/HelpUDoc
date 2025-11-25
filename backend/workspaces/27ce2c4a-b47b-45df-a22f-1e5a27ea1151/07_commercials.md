## 7. Commercials

This section outlines the estimated commercial aspects for the 1-month Data Modernization Proof of Concept (PoC) for Tranglo Malaysia. This is a high-level estimate, and final costs will be subject to a detailed statement of work (SOW) based on refined scope and client-specific requirements.

### CloudMile Service Fees

CloudMile's professional services for the 1-month PoC are estimated based on the dedicated effort required for planning, architecture design, implementation, testing, knowledge transfer, and project management.

*   **Consulting & Architecture Design**: Covers initial assessment, solution design, and architectural guidance.
*   **Implementation & Development**: Covers pipeline development for data ingestion (both full load for dimensions and CDC for transactions), transformation, and basic reporting setup.
*   **Testing & Validation**: Covers data quality checks, performance testing, and bug fixing within the PoC scope.
*   **Project Management & Knowledge Transfer**: Covers overall PoC coordination, client communication, documentation, and training.

**Estimated CloudMile Service Fees for PoC**: [e.g., RM 50,000 - RM 80,000]

### Estimated GCP Infrastructure Costs

The GCP infrastructure costs during the 1-month PoC are estimates and will vary based on actual usage, data volumes processed, and specific service configurations. CloudMile will assist in optimizing these costs throughout the PoC.

*   **BigQuery**: Storage for migrated data, query processing (on-demand or flat-rate, PoC likely on-demand). Costs depend on data stored and queries executed.
*   **Cloud Storage**: Landing zone for data ingestion, staging area. Costs depend on data stored and network egress.
*   **Dataflow / Data Fusion**: For ETL/ELT pipelines, especially for CDC and complex transformations. Costs are based on processing time and resource usage (CPU, memory).
*   **Cloud Composer**: For orchestration of data pipelines (if used). Costs based on environment size and uptime.
*   **Networking**: Data transfer costs between on-prem and GCP, and within GCP services.
*   **Other Services**: Minor costs for logging, monitoring, and potentially Cloud SQL if used for specific connectors.

**Estimated GCP Infrastructure Costs for PoC**: [e.g., RM 5,000 - RM 15,000]

*Note: These GCP costs are estimates. Actual costs depend heavily on the selected data subsets, processing frequency, and resource configurations. CloudMile will work with Tranglo Malaysia to monitor and manage these costs.*

### Total Estimated PoC Cost

**Total Estimated PoC Cost (CloudMile Services + GCP Infrastructure)**: [e.g., RM 55,000 - RM 95,000]

### Commercial Terms

*   **Payment Schedule**: To be mutually agreed upon, typically involving an upfront payment and a final payment upon PoC completion and sign-off.
*   **Invoicing**: CloudMile will invoice Tranglo Malaysia directly for its services. GCP costs will be billed directly by Google Cloud to Tranglo Malaysia's linked billing account.
*   **Out of Scope**: Costs for any additional software licenses not explicitly mentioned, extensive data cleansing activities, and full-scale migration beyond the PoC scope are not included in this estimate.
*   **Validity**: This commercial estimate is valid for [e.g., 30 days] from the date of issuance.

This PoC represents an investment to de-risk a larger data modernization initiative, providing a clear path and validated architecture for future phases.
