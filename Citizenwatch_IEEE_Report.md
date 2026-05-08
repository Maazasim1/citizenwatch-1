# Citizenwatch — IEEE-Style Project Report

## Abstract
Citizenwatch is an MVP community safety platform that unifies citizen crime reporting, moderator verification, AI-assisted incident scoring, spatial hotspot analytics, risk-aware route guidance, and CCTV-assisted suspect recognition. The system is designed for pilot deployment in Karachi, Pakistan, and provides a scalable foundation for cross-city expansion.

## 1. Introduction
Rapid urbanization increases public safety risk in dense cities, while citizens often lack accessible, trusted channels to report incidents. Citizenwatch bridges this gap by enabling community-sourced reports, moderated verification, and actionable intelligence for citizens and law enforcement.

## 2. Problem Statement
Cities face three core challenges:
- **Under-reporting**: Citizens avoid police stations or lack an easy reporting channel.
- **Intelligence gaps**: Law enforcement lacks real-time spatial crime awareness.
- **Unsafe navigation**: Existing route services ignore safety risk.

Citizenwatch addresses these issues with an integrated platform that collects, validates, enriches and visualizes crime data.

## 3. System Architecture
### 3.1 Components
- **Frontend**: `web/` Next.js interface for map views, reporting, moderation, routing, CCTV, and suspect review.
- **Backend**: `apps/api/` Express + Prisma API with authentication, reporting, hotspot analytics, routing, and CCTV handling.
- **CCTV Pipeline**: `apps/cctv-pipeline/` Python module for person detection, face embeddings, and criminal match operations.
- **Database**: Prisma-managed relational storage with spatial and audit-aware records.

### 3.2 Data Flow
1. Citizen submits a report through the web interface or anonymously.
2. The API stores the report as `PENDING` and flags duplicates or suspect imagery.
3. Moderators review reports in the moderation dashboard.
4. Approved reports receive severity scoring and become verified intelligence.
5. Hotspot and route layers update to reflect current risk levels.
6. CCTV processing detects persons and matches against the criminal database.
7. Matches are surfaced to moderators and law enforcement for review.

## 4. Key Functionality
### 4.1 Authentication & Roles
- Email/password login with OTP verification.
- Role-based access control for `CITIZEN`, `MODERATOR`, `LAW_ENFORCEMENT`, `ADMIN`.
- Session inactivity timeout after 24 hours.

### 4.2 Citizen Reporting
- Anonymous or authenticated report submission.
- Incident metadata: title, description, type, location, multimedia.
- Duplicate detection within 200 meters and 15 minutes.
- Evidence upload with image/video support.

### 4.3 Moderation
- Moderator queue with report details and attachments.
- Approve, reject, or escalate reports with mandatory reasoning.
- Low-confidence severity classifications are visibly flagged.

### 4.4 Hotspot Intelligence
- Verified reports cluster into geographic hotspots.
- Time-range filtering supports last 24 hours, 7 days, 30 days, or all-time.
- Heatmap and cluster summaries enable patrol planning.

### 4.5 Safe Routing
- Route planner computes both shortest and risk-aware paths.
- Uses OSRM for road geometry combined with crime risk scoring.
- Displays risk and distance metrics for safer travel decisions.

### 4.6 CCTV Re-Identification
- Upload of CCTV footage and live webcam frame analysis.
- Criminal database ingest and face match alerting.
- Matches are presented for human review before any scoring impact.

## 5. Evaluation
### 5.1 Citizen Benefits
- Simplified incident reporting from any location.
- Access to verified local safety intelligence.
- Safer route guidance compared to standard navigation.

### 5.2 Moderator Benefits
- Structured review workflows with evidence visibility.
- Duplicate and low-confidence report detection.
- Escalation path for sensitive incidents.

### 5.3 Law Enforcement Benefits
- Actionable hotspot and incident summaries.
- Real-time alerts from CCTV match events.
- Audit-aware criminal database operations.

## 6. Strengths and Limitations
### Strengths
- Complete MVP from citizen reporting to law enforcement intelligence.
- Human-in-the-loop moderation ensures verification before publication.
- Role-aware interfaces for citizens, moderators, and inspectors.
- Pilot-ready design for Karachi with scalable architecture.

### Limitations
- Severity scoring is currently heuristic and pilot-level.
- CCTV re-identification requires strong legal governance.
- External dependencies such as OSRM and Nominatim may limit availability.
- Live camera feed support is available but best suited for controlled environments.


## 7. Conclusion
Citizenwatch demonstrates a viable MVP for modern community safety, combining crowdsourced reporting, human moderation, geospatial intelligence, and CCTV-assisted criminal recognition. It provides a strong foundation for further development and pilot validation in urban environments.
