**Statement of Work**

**Google Cloud Agentspace Pilot**

This Statement of Work (“SOW”) is executed 23 April, 2025 (“SOW Execution Date”) between CloudMile (“Partner”) and Sime Darby Property (“Customer”), and is entered into pursuant to the terms of the Master Professional Services Agreement dated 23 April, 2025 (the “Agreement”). Any terms used in this SOW and not otherwise defined herein shall have the definitions assigned to such terms in the Agreement. Partner has agreed to perform Services and provide certain Deliverables to Customer as contemplated and stated below in this SOW. Any services performed or deliverables provided to Customer prior to the Execution Date that are related to the Services or Deliverables detailed in this SOW are subject to the same terms and conditions set forth in this SOW and the Agreement. Except as otherwise permitted by the Agreement, in case of any conflict between this SOW and the Agreement, the Agreement shall control.

The Parties hereby agree as follows:

# **1. SOW Point of Contacts**

The point of contacts for this SOW shall be:

| CloudMile |  |
| :---- | :---- |
| Name: | Lester Leong |
| Phone: | +6012-773 8915 |
| Address: | Level 15, The Gardens South Tower, Mid Valley City, 59200, Kuala Lumpur, Malaysia |
| E-Mail: | lester.leong@mile.cloud |

| Customer |  |
| :---- | :---- |
| Name: | Sime Darby Property |
| Phone: | \[Customer Phone] |
| Address: | \[Customer Address] |
| E-Mail: | \[Customer E-Mail] |

# **2. Term**

The Term of this SOW will begin on the SOW Effective Date (as defined below) and shall continue until an estimated end date of 28 November 2025 (“Term”), pending acceptance of all deliverables, unless earlier terminated by a Party or the Parties in accordance with the Agreement. Subject to the agreement on services, deliverables, compensation and expenses, the Term of this Statement of Work may be extended upon mutual written agreement of Partner and Customer which agreement shall be in a written amendment to this Statement of Work or the entering into another Statement of Work between the Parties.

“SOW Effective Date” will be *13 October 2025 or ten (10) business days from the SOW Execution Date*, whichever is later.

# **3. Project Background and Objective**

Agentspace is a powerful managed service offering by Google Cloud, leveraging advanced capabilities in machine learning and AI to deliver high-quality search functionalities and assistant experience that transform the way enterprises work. The solution integrates with both first-party (1P) and third-party (3P) data connectors, including Google Workspace, Jira, Confluence, and Salesforce, enabling seamless data retrieval and enhanced search experiences. Expected benefits include improved search relevance and enhanced user engagement.

CloudMile will be engaging with the Customer in a scalable model to onboard users to Agentspace. This includes discovery, design, development, testing and deployment of the solution in Customer's GCP environment.

Agentspace is intended to address the following business challenge(s) for Customer:

* To create a federated platform to manage customer complaints from Salesforce and Outlook.

The intended user community (up to 50 active test users) for this pilot includes the following:

* Customer Service Representatives
* Compliance and Legal Department Personnel
* Internal Support Teams

Agentspace will be integrated with the following OOTB supported data sources for this pilot:

* **Microsoft Outlook:** Indexing emails, calendars, and attachments for customer complaints.
* **Salesforce:** For customer complaints.
* **Entra ID:** As the SSO identity provider.

#

# **4. Scope**

CloudMile will design and support Customer in deploying Agentspace in Customer’s GCP environment, lead the development and testing efforts, and enable Customer’s users to leverage the solution’s intelligent search capabilities and versatile conversational assistant for faster enterprise search, access to information boosting user productivity.

**Summary of Scope:**

1. **Kickoff & Discovery**
   * The project kickoff and discovery phase will establish project governance, define success criteria, and confirm technical setup.
   * Activities to be performed will include understanding Customer's current system and ensuring access to the necessary GCP environment and tools and acquiring sample question and answer pairs (golden data set) provided by the customer.
2. **Solution Design**
   * Design a solution architecture unique to Customer’s environment to meet the outlined business and technical requirements including specifics around the security and system designs, data model design, and connector configuration.

### **Datasource Connectors Setup**

1. Configure Entra ID as the identity provider for the federated platform.
2. Configure and connect each of the identified data sources, ensuring each connector supports user-specific access:
   1. Microsoft Outlook
   2. Salesforce
3. **Development & Testing**
   * Configure and test data source connections within Agentspace, ensuring user-specific access and proper access controls.
   * Evaluate the solution against a customer-provided dataset and refine based on feedback, with ongoing technical assistance provided throughout testing.
