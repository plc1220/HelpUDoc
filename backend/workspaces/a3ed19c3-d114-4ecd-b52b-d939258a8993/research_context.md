# Research Context for BMMB Project AWAN Proposal

## 1. Executive Summary: Client & Strategic Alignment
*   **Client:** Bank Muamalat Malaysia Berhad (BMMB)
*   **Strategic Vision:** **RISE26+** (2022-2026).
    *   **Goal:** Become the "Strongest Islamic Bank in Malaysia."
    *   **Key Pillars:** Digital Agility, Customer Centricity, and Sustainability.
    *   **Proof Points:** Launch of **ATLAS** (Digital Banking App) and partnership with Google Cloud (announced for core banking migration and AI).
*   **Business Drivers for Project AWAN:**
    *   **Scalability:** Existing legacy infrastructure (MapR, SQL Server) cannot support the hyper-personalization and real-time analytics goals of RISE26+.
    *   **Time-to-Market:** "Slow reporting" and rigid data warehousing (Wherescape/SQL Server) hinder the "Agile Banking" aspiration.
    *   **Compliance:** Meeting BNM RMiT standards while modernizing.

## 2. Regulatory & Compliance Landscape (BNM RMiT/CTRAG)
*   **Core Policy:** BNM **Risk Management in Technology (RMiT)** & **CTRAG** (Cloud Technology Risk Assessment Guideline).
*   **Cloud Adoption Status:**
    *   **Critical Systems:** Must **consult** BNM before first adoption. Subsequent adoptions require **notification**.
    *   **Data Residency:** Offshore (e.g., Singapore) is **permitted** provided strict data sovereignty controls are in place.
    *   **Key Requirement (Data Sovereignty):** **Customer Managed Encryption Keys (CMEK)** are effectively mandatory. BMMB must hold the keys (HSM in Malaysia) to ensure "Right to Delete" and access control independent of Google.
*   **Network Resilience:**
    *   **"No Single Point of Failure":** Mandatory for critical workloads.
    *   **Solution:** Redundant **Dedicated Interconnects** (10Gbps+) via diverse physical paths.
*   **Google Cloud Malaysia Region:**
    *   **Status:** **Under Construction** (Groundbreaking Oct 2024). Not live for immediate 6-month migration.
    *   **Implication:** Proposal must position **Singapore Region (sg-west1)** as the primary target, with a future "Repatriation Strategy" to the MY region when live, or leverage **Google Distributed Cloud (GDC)** if "air-gapped" sovereignty is non-negotiable.

## 3. Technical Migration Strategy

### A. MapR to GCP (150TB Data Lake)
*   **MapR-FS (File System) -> Google Cloud Storage (GCS):**
    *   **Challenge:** MapR uses POSIX volumes; GCS uses object buckets.
    *   **Tooling:**
        *   **Storage Transfer Service (STS):** Recommended for petabyte-scale, preserves `mtime`, serverless.
        *   **DistCp:** Fallback for Hadoop-native workflows (requires tuning `mapreduce` memory).
    *   **Architecture:** Map MapR Volumes 1:1 to GCS Buckets. Flatten directory structures where possible to avoid object listing throttling.
*   **MapR-DB -> BigQuery / Bigtable:**
    *   **Binary Tables (HBase API):** Migrate to **Bigtable** (Lift & Shift via HBase Snapshots) or export to Parquet for **BigQuery** (Analytics).
    *   **JSON Tables (OJAI API):** Migrate to **BigQuery** (Native JSON type) using **Spark OJAI Connector** -> GCS (Parquet) -> BigQuery Load.

### B. Wherescape RED to BigQuery (The "Black Box" Fix)
*   **The Problem:** No direct automated tool exists to convert Wherescape's proprietary metadata and SQL Server Stored Procedures into BigQuery/Dataform.
*   **Proposed Solution: "Reverse Engineering Factory"**
    *   **Step 1 (Metadata Extraction):** Use Python to query Wherescape metadata tables (`ws_obj_object`, `ws_obj_dependency`, `ws_stage_tab`) to extract transformation logic and lineage.
    *   **Step 2 (Skeleton Generation):** Auto-generate **Dataform (.sqlx)** file structures (config blocks, inputs, outputs) from the metadata.
    *   **Step 3 (Logic Refactoring):** Manual engineering effort to convert procedural SQL (Cursors, Updates) into declarative BigQuery SQL (CTEs, Window Functions).
    *   **Step 4 (Validation):** Use **Datafold** to verify data parity between SQL Server and BigQuery.

## 4. Risk Assessment (6-Month Timeline)
| Risk Area | Risk Description | Mitigation Strategy |
| :--- | :--- | :--- |
| **Logic Migration** | **High:** Wherescape refactoring is complex. "Black Box" logic may hide critical business rules. | Deploy a "Reverse Engineering" script to automate 60% of boilerplate code. Focus manual effort only on complex Stored Procs. |
| **Data Residency** | **Medium:** MY Region is not live. Reliance on Singapore may trigger strict BNM scrutiny. | Implement **External Key Manager (EKM)** or **CMEK** with keys stored in Malaysia. Prepare a "Region Repatriation" roadmap. |
| **Network Delays** | **High:** Telco provisioning for Dedicated Interconnects often takes 3-4 months. | Initiate telco orders **immediately** (Day 1). Use Cloud VPN as a temporary dev/test bridge. |
| **Skill Gaps** | **Medium:** Client team knows MapR/SQL Server, not GCS/BigQuery. | Include a "Co-Innovation" workstream: Pair programming with CloudMile engineers for the first 3 months. |

## 5. Value Propositions to Highlight
1.  **"Future-Proofing":** Moving from proprietary MapR/Wherescape to open-standard BigQuery/Dataform aligns with RISE26+ "Agile Banking."
2.  **"Sovereignty by Design":** Proactive CMEK/EKM architecture addresses BNM concerns upfront, enabling immediate Singapore adoption.
3.  **"Automated Modernization":** Our custom "Wherescape Parser" methodology reduces manual migration time by ~40% (vs. manual rewrite).
