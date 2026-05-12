# CitizenWatch - Updates and Manual Tests

## Feature 1 - Community voting + moderation support
- Added vote flow (`CONFIRM`/`DISPUTE`) with distance gate and anti-abuse checks.
- Added community dashboard and moderation vote visibility.
- Added duplicate detection and moderation prioritization signals.

Manual test:
1. Create a report and open `Community` page.
2. Vote from a nearby location; verify net score changes.
3. Try voting far away; confirm out-of-range error.
4. Open moderation queue and verify vote-related indicators are shown.

## Feature 2 - Nearby witness corroboration
- On new `PENDING` report, nearby opted-in users receive witness prompt notifications.
- Witness responses map to community votes:
  - `CORROBORATED` -> `CONFIRM`
  - `DISPUTED` -> `DISPUTE`
- Invite expiry (30 min), per-user notify cap, and profile opt-out/location support added.

Manual test:
1. In profile, set witness location + enable witness notifications.
2. Create a pending report near that location.
3. Open notification, respond via witness page, and verify vote updates.
4. Wait past expiry (or force expiry in DB) and verify response is rejected.

## Feature 3 - Resolution tracking
- Law enforcement/admin can resolve verified reports with required tag + optional internal notes.
- Law enforcement can reopen resolved reports.
- Added resolution history and inspector resolution analytics (`% resolved within 48h`).
- Resolved reports are excluded from default live risk/map behavior.

Manual test:
1. Verify a report, then resolve it from inspector resolutions page.
2. Confirm resolved badge/tag/date appears but internal notes are not shown to citizens.
3. Reopen as law enforcement and confirm report becomes active again.
4. Check resolution stats endpoint/page for updated metrics.

## Feature 4 - Staleness decay + auto-archival
- Added staleness states: `FRESH`, `AGING`, `STALE`, `ARCHIVED`.
- Added multiplier decay to risk/hotspot/routing contributions.
- Added cron (30 min default) to advance staleness states and archive expired reports.
- Added map/UI indicators and toggles for resolved/archived visibility.

Manual test:
1. Verify a report and set `verifiedAt` in DB to simulate age buckets.
2. Run/await cron and confirm state transitions + multiplier updates.
3. Confirm `ARCHIVED` reports are hidden from default live map.
4. Enable “Show archived” and confirm archived markers become visible.

## Feature 5 - Silent reporter credibility scoring
- Added hidden per-user credibility score/tier with event history.
- Added moderation-based deltas and inactivity decay.
- Added trusted/flagged/restricted queue behavior and restricted daily report cap.
- Added admin-only credibility history + manual adjustment APIs.
- Added user appeal endpoint (max one appeal per 30 days).

Manual test:
1. Submit reports from authenticated user and moderate outcomes to trigger score deltas.
2. Verify tier transitions (`TRUSTED`, `STANDARD`, `FLAGGED`, `RESTRICTED`) in admin API.
3. For restricted user, submit >2 reports/day and confirm only generic limit message appears.
4. Call appeal endpoint twice within 30 days and confirm second request is blocked.
5. As admin, fetch credibility history and apply manual adjustment with reason.
