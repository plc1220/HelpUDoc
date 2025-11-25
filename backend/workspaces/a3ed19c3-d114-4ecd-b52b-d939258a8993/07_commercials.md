## 7. Commercial Model & Total Cost of Ownership (TCO)

### 7.1 Executive Summary of Commercial Value
Transitioning from a legacy on-premises architecture—anchored by capital-intensive MapR clusters and Microsoft SQL Server licensing—to a cloud-native Google Cloud Platform (GCP) environment represents a fundamental shift in the organization's financial and operational model. This proposal outlines the commercial benefits of adopting a serverless, consumption-based model, highlighting the move from Capital Expenditure (CapEx) to Operational Expenditure (OpEx).

By leveraging Google Cloud’s fully managed services, specifically BigQuery, Dataflow, and Cloud Storage, the client will eliminate the rigid costs associated with hardware procurement, maintenance contracts, and over-provisioned infrastructure. The projected Total Cost of Ownership (TCO) reduction is driven not only by lower direct infrastructure costs but also by significant gains in engineering productivity and the elimination of "undifferentiated heavy lifting" associated with managing physical data centers.

### 7.2 Shifting from CapEx to OpEx
The traditional on-premises model requires substantial upfront investment in hardware and software licenses to handle peak capacity, often resulting in underutilized resources during non-peak periods. The proposed GCP solution shifts this paradigm to a flexible OpEx model.

| Cost Category | Legacy On-Premises (MapR / SQL Server) | Google Cloud Platform (BigQuery / Dataflow) |
|---------------|----------------------------------------|---------------------------------------------|
| **Investment Model** | **CapEx**: Upfront purchase of servers, storage arrays, and multi-year software licenses. | **OpEx**: Pay-as-you-go pricing based on actual consumption (storage GBs, compute slots/seconds). |
| **Scalability Cost** | Step-function costs; adding capacity requires purchasing new hardware nodes and licenses. | Linear scaling; costs align perfectly with data volume and query complexity. |
| **Utilization** | Paid capacity often sits idle (over-provisioned for peaks). | Zero cost for idle compute; auto-scaling ensures payment only for active processing. |
| **Licensing** | Expensive enterprise cores for SQL Server and MapR subscriptions. | No licensing fees; cost includes fully managed service capabilities. |

### 7.3 TCO Savings Breakdown

#### 7.3.1 Elimination of Licensing Costs
A significant portion of the current TCO is attributed to enterprise software licensing. SQL Server Enterprise Edition and MapR enterprise subscriptions carry heavy annual renewal costs.
*   **BigQuery:** operates on a serverless model where there are no license fees. The client pays for data storage (active and long-term) and query processing (analysis). This eliminates the "software tax" and frees up budget for innovation.
*   **Dataproc:** For workloads migrating from MapR, Dataproc offers managed Hadoop/Spark clusters that can be ephemeral (spun up for a job and shut down immediately), drastically reducing the compute hours compared to an always-on on-prem cluster.

#### 7.3.2 Reduction in Administrative Overhead
The hidden costs of on-premises infrastructure include the engineering hours spent on patching, upgrades, backups, and hardware replacement cycles.
*   **Fully Managed Services:** BigQuery and Dataflow are serverless. Google handles all backend infrastructure, security patches, and upgrades. This allows the client's IT team to pivot from "keeping the lights on" to delivering business value through data engineering and analytics.
*   **High Availability & DR:** Disaster recovery in an on-prem world requires duplicate hardware and complex replication setup. In GCP, geo-redundant Cloud Storage and BigQuery's inherent replication provide high availability by default, removing the cost of maintaining a secondary physical DR site.

#### 7.3.3 Infrastructure Optimization
*   **Storage Efficiency:** Cloud Storage offers different tiers (Standard, Nearline, Coldline, Archive). Rarely accessed data from the legacy SQL Server archives can be moved to Coldline storage at a fraction of the cost of high-performance on-prem SAN/NAS storage.
*   **Compute efficiency:** With BigQuery's separation of compute and storage, the client is not forced to buy compute power just to store more data.

### 7.4 BigQuery Pricing Strategy
To optimize the commercial model further, CloudMile recommends a hybrid pricing approach for BigQuery:

1.  **On-Demand Pricing (Start):** For the initial phase and ad-hoc analytics, the client pays per TB of data processed. This is ideal for variable workloads and ensures zero waste during low-usage periods.
2.  **Capacity Pricing (Editions):** As workloads mature and become predictable (e.g., daily scheduled ETL jobs from Dataflow), we can switch to BigQuery Editions (Standard, Enterprise, Enterprise Plus). This allows the purchase of committed "slots" (virtual CPUs) for flat-rate predictability, preventing cost spikes.

### 7.5 Conclusion
The migration to Google Cloud Platform offers a compelling ROI. By retiring aging hardware and expiring licenses associated with MapR and SQL Server, the client effectively converts fixed, depreciating assets into a flexible, optimized operational expense. CloudMile estimates that this modernization will result in a **30% to 45% reduction in 3-year TCO**, primarily driven by the elimination of licensing fees, reduction in administrative labor, and the efficiency of autoscaling cloud infrastructure.
