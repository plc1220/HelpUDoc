## Section 1: Executive Summary

### 1.1 Strategic Alignment with RISE26+

Bank Muamalat Malaysia Berhad (BMMB) stands at a pivotal juncture in its digital transformation journey. To realize the ambitious goals of the **RISE26+ strategy**, specifically the pillars of Digitalization and Operational Resilience, the bank requires a robust, scalable, and intelligent data infrastructure. **Project AWAN** represents not merely a technical migration, but a strategic leap forward, transitioning BMMB from legacy constraints to a cloud-native future on **Google Cloud Platform (GCP)**.

CloudMile is honored to propose a comprehensive "Migrate & Modernize" strategy designed to secure BMMB’s data assets while unlocking new value through advanced analytics and AI. This proposal outlines our approach to retiring the legacy MapR ecosystem and SQL Server operational data stores (ODS) in favor of a unified, **RMiT-compliant** Data Cloud foundation.

### 1.2 The Critical Urgency: Mitigating MapR End-of-Life Risks

The immediate driver for Project AWAN is the critical End-of-Life (EOL) status of the existing MapR platform, which creates a significant operational risk within the next **six months**. Continued reliance on unsupported infrastructure threatens system stability, security posture, and regulatory compliance.

Our proposal addresses this urgency head-on with a rapid, phased migration plan. We prioritize the stabilization of critical data workloads by migrating them to **Google Cloud Storage** and **Dataproc**, ensuring business continuity. Simultaneously, we lay the groundwork for modernizing these workloads into **BigQuery**, Google’s serverless enterprise data warehouse, to eliminate future infrastructure management overhead and reduce total cost of ownership (TCO).

### 1.3 The Solution: A Secure, Intelligent Data Cloud

CloudMile proposes a dual-track architecture that balances speed of migration with long-term modernization:

1.  **Secure Data Lake Foundation:** Leveraging **Cloud Storage** for durable, low-cost object storage and **Dataproc** to replicate existing Hadoop/Spark workloads with minimal code changes. This ensures a seamless transition away from MapR.
2.  **Modern Data Warehouse:** Establishing **BigQuery** as the central source of truth. BigQuery’s separation of compute and storage, combined with its high-speed in-memory BI Engine, will drastically reduce query times for end-users.
3.  **Advanced Analytics & AI:** Enabling BMMB to move beyond descriptive reporting. With **BigQuery Machine Learning (BQML)**, data teams can build and execute machine learning models directly within the database using standard SQL, accelerating the time-to-insight for credit scoring, fraud detection, and customer segmentation. **Looker** (or Looker Studio) will serve as the visualization layer, democratizing data access across the bank.

### 1.4 Addressing the 'Black Box': Wherescape Modernization

A key complexity in BMMB's current environment is the reliance on Wherescape for data automation, often operating as a "Black Box" with opaque logic and dependencies. Our approach involves a meticulous reverse-engineering and modernization phase. We will:
*   Decouple data logic from proprietary Wherescape metadata.
*   Re-implement transformation pipelines using **Dataform** or **Cloud Composer** (Airflow), providing BMMB with open, version-controlled, and transparent data lineages.
*   Ensure that the migration of these automated jobs maintains data integrity and meets the stringent SLAs required for daily reporting.

### 1.5 Security and Compliance (RMiT)

Adhering to Bank Negara Malaysia’s **Risk Management in Technology (RMiT)** guidelines is paramount. Our solution utilizes a "Security by Design" framework, incorporating:
*   **Identity and Access Management (IAM)** with least-privilege principles.
*   **Data Encryption** at rest and in transit (using Cloud KMS).
*   **VPC Service Controls** to define security perimeters around sensitive data resources.
*   Detailed audit logging via **Cloud Logging** and **Cloud Monitoring** to ensure full traceability of data access and modifications.

### 1.6 Conclusion

CloudMile’s proposal for Project AWAN offers BMMB a definitive path to mitigate the immediate risks of the MapR EOL while establishing a future-proof data ecosystem. By partnering with CloudMile, BMMB will not only secure its current operations but also empower its workforce with the cloud-native tools necessary to drive innovation, personalize customer experiences, and achieve the strategic milestones of RISE26+.

We are committed to delivering this transformation within the 6-month timeline, ensuring a seamless transition with zero disruption to the bank’s critical services.