4. **Project Closure & Next Steps**
   * The project will conclude with a knowledge transfer meeting to review goals, lessons learned, and deliverables, including a Technical Design Document.
   * Operational guidelines will be provided, alongside regular status reports and meetings throughout the project lifecycle.

# **5. Description of Services**

CloudMile will perform the following Services as per the Scope defined above in Customer’s non- production environment:

**In Scope Services:**

**5.1 Kickoff & Discovery**

* Lead discovery sessions with Customer’s teams to identify priority use case scenarios
* Analyze Customer’s current workflows and system set-up
* Create a Project Plan for achieving the agreed-upon goals and objectives
* Facilitate discovery workshops (up to four (4) hours) with the Customer teams to:
  * Explore Customer’s current workflows and system set-up.
  * Confirm understanding of the identified use case and define success criteria.
  * Confirm understanding of User Authentication and Authorization set-up.
  * Confirm a sample set of queries and expected response for the identified use cases
* Document the results of the discovery workshops in a Discovery Findings Document
* Project Setup
  * Enable all the necessary tools and services required for this engagement in Customer’s GCP environment which is expected to include at least the following:
    * Source code control version management
    * Identify a GCP project in the Customer’s non-prod environment where the implementation will take place.
    * Confirm in the Agent Builder Console that the Application Programming Interface (API) has been activated for the identified project.
    * Confirm the project is allowlisted to start using Agentspace.
    * List any additional tools, utilities, or other software required as a prerequisite for deployment.
    * Configure user authentication and authorization using the in-scope identity provider.

**5.2 Solution Design**

* Design a solution architecture to meet the outlined business and technical requirements including specifics around the security and system designs, data model design, and connector configuration
* Review the solution design with Customer prior to implementation, refine a the solution architecture as mutually agreed upon, and agree upon the finalized solution design
*

