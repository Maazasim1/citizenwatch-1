-- Community voting on reports (Feature 1)
CREATE TYPE "VoteType" AS ENUM ('CONFIRM', 'DISPUTE');

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "voteAbuseFlaggedAt" TIMESTAMP(3);

ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "voteScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "communityConfirmed" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ReportVote" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "voteType" "VoteType" NOT NULL,
    "voteLat" DOUBLE PRECISION,
    "voteLng" DOUBLE PRECISION,
    "voterIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportVote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReportVote_reportId_userId_key" ON "ReportVote"("reportId", "userId");
CREATE INDEX "ReportVote_voterIp_createdAt_idx" ON "ReportVote"("voterIp", "createdAt");

ALTER TABLE "ReportVote" ADD CONSTRAINT "ReportVote_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportVote" ADD CONSTRAINT "ReportVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CommunityVoteAction" (
    "id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityVoteAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CommunityVoteAction_ip_createdAt_idx" ON "CommunityVoteAction"("ip", "createdAt");
