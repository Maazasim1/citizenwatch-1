# Citizenwatch — Product Requirements Document

---

## 1. Executive Summary

Citizenwatch is a citizen-driven, AI-powered crime intelligence and community safety platform designed to bridge the gap between civilian crime reporting and law enforcement response. Citizens submit geotagged, multimedia-enriched crime reports that are verified by human moderators before entering a structured crime database. Machine learning models classify incident severity, detect spatial hotspots, and power risk-aware route navigation. A CCTV-assisted re-identification module cross-references detected individuals against a verified criminal database to passively flag high-activity zones.

The initial pilot targets Karachi, Pakistan, with a cross-city scalable architecture. The system targets a System Usability Scale score above 75 and a verified report publication latency under 5 minutes.

---

## 2. Project Overview

| Attribute | Detail |
|---|---|
| Project Name | Citizenwatch — Crime Intelligence & Community Safety Platform |
| Version | 1.0 (Pilot) |
| Pilot Location | Karachi, Sindh, Pakistan |
| Document Status | Draft |
| Primary Stakeholders | Citizens, Law Enforcement, Moderators, City Administration |
| SUS Target | > 75 |
| Report Latency SLA | < 5 minutes post-verification (95th percentile) |

---

## 3. Problem Statement

Urban crime management in cities like Karachi suffers from three compounding failures:

**Reporting Gaps** — Citizens lack accessible, standardized channels to report crimes in real time. Fear of retaliation, distance from police stations, and institutional distrust suppress reporting rates well below actual incident rates.

**Intelligence Lag** — Law enforcement operates on delayed, incomplete data with no real-time spatial picture of city-wide crime activity, making proactive resource allocation difficult.

**Navigation Blindness** — Citizens have no tools to assess route safety dynamically. Existing navigation apps optimize purely for speed or distance with no risk-adjusted guidance.

Citizenwatch addresses all three failures through a unified platform that crowdsources incident data, validates it through human oversight, enriches it with AI-driven severity scoring, and surfaces it through accessible visualizations and safe-routing tools.

---

## 4. Goals & Success Metrics

**Primary Goals**
- Establish a verified, real-time crime intelligence database for Karachi
- Enable citizens to navigate using risk-adjusted routing
- Provide law enforcement with actionable hotspot intelligence for resource allocation
- Build a scalable architecture suitable for cross-city deployment

**Success Metrics**

| ID | Metric | Target |
|---|---|---|
| M-01 | System Usability Scale (SUS) score | > 75 |
| M-02 | Report publication latency post-verification | < 5 minutes (95th pct) |
| M-03 | ML severity classifier accuracy | ≥ 85% |
| M-04 | Safe route demonstrably reduces exposure vs. shortest path | Verified in pilot |
| M-05 | CCTV ReID false positive rate | < 5% |
| M-06 | Concurrent users without degradation | 1,000 (pilot) |
| M-07 | Moderator queue clearance during peak | < 10 minutes |

---

## 5. Stakeholders & User Personas

**Stakeholder Map**

| Stakeholder | Role |
|---|---|
| Citizens / General Public | Submit reports, consume heatmaps, use safe routing |
| Law Enforcement Agencies | Consume crime intelligence, hotspot reports, ReID flags |
| System Moderators | Verify reports, review multimedia, manage queue |
| City Administration | Oversee pilot, manage inter-agency data agreements |
| CCTV Infrastructure Operators | Provide authorized camera feed access |
| Research / Academic Partners | Evaluate ML performance and conduct ethical oversight |

**Key Personas**

*Fatima, 34 — Schoolteacher (Citizen Reporter):* Witnessed a street robbery near her school. Wants to report it quickly from her phone with a photo, without visiting a police station. Also wants to know whether her commute route passes through any flagged areas.

*Inspector Khalid, 42 — Law Enforcement Analyst:* Manages resource allocation for a district. Needs weekly heatmaps by crime type and severity to direct patrol density. Wants alerts when a known offender is repeatedly flagged in a new zone.

*Sana, 28 — Platform Moderator:* Reviews the incoming report queue during her shift. Needs to view submitted evidence, cross-reference with CCTV footage for the reported location, and approve, escalate, or reject reports efficiently.

---

## 6. Data Sources

**Crowdsourced Citizen Reports** — The primary data layer. Citizens submit incident type, free-text description, photographs, video, GPS coordinates, and timestamp. Reports enter the database only after moderator verification.

**Geospatial & Map Data** — OpenStreetMap or Google Maps API provides the road network graph for Dijkstra/A* pathfinding, geographic context for hotspot visualization, and administrative boundary overlays.

**Historical Crime Records** — FIR records and published annual statistics from Sindh Police, accessed via formal data-sharing agreements, seed the database before citizen reports accumulate. This addresses the cold-start problem for ML model training.

**News & Media Signals** — Automated scraping of Dawn, Geo, and ARY News provides supplementary cross-reference evidence for moderators. Media-sourced incidents are tagged distinctly and never promoted to the live heatmap without moderator review.

**Social Media Signals** — Public posts from Twitter/X and Karachi-area Facebook community groups serve as weak signals for emerging incidents in low-app-penetration areas. These are surfaced to moderators only, never directly to the heatmap.

**CCTV Infrastructure** — Camera feeds from three tiers: public safety cameras (Karachi Safe City Project), private partner cameras accessed via formal agreements (banks, commercial centers), and citizen-contributed dashcam or doorbell footage. All feeds are subject to documented legal authorization before ingestion.

---

## 7. Feature Requirements

### 7.1 User Authentication & Access Control

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Citizens register via phone number or email with OTP verification | Must Have |
| FR-02 | Role-based access: Citizen, Moderator, Law Enforcement Analyst, Admin | Must Have |
| FR-03 | Session tokens expire after 24 hours of inactivity | Must Have |
| FR-04 | Admin panel for user role management and access revocation | Must Have |
| FR-05 | Law enforcement access restricted by verified agency credential | Must Have |

### 7.2 Crime Reporting

| ID | Requirement | Priority |
|---|---|---|
| FR-06 | Citizens submit reports with incident type, description, date/time, and location | Must Have |
| FR-07 | Report submission captures GPS coordinates and accuracy radius automatically | Must Have |
| FR-08 | Multimedia upload supports images (JPG, PNG) and video (MP4, max 100MB) | Must Have |
| FR-09 | Citizens can report anonymously with an option to receive status updates | Should Have |
| FR-10 | Duplicate detection flags reports submitted within 200m and 15 minutes of each other | Should Have |
| FR-11 | Citizens receive in-app notification when their report is verified or rejected | Should Have |

### 7.3 Moderation & Verification

| ID | Requirement | Priority |
|---|---|---|
| FR-12 | Moderator dashboard displays incoming report queue ordered by submission time | Must Have |
| FR-13 | Moderators can view all submitted multimedia evidence inline | Must Have |
| FR-14 | Moderators can retrieve available CCTV footage for the reported location and time window | Must Have |
| FR-15 | Moderators can approve, reject, or escalate any report with a mandatory reason note | Must Have |
| FR-16 | Rejected reports are logged and retained for audit purposes | Must Have |
| FR-17 | Escalated reports are routed to senior moderator or law enforcement liaison | Should Have |
| FR-18 | Moderator actions are timestamped and attributed for audit trail | Must Have |

### 7.4 Crime Database

| ID | Requirement | Priority |
|---|---|---|
| FR-19 | Verified reports are stored with: type, timestamp, coordinates, severity score, multimedia references | Must Have |
| FR-20 | Crime types follow a standardized taxonomy (robbery, assault, vehicle crime, vandalism, etc.) | Must Have |
| FR-21 | Database supports spatial queries (bounding box, radius, polygon) | Must Have |
| FR-22 | Historical records from Sindh Police are importable via structured CSV/JSON format | Should Have |
| FR-23 | All records include data source tag (citizen, media, historical, CCTV-derived) | Must Have |

### 7.5 AI Severity Classification

| ID | Requirement | Priority |
|---|---|---|
| FR-24 | ML model assigns a severity score (1–10) to each verified report | Must Have |
| FR-25 | Severity model inputs include: crime type, time of day, location history, repeat offender flag | Must Have |
| FR-26 | Model is retrained monthly on accumulated verified report data | Should Have |
| FR-27 | Model confidence score is stored alongside each severity assignment | Must Have |
| FR-28 | Low-confidence classifications are flagged for moderator review | Should Have |

### 7.6 Hotspot Detection & Heatmaps

| ID | Requirement | Priority |
|---|---|---|
| FR-29 | Spatial clustering algorithm (DBSCAN or equivalent) identifies crime hotspots | Must Have |
| FR-30 | Hotspots are weighted by severity score, recency, and incident frequency | Must Have |
| FR-31 | Heatmap is updated within 5 minutes of a new verified report | Must Have |
| FR-32 | Users can filter heatmap by time range: last 24 hours, 7 days, 30 days | Must Have |
| FR-33 | Users can filter heatmap by crime type | Should Have |
| FR-34 | Predictive hotspot layer shows projected risk zones based on temporal patterns | Should Have |

### 7.7 Safe Route Computation

| ID | Requirement | Priority |
|---|---|---|
| FR-35 | System computes risk-aware routes using A* with severity-weighted edge costs | Must Have |
| FR-36 | Safe route is compared against standard shortest-path (Dijkstra) output | Must Have |
| FR-37 | Route display shows risk level per segment using color coding | Must Have |
| FR-38 | User can request route between any two points within the city | Must Have |
| FR-39 | Route computation completes within 3 seconds for city-scale graph | Must Have |
| FR-40 | Route insights panel shows estimated risk reduction vs. fastest route | Should Have |

### 7.8 CCTV Re-Identification Module

| ID | Requirement | Priority |
|---|---|---|
| FR-41 | System ingests CCTV footage from authorized feeds only | Must Have |
| FR-42 | Person detection runs on ingested footage using YOLOv8 or equivalent | Must Have |
| FR-43 | Face embeddings of detected persons are extracted and compared against verified criminal database | Must Have |
| FR-44 | Criminal database is populated exclusively from law enforcement–provided records (mugshots, FIR photos) | Must Have |
| FR-45 | Matches exceeding confidence threshold are logged with location, timestamp, and confidence score | Must Have |
| FR-46 | All matches are surfaced to human moderators for review before affecting area severity scores | Must Have |
| FR-47 | Repeated high-confidence sightings of a known offender in a zone increment that zone's severity score | Must Have |
| FR-48 | Low-confidence matches are logged separately and never automatically affect scoring | Must Have |
| FR-49 | System operates on stored/submitted footage in pilot phase; live feed processing is post-pilot | Should Have |
| FR-50 | Full audit log of all ReID matches, reviewer decisions, and resulting score changes | Must Have |

### 7.9 Interactive Map Interface

| ID | Requirement | Priority |
|---|---|---|
| FR-51 | Interactive map renders crime heatmap, hotspot markers, and safe routes | Must Have |
| FR-52 | Map supports pan, zoom, and tap-to-report from citizen view | Must Have |
| FR-53 | Law enforcement view overlays patrol zone boundaries and resource allocation suggestions | Should Have |
| FR-54 | Heatmap renders within 2 seconds on standard mobile hardware | Must Have |

### 7.10 Suspect Recognition from Citizen-Submitted Photos

| ID | Requirement | Priority |
|---|---|---|
| FR-51 | Citizens can optionally attach photos intended to capture a suspect during report submission | Must Have |
| FR-52 | System flags citizen-submitted photos containing a human face for moderator review | Must Have |
| FR-53 | Moderator reviews flagged photo and decides whether to submit it for criminal database comparison | Must Have |
| FR-54 | Approved photos are processed through the face embedding pipeline and matched against the verified criminal database | Must Have |
| FR-55 | Match results, confidence scores, and moderator decision are logged in the audit trail | Must Have |
| FR-56 | No automated action is taken on any match — all results are advisory and require human confirmation | Must Have |
| FR-57 | Citizen-submitted photos used for matching are never stored in the public database or surfaced to other users | Must Have |
| FR-58 | If no match is found, the photo is retained in an isolated evidence store accessible only to law enforcement upon formal request | Should Have |
| FR-59 | Image quality assessment rejects photos below a minimum resolution or clarity threshold before processing | Should Have |

---

## 8. Non-Functional Requirements

**Performance** — The platform must support 1,000 concurrent users during the pilot without measurable degradation. Heatmap updates must propagate within 5 minutes of report verification. Route computation must complete within 3 seconds.

**Security** — All data in transit is encrypted using TLS 1.3. Personally identifiable information (PII) from citizen reports is stored separately from the public crime database. Criminal database access is restricted to authenticated law enforcement and senior moderators only. CCTV footage access requires role-based authorization and is logged in full.

**Privacy** — Anonymous reporting is supported. No PII from citizen accounts is ever surfaced in the public-facing heatmap or report feed. The ReID module operates only on footage from cameras with documented legal authorization. The system does not perform real-time tracking of arbitrary individuals.

**Reliability** — System uptime target of 99.5% during pilot period. Automated failover for database and API layer. Report submissions are queued locally if connectivity is lost and synced upon reconnection.

**Scalability** — The architecture is horizontally scalable to support additional cities without core redesign. The crime database supports partitioning by city and administrative region.

**Auditability** — All moderator actions, ReID match decisions, and severity score changes are immutably logged with actor identity and timestamp. Logs are retained for a minimum of 3 years.

---

## 9. System Architecture Overview

The platform consists of five primary layers:

**Mobile & Web Client** — React Native mobile app (iOS/Android) and a React web dashboard. The client handles report submission, map rendering, route requests, and moderator workflows.

**API Gateway & Backend** — RESTful API layer (Node.js or Django) handling authentication, report ingestion, route computation requests, and real-time update delivery via WebSocket.

**Crime Intelligence Engine** — Python-based ML pipeline handling severity classification, spatial clustering (DBSCAN), predictive hotspot modeling, and safe-route edge weight computation.

**CCTV Processing Pipeline** — Isolated processing module handling footage ingestion, YOLOv8 person detection, face embedding extraction, criminal database matching, and match logging. Isolated from the public-facing API by design.

