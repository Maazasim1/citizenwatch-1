-- Remove time-based staleness / auto-archive; law-enforcement resolution fields stay on Report.
DROP TABLE IF EXISTS "StalenessAuditLog";

DROP TABLE IF EXISTS "StalenessConfig";

ALTER TABLE "Report" DROP COLUMN IF EXISTS "stalenessMultiplier";
ALTER TABLE "Report" DROP COLUMN IF EXISTS "stalenessState";
ALTER TABLE "Report" DROP COLUMN IF EXISTS "archivedAt";

DROP TYPE IF EXISTS "StalenessState";
