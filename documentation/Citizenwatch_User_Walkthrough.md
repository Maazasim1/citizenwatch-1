# Citizenwatch User Walkthrough

## Overview
Citizenwatch is built for three main user groups:
- Citizens who submit reports and view safety intelligence
- Moderators who verify and manage incoming reports
- Inspectors / law enforcement analysts who review hotspots, routes, and CCTV matches

This walkthrough explains how each user interacts with the platform and the major workflows available.

## 1. Citizen Walkthrough
### 1.1 What Citizens Can Do
- Submit incident reports with description, location, and media
- Report anonymously without logging in
- View verified incidents on the live intelligence map
- Filter by time range and incident type
- Use safe route planning to choose lower-risk paths

### 1.2 Submit a Report
1. Open the web application and go to the login page.
2. You may either register/login or directly access the anonymous report form.
3. Navigate to the report page: `/report`.
4. Enter a clear incident title and select the appropriate crime type.
5. Describe what happened, including location details and suspect information if available.
6. Use the GPS button to auto-fill your coordinates or enter them manually.
7. Attach supporting photos or videos if you have them.
8. Submit the report.

### 1.3 After Submission
- The report is stored as pending and reviewed by a moderator.
- If verified, it appears on the public live map and contributes to hotspot analytics.
- If rejected, moderators can log the reason, though citizens do not see PII in the public feed.

### 1.4 Using the Live Map
- Open the homepage to view active verified reports.
- Use filters to view incidents from the last 24 hours, 7 days, 30 days, or all time.
- Select incident type filters to focus on specific categories.
- Click a report to inspect its location and severity.

### 1.5 Safe Route Navigation
1. Visit the route planner page: `/route`.
2. Enter your start and end locations using address autocomplete or coordinates.
3. Request route computation.
4. Compare the standard shortest route with the safer route.
5. Review metrics such as distance, average risk, and risk reduction.
6. Choose the route that best matches your safety preference.

### 1.6 Community Voting
1. only citizen can vote for i witnessed it or doubt it to reduce false positives when theres a human review

## 2. Moderator Walkthrough
### 2.1 What Moderators Can Do
- Review pending citizen reports
- View submitted media and location details
- Approve, reject, or escalate reports
- Monitor duplicate and low-confidence classifications
- Maintain the audit trail for moderation actions

### 2.2 Accessing the Moderator Dashboard
1. Register or sign in using your moderator credentials.
2. Navigate to the moderation page: `/moderation`.
3. The queue displays pending and flagged reports.
4. Select a report to view full details.

### 2.3 Reviewing Reports
- Read the incident description carefully.
- Check the report's location coordinates and any attached evidence.
- Note if the report is marked as a potential duplicate.
- Review the AI severity score and confidence if available.
- Add a moderation reason before taking action.

### 2.4 Taking Action
- `VERIFY`: Publish the report to the live intelligence layer.
- `REJECT`: Decline the report and record the reason for audit.
- `ESCALATE`: Send suspicious or high-priority reports to senior review.

### 2.5 Managing the Queue
- Refresh the queue to see newly submitted reports.
- Prioritize reports with low confidence or high severity.
- Track report status counts from the dashboard.

## 3. Inspector / Law Enforcement Walkthrough
### 3.1 What Inspectors Can Do

- Upload CCTV footage for analysis
- Review criminal database matches and alerts
- Access escalated reports and intelligence summaries

### 3.2 Accessing the Platform
1. Sign in with law enforcement credentials.
2. Use the homepage for a quick overview of live crime reports.
3. Visit the intelligence or route pages for deeper analysis.

### 3.3 Reviewing Hotspots and Reports
- Use filters to inspect crime activity in specific timeframes.
- Observe hotspots and cluster severity on the live map.
- Drill into verified reports to review location, type, and severity.



### 3.5 CCTV and Criminal Match Monitoring
- Visit the CCTV page: `/cctv`.
- Choose between live webcam capture and file upload.
- Upload authorized CCTV footage to detect persons and possible matches.
- Monitor match history and confirmation status.
- Review alerts for recognized persons in the criminal database.

### 3.6 Escalations and Enforcement
- Inspect escalated reports from moderators in the escalations page.
- Use verified information to coordinate responses.
- Reference severity and hotspot trends for deployment decisions.

### 3.7 Resolve Reports
- only the inspector can resolve any kind of incident that is it resolved or not like - Tag (required): ARREST_MADE, SUSPECTS_DISPERSED, SITUATION_CLEARED, FALSE_ALARM, DUPLICATE_CONFIRMED, UNDER_INVESTIGATION, NO_ACTION_TAKEN
- Internal notes (optional, max 500 chars, never shown to citizens)
- Confirmation checkbox (required)

## 4. Practical Tips
- Always use accurate location data to make reports useful.
- Attach clear images or video when possible to support verification.
- Moderators should keep moderation reasons concise and factual.
- Inspectors should validate CCTV matches through the human review process.
- Citizens should rely on verified reports and route advice rather than raw rumors.

## 5. Notes
- Only verified reports contribute to public safety intelligence.
- Anonymous reporting is supported and encouraged for citizen participation.
- The platform emphasizes human review of sensitive CCTV and match data.
- citizens and moderator can see the resolved reports ( read only )
- The system is built as a pilot-ready MVP with future scalability in mind.
