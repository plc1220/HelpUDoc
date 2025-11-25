## 5. Assumptions & Out of Scope

This section outlines the critical assumptions and boundaries that define the scope of this Proof of Concept (PoC) engagement. Clear alignment on these items is essential for the successful and timely delivery of the data modernization project. These parameters ensure that CloudMile and the Client share a unified understanding of responsibilities, technical prerequisites, and project limitations.

### 5.1 Project Assumptions

The successful delivery of the solution described in this proposal is predicated on the following assumptions. Deviations from these assumptions may impact the project timeline, resource allocation, or cost.

#### 5.1.1 Technical & Connectivity Assumptions
*   **Wherescape Metadata Access:** A critical success factor for this migration PoC is the ability to programmatically access the existing Wherescape RED metadata repository. It is assumed that the Client will provide CloudMile with Read-Only access (via ODBC/JDBC) to the underlying metadata database. This allows CloudMile to utilize automated parsers to extract lineage, transformation logic, and table structures, thereby accelerating the conversion to BigQuery and Dataform.
*   **Interim VPN Connectivity:** To ensure immediate project kickoff while permanent networking solutions (such as Google Cloud Interconnect) are being procured or provisioned, the Client agrees to establish a Site-to-Site Cloud VPN connection. This interim solution will be used for the duration of the PoC to facilitate data transfer and system access. It is assumed this VPN will provide sufficient bandwidth for the agreed-upon PoC data volumes.
*   **Google Cloud Platform Environment:** The Client will provide a dedicated GCP Project with the necessary quotas and permissions enabled. CloudMile assumes the "Owner" or "Editor" role within this specific PoC project to configure BigQuery, Dataform, Dataproc, and IAM roles without administrative delays.
*   **Data Volume:** The data volume for this PoC is assumed to be within the standard range for a pilot phase (e.g., under 1TB) to ensure that data transfer times via VPN do not become a bottleneck.

#### 5.1.2 Stakeholder & Timing Assumptions
*   **Telco Operational Timing:** Recognizing the Client's operation within the Telecommunications sector, we assume the project schedule will need to align with specific maintenance windows and network freeze periods. The timeline proposed assumes that the Client will proactively communicate any "Blackout Dates" or restricted access periods related to Telco critical infrastructure updates so they can be factored into the project plan.
*   **Resource Availability:** The Client will identify a dedicated Technical Point of Contact (SPOC) who can facilitate access to source systems, approve architectural decisions, and participate in weekly status meetings.
*   **Source System Availability:** The on-premise SQL Server and Wherescape environments will be available during working hours for data extraction and analysis.

### 5.2 Out of Scope

To focus resources on the primary objectives of migrating the data warehouse to Google Cloud BigQuery and validating the modern data stack, the following items are explicitly excluded from the scope of this engagement.

#### 5.2.1 Application & Functional Exclusions
*   **Application Modernization:** This engagement focuses strictly on the Data Warehouse migration. The refactoring, re-architecting, or modernization of upstream operational applications or downstream consumption applications (e.g., custom web portals, legacy reporting tools) is out of scope. These applications will continue to function as-is, or will need to be repointed to BigQuery by the Client's team.
*   **Deep Data Cleansing:** The migration strategy is primarily a logical "lift-and-shift" with modernization of the transformation engine. We will migrate existing logic "as-is." Comprehensive data quality audits, deep historical data cleansing, or fixing inherent data anomalies present in the source system are out of scope unless they prevent the pipeline from running.
*   **BI Report Migration:** While we will enable the data layer for reporting, the actual migration or re-creation of dashboards and reports in visualization tools (e.g., migrating Tableau workbooks or SSRS reports to Looker) is not included in this PoC scope.

#### 5.2.2 Operational & Infrastructure Exclusions
*   **Production Deployment:** This is a Proof of Concept engagement. While the environment will be built following best practices, the formal "Go-Live" activities, production cutover, and decommissioning of the legacy hardware are reserved for a subsequent implementation phase.
*   **End-User Training:** Formal classroom training for broad end-user groups is out of scope. Knowledge transfer will be limited to the core technical team responsible for maintaining the new BigQuery and Dataform environment.
*   **Third-Party Licensing:** The procurement of licenses for any third-party tools (outside of Google Cloud native services) is the responsibility of the Client.
*   **Network Hardware:** CloudMile is not responsible for the procurement, installation, or configuration of physical networking hardware (routers, switches) at the Client's on-premise data center.

### 5.3 Risk Management
Any items identified during the discovery phase that fall into the "Out of Scope" category but are deemed critical for success will be raised immediately via a Change Request (CR) process to evaluate the impact on timeline and budget.