` ```mermaid `

`gantt`

`    title Project Timeline`

`    dateFormat  YYYY-MM-DD`

`    section Kickoff & Discovery`

`    Kickoff & Discovery      :done, 2025-10-13, 1w`

`    section Solution Design`

`    Solution Design          :active, 2025-10-20, 1w`

`    section Deployment`

`    Salesforce and Outlook Connectors Setup :2025-10-27, 2w`

`    section Development & Testing`

`    Development & Testing    :2025-11-10, 2w`

`    section Closure`

`    Project Closure & Next Steps :2025-11-24, 1w`

**5.3 Agentspace Deployment and Datasource Connectors Setup**

* Configure and connect each of the in-scope data sources to the federated platform, ensuring each connector supports user-specific access, per the capabilities of the connector.
* Data sources: Microsoft Outlook, Salesforce
* Identity Provider: Entra ID
* Verify that each connector respects access controls, allowing users to search only the data they are permitted to view via test scenarios mutually agreed upon with Customer.
* Test different user roles and permission levels (e.g., admin vs. regular user) to verify appropriate data access via test scenarios mutually agreed upon with Customer

**5.4 User Testing and Optimization**

* Evaluate the implemented solution by measuring the performance against the sample question and answer pairs provided by Customer (golden dataset) using built-in metrics in the Vertex Gen AI Evaluation API
* Review the accuracy, relevance, and completeness of generated answers and their citations, ensuring proper attribution and minimizing instances of AI hallucination.
* User Acceptance Testing
  * Conduct a session to guide and onboard up to 50 users to test the solution
  * Assist Customer in using the deployed Solution during a 1 week period including daily office hours of up to 30 minutes over a 3-5 day period

**5.5 Project Closure & Next Steps**

* Conduct a knowledge transfer and closeout meeting up to two (2) hours to:
  * Recap the project goals.
  * Summarize lessons learned and accomplishments.
  * Review submitted deliverables including Technical Design Document and code snippets.
* Technical Documentation, Handover & Project Governance:
  * Prepare comprehensive Technical Design Documents (TDD).
  * Conduct a session to provide operational guidelines to ensure smooth solution operation and maintenance

**Out of Scope:**

* Development of production-grade custom/AutoML/Gen AI-specific ML model or large-scale deployment.
* Development of new or custom connectors, agents, and actions
* Search tuning, the development of a data management system, the use of custom embeddings, or fine-tuning foundational LLMs beyond basic adjustments.
* Technical assistance beyond the project’s scope. Queries beyond this are not included.
* Hypercare or other post-deployment support
* Automatically updating the model’s knowledge base or tuning based on user interactions and feedback during conversations
* Redacting any PII Data from any model/pipeline
* Develop solutions supporting non-English documents, queries or answers.
* Integrate the solution with or customize any downstream applications.
* Perform change management.
* Perform optimizations on existing code or queries.
* Perform any work in Customer’s existing production systems.
* Create new step-by-step documentation to set up and operate Customer’s GCP environment.
* Benchmark solution performance against any of the existing models used by Customer or other open source models.
* Provide advisory, support, or delivery services for third-party products or services.
* Perform regulatory compliance audits or acting as a qualified security assessor.
* Provide ongoing support, maintenance, or modifications beyond the engagement’s completion, including:
  * Technical support for delivered artifacts after ownership has transitioned to the customer.
  * Changes to the technical architecture post-completion.
  * Contributions to or maintenance of customer CI/CD pipelines, IaC frameworks, or associated configurations.
* Provide contributions to internal Customer documentation or tools (e.g., Jira, Microsoft Project) for program management or backlog planning.
* Develop new connectors.
* Develop agentic workflows.
* Develop any custom user interface (UI) or integrate the solution to an existing UI.
* Evaluate Search result quality from Vertex AI Search outside the context of Agentspace.

# **6. Estimated Timeline**

The following timeline is for illustrative purposes only:

| Task | W1 (Oct 13) | W2 (Oct 20) | W3 (Oct 27) | W4 (Nov 3) | W5 (Nov 10) | W6 (Nov 17) | W7 (Nov 24) |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| Kickoff & Discovery | X | | | | | | |
| Solution Design | | X | | | | | |
| Salesforce and Outlook Connectors Setup | | | X | X | | | |
| Development & Testing | | | | | X | X | |
| Project Closure & Next Steps | | | | | | | X |

**Milestone 1**: **Use Case Finalization**: Identify and document targeted use cases and user personas for testing the product.
**Milestone 2:** **Authentication Setup**: Implement and validate user authentication for secure Agentspace connector access.
**Milestone 3**: **Solution Deployment**: Complete end-to-end architecture setup, including deployment of connectors and integrations.
**Milestone 4:** **Testing and Validation**: Develop test cases, conduct system and integration testing, and secure Customer sign-off on the results.
**Milestone 5: Documentation and Transition**: Deliver comprehensive documentation and conduct a formal handover for future scalability and support.

# **7. Project Governance & Communication Plan**

| Sr. No. | Meeting | Cadence | Purpose |
| :---- | :---: | :---: | :---- |
| **01** | **Project Kickoff** | Once | Project overview Alignment on timelines, deliverables and resources Actual Kick off date for the “Officially starting engagement” Discuss issues resolution process |
| **02** | **Discovery sessions** | Week 1 | Discovery Sessions Data Understanding sessions for assessment/implementation Understanding data sources Knowledge Transfer Sessions |
| **03** | **Weekly Project Management Review** | Weekly | Track weekly progress on deliverables/sprint cycle Highlight risks and dependencies Provide update on action items |
| **04** | **Project Evaluation Review** | Weekly | Review of development progress Walkthrough of the midpoint summary |
| **05** | **Ad-Hoc Calls** | On demand | Highlight blockers/risks if any |
| **06** | **Project Closure & Next Steps** | Final week | Final review of deliverables Next steps on the engagement |

## **7.1 RACI Matrix During Delivery**

| Deliverable | CloudMile | Customer |
| :---: | :---: | :---: |
| Kick Off | R, A | C, I |
| Providing the Required Customer Environment Access | C, I | R, A |
| Setting Up Data Connections & Dashboard Activation | R, A | C, I |
| Documentation & Demo | R, A | C, I |
| Availability of Customer’s SMEs | C, I | R, A |
| Highlighting Risks | R, A | R, A |
| Timely Customer communication | R, A | C |

# **8. Deliverables**

The Deliverables to be provided by Partner to Customer are as follows:

| Deliverable | Deliverable Detail | Timeline |
| :---- | :---- | :---- |
| Deliverable 1 | Solution Architecture Design | End of Milestone 1 |
| Deliverable 2 | Project Kickoff Deck, Delivery Guide, and Discovery Findings Document | End of Milestone 2 |
| Deliverable 3 | End to end solution design and deployment | End of Milestone 3 |
| Deliverable 4 | User Testing Findings Document | End of Milestone 4 |
| Deliverable 5 | Final TDD & Project Closeout documentation | End of Milestone 5 |

# **9. Roles & Responsibilities**

## **9.1 Roles**

| CloudMile Team Roles | Role description |
| :---- | :---- |
| PM | Program lead, driving activities and deliverables in the SOW |
| Architect | Design the implementation for the customer. Manage the project from a technical point of view. Conduct bug reporting and bug fixes . Document and report any potential feature requirements Contribute feedback for onboarding guide and documentation |
| AI Engineer (2) | Guide the customer in the technical implementation. resolve any configuration issues. Conduct bug reporting and bug fixes |
| Identity Architect | Design the identity implementation for the customer. - Workforce Identity Federation Setup; and general understanding of Auth landscape (EntraID, Okta, SAML, OIDC, OAUTH), Google Identity, Cloud Identity |
| Business Consultant | Guide the customer to identify the right business use case, to leverage the solution and help with 1P & 3P system Partner testing connectors with ISVs e.g. SFDC, SNOW, Slack, Sharepoint etc. |

| Customer Team Roles | Role description |
| :---- | :---- |
| PM | Program lead who can provide approvals, driving activities and deliverables in the SOW |
| Engineers | Engineering team who will own the project elements after the project is moved to prod. |
| System Admins | Provide access controls for 3P connectors. Workforce Identity Federation Setup; and general understanding of Auth landscape (EntraID, Okta, SAML, OIDC, OAUTH), Google Identity, Cloud Identity |
| UAT testers (different Personas) | A User Acceptance Testing tester is responsible for validating software functionality by ensuring it meets business requirements, user needs, and quality standards through real-world scenario testing before release |

## **9.2 Escalation Matrix**

| Level | CloudMile | Customer |
| :---- | :---- | :---- |
| Level 1 | Engagement Manager/TPM | Project Lead |
| Level 2 | Sales Contact | Technical SME |
| Level 3 | Portfolio Leader | Business Stakeholder |

# **10. Risks, Assumptions, Issues, and Dependencies**

## **10.1 Risks**

CloudMile and Customer will meet at regular intervals to mitigate any risk as it comes up.

| Risks | Mitigation Plan |
| :---- | :---- |
| Delay due to Product feature issues | Partner will collaborate to resolve any product related issues and revisit timelines to drive customer success. |
| Differing expectations between Partner, partners, and Agentspace customers regarding timelines, deliverables, and scope. | Conduct frequent stakeholder alignment meetings. Define and document a clear Scope of Work (SOW) and Acceptance Criteria at the project’s outset. Use RACI matrices to clarify roles and responsibilities. |
| Compatibility issues between customers’ existing systems and GCP architecture | Conduct a thorough technical discovery to identify integration points and security requirements. |
| Customers may have concerns about data privacy and compliance when moving to the cloud. | Include a security and compliance assessment as part of onboarding. Ensure all GCP services adhere to industry compliance standards like GDPR, HIPAA, or ISO. Provide transparent documentation to customers about GCP’s security certifications. |
| Onboarded customers may experience technical issues due to inadequate testing. | Include comprehensive testing phases (unit, system, integration, and user acceptance). Use automated testing tools to minimize errors. Develop a checklist to validate key onboarding milestones. |

## **10.2 Assumptions**

1. Additional data connectors will impact the delivery schedule and cost.
2. Customer is using compatible versions of the identified connector systems such as Microsoft Outlook and others.
3. A single identity provider will be supported for this engagement
4. If using the Private option for any connector, the Customer will set up Private Service Connect between the GCP Project Network and the network of the third-party data source, prior to the start of the engagement
5. If Customer is using a third-party identity provider that does not sync identities to Google, and wishes to use access controlled data sources, then the Customer must set up workforce identity federation in Google Cloud prior to the start of the engagement

## **10.3 Customer Dependencies and Prerequisites**

Customer will meet all of the following project prerequisites BEFORE the start of the Services:

1. Provide the IAM roles and access to Customer’s GCP Environment.
2. Provide access to identified systems for Agentspace connectors to be integrated into the Agentspace product
3. Identify users for product testing and providing feedback
4. Ensure SMEs availability for discovery sessions, weekly meetings and testing activities
5. Provide a sample set of queries and expected response for the identified use cases
6. Provision an existing Google Cloud Foundational infrastructure to support engagement.
7. Enable access to all required Google Cloud services needed for the successful performance of the Services
8. Provide access to all third-party data sources/ connectors for integrating connectors
9. Ensure that users within Customer’s organisation are provided appropriate permissions for the applications, before the start of the project
10. Provide access to a golden dataset including representative search data samples (search queries and responses for data sources) to enable discovery, preparation and prototyping activities.
11. Provide relevant discovery documentation covering the infrastructure, deployment, integration, and application architecture (API contracts, interfaces, proposed consuming client details, etc.) and configuration details for in scope components.
12. Provide Partner with access to subject matter experts for technical and business discussions to support decision making (e.g., deployment team, data scientists, and technical leads) and information regarding Customer information, infrastructure, and application security.
13. Assign a project sponsor who will serve as an escalation point for timely completion of tasks.
14. Align stakeholders to attend the kickoff meeting and regular calls as part of the engagement.
15. Provide a dedicated project manager responsible for Customer engagement, scheduling, managing communication with teams, change management, issue escalation, and coordination with Google.
16. Make available technical personnel with appropriate approvals, systems access, and permissions to allow for the implementation of the solution, and the protection of applications across the Customer environment.
17. Provide timely access to application owners that can respond to specific queries or provide detailed information about their particular applications.
18. Provide program goals and target metrics.

Customer will perform the following ONGOING activities during the engagement:

1. Provide the IAM Roles and access to Customer’s GCP Environment.
2. Provide access to identified systems for Agentspace connectors to be integrated into the Agentspace product
3. Identify users for product testing and providing feedback
4. Ensure SMEs availability for discovery sessions, weekly meetings and testing activities
5. Perform all necessary prerequisite modifications or enhancements to their foundations to accommodate successful onboarding of the Agentspace product.
6. Ensure decisions are completed within one (1) business day, as part of project delivery.
7. Actively collaborate on requirements analysis, decision making, documentation, coding, and testing as needed for Partner’s successful performance of the Services.
8. Provide timely access to necessary customer documentation, internal systems, relevant subject matter experts, and logs/telemetry for delivery, troubleshooting, and decision-making.
9. Provide, maintain, and deliver ongoing support for remote access to the customer’s internal collaboration suite as needed
10. Provide the necessary review and feedback with Partner’s team.
11. Complete requested feedback forms upon completion of the engagement.

# **11. Success Criteria**

The success criteria for the approval of the Services and the acceptable Deliverables is:

1. Complete end-to-end setup and system integration on Customer’s GCP environment with functional connectors.
2. Users can effectively search and retrieve information across integrated systems.
3. Timely onboarding of users using a scalable framework with minimal technical issues.
4. Positive customer feedback and successful PoC handover, ensuring readiness for future scalability and collaboration.

The procedure for accepting the Services and Deliverables shall be as set forth in the Agreement.

# **12. Project Closure**

Upon completion of the knowledge and documentation transfer, CloudMile will conduct a final project closure meeting with Customer to review and complete the Project Closure Checklist. After the project closure meeting, CloudMile will generate the Project Acceptance Form. Customers will complete and sign the Project Acceptance Form and return in five (5) business days time, at which time the SOW will be closed. If CloudMile has not received the Project Acceptance Form by the end of the 5th business day, the Project will be deemed accepted and will proceed with closing this SOW.

# **13. Compensation, Invoicing and Payment Schedule**

## **13.1 Compensation**

Compensation for the Services performed and the Deliverables provided shall be paid subject to formal DAF approval by Google Cloud. Unless otherwise approved in writing as an amendment to this Agreement, the total compensation under this Agreement (excluding cost or expenses specified below) is a fixed price of **$15,000**. Throughout the delivery of Services by CloudMile and any subsequent execution of Services or Deliverables, Customer bears full responsibility for the costs associated with Google Cloud usage within their tenant. This includes expenses related to various Google Cloud services, such as compute, storage, networking, and other resources.

The cost breakdown is as follows:

| Services | Cost |
| :---- | ----: |
| Total Fixed Price for Professional Services | *$15,000* |
| Google DAF Funding | *($15,000)* |
| Net cost to customer | *$0* |

*Note: This compensation structure is contingent on securing the specified Google DAF Funding package. Actual costs and funding details will be finalized upon formal approval.*

## **13.2 Expenses**

All expenses, if agreed to between Customer and CloudMile, shall be paid by Customer in accordance with Customer’s Expense reimbursement policies. If Customer does not provide notice of objection to any such Expenses, Customer agrees to pay all such Expenses set forth in an Invoice provided by CloudMile.

## **13.3 Taxes**

Customer shall be liable for and pay all applicable taxes (including but not limited to sales, service, or goods and services tax) properly payable by Customer upon and in connection with the provision of the Services under this SOW. Customer shall provide a valid tax exemption certificate in case it is exempt from applicable taxes.

The Parties hereto have executed this SOW as of the date first written above.

| CloudMile |  |
| :---- | :---- |
| Authorized Signature: |  |
| Printed Name: | Lester Leong |
| Title: | Country Manager |
| Email Address: | lester.leong@mile.cloud |
| Phone Number: | +6012-773 8915 |
| Date: |  |

| Customer |  |
| :---- | :---- |
| Authorized Signature: |  |
| Printed Name: | \[Customer Name] |
| Title: | \[Customer Title] |
| Email Address: | \[Customer Email] |
| Phone Number: |  |
| Date: |  |

***