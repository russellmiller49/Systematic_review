ALTER TABLE "ScreeningDecision" ADD COLUMN "withdrawnAt" TIMESTAMP(3), ADD COLUMN "withdrawalId" TEXT;
ALTER TABLE "ScreeningDecision" ADD CONSTRAINT "ScreeningDecision_withdrawal_pair" CHECK (("withdrawnAt" IS NULL) = ("withdrawalId" IS NULL));
CREATE TABLE "ScreeningWithdrawal" (
 "id" TEXT NOT NULL, "guidelineId" TEXT NOT NULL, "poolId" TEXT NOT NULL,
 "reviewerId" TEXT NOT NULL, "actorId" TEXT NOT NULL, "reason" TEXT NOT NULL,
 "manifest" JSONB NOT NULL, "summary" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "restoredAt" TIMESTAMP(3), "restoreRequestId" TEXT, "restoreActorId" TEXT, "restoreSummary" JSONB,
 CONSTRAINT "ScreeningWithdrawal_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "ScreeningWithdrawal_restore_pair" CHECK (("restoredAt" IS NULL) = ("restoreRequestId" IS NULL))
);
CREATE UNIQUE INDEX "ScreeningWithdrawal_restoreRequestId_key" ON "ScreeningWithdrawal"("restoreRequestId");
CREATE INDEX "ScreeningWithdrawal_guidelineId_createdAt_idx" ON "ScreeningWithdrawal"("guidelineId", "createdAt");