**Data Layer** — PostgreSQL with PostGIS extension for spatial queries, Redis for real-time update caching, and S3-compatible object storage for multimedia evidence.

---

## 10. Data Flow

1. Citizen submits report via mobile app → API gateway ingests and queues
2. Moderator reviews report and multimedia evidence in moderation dashboard
3. If relevant CCTV footage exists for the location/time, moderator retrieves it for cross-reference
4. Moderator approves report → ML severity model scores it → record enters crime database
5. Heatmap and hotspot layers update within 5 minutes
6. CCTV pipeline (parallel) detects persons in authorized feeds → matches against criminal DB → surfaces to moderator → if confirmed, increments zone severity
7. Citizens and law enforcement query updated heatmap and route engine in real time

---

## 11. Ethical & Legal Considerations

**CCTV Re-Identification** — This is the highest-risk component of the system. Several safeguards are non-negotiable: the criminal database is sourced exclusively from formally authorized law enforcement records; all matches go through human moderator review before affecting any public-facing output; no real-time tracking of individuals not in the criminal database occurs; model performance on South Asian demographics must be explicitly benchmarked before deployment, as most pretrained ReID models carry demographic bias; and all camera access must be documented under a formal legal agreement.

**Data Bias** — Criminal records reflect who gets arrested, not necessarily who commits crimes. If historical police data is skewed by enforcement patterns, the heatmap will reflect those biases. The system must be audited regularly for demographic clustering anomalies.

**Privacy Compliance** — The system must be designed in compliance with Pakistan's Personal Data Protection Bill (current draft) and any applicable Sindh provincial regulations. A data protection impact assessment (DPIA) should be completed before the pilot launch.

**Misidentification Risk** — A false positive ReID match carries serious consequences for an innocent individual. The 5% false positive target is a floor, not an aspiration, and the human-in-the-loop review requirement cannot be bypassed or automated away.

**Institutional Review** — Given the sensitive nature of the ReID module and the collection of crime data about private citizens, the project should undergo review by an institutional ethics board or an independent civil liberties body before the pilot goes live.

---

## 12. Out of Scope (Version 1.0)

The following features are explicitly excluded from the initial release and noted for future roadmap consideration:

- Automated emergency dispatch integration
- Integration with official government crime databases via live API (formal data sharing only for this version)
- Live CCTV stream processing (pilot processes stored/submitted footage only)
- Cross-city deployment (architecture supports it; operational rollout is post-pilot)
- Predictive policing recommendations (system provides intelligence, not operational directives)

---

## 13. Milestones & Phasing

| Phase | Scope | Timeline |
|---|---|---|
| Phase 1 — Foundation | Authentication, report submission, moderation dashboard, basic crime database | Month 1–2 |
| Phase 2 — Intelligence | ML severity scoring, heatmap visualization, hotspot detection | Month 3–4 |
| Phase 3 — Navigation | Safe route computation, A* vs. Dijkstra comparison, route UI | Month 4–5 |
| Phase 4 — CCTV ReID | Person detection pipeline, criminal DB integration, moderator ReID workflow | Month 5–6 |
| Phase 5 — Pilot | Usability testing (SUS), pilot deployment in target Karachi district, performance evaluation | Month 7 |

---

## 14. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cold start — insufficient data for ML model | High | High | Seed database with historical FIR data; restrict heatmap to verified-only zones initially |
| Law enforcement data sharing agreement failure | Medium | High | Design system to function without historical data; pursue agreements in parallel |
| ReID model demographic bias | High | High | Benchmark on local dataset before deployment; enforce human review on all matches |
| Legal challenge to CCTV data use | Medium | High | Complete DPIA; restrict to formally authorized feeds only; retain legal counsel |
| Low citizen adoption in pilot district | Medium | Medium | Community engagement campaign; partner with local NGOs and neighborhood committees |
| Moderator queue overflow during major incidents | Low | Medium | Auto-scaling of moderator capacity; priority triage queue for high-severity reports |

---

## 15. Glossary

| Term | Definition |
|---|---|
| SUS | System Usability Scale — standardized 10-item usability questionnaire scored 0–100 |
| FIR | First Information Report — formal police record of a reported crime in Pakistan |
| ReID | Re-identification — matching an individual across multiple camera feeds using visual embeddings |
| DBSCAN | Density-Based Spatial Clustering of Applications with Noise — algorithm used for hotspot detection |
| Severity Score | ML-assigned numerical score (1–10) representing the risk level of a verified incident |
| Hotspot | Geographic zone with statistically elevated crime density relative to surrounding areas |
| DPIA | Data Protection Impact Assessment — formal evaluation of privacy risks before system deployment |
| PostGIS | Spatial extension for PostgreSQL enabling geographic queries |
| Edge Weight | In route computation, the cost assigned to traversing a road segment, adjusted for crime severity |
