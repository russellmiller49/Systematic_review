-- CreateTable
CREATE TABLE "ScreeningQuota" (
    "id" TEXT NOT NULL,
    "stageId" TEXT,
    "poolId" TEXT,
    "reviewerId" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningQuota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningQuota_stageId_reviewerId_key" ON "ScreeningQuota"("stageId", "reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningQuota_poolId_reviewerId_key" ON "ScreeningQuota"("poolId", "reviewerId");

-- AddForeignKey
ALTER TABLE "ScreeningQuota" ADD CONSTRAINT "ScreeningQuota_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ScreeningStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningQuota" ADD CONSTRAINT "ScreeningQuota_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "GuidelineScreeningPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningQuota" ADD CONSTRAINT "ScreeningQuota_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScreeningQuota" ADD CONSTRAINT "ScreeningQuota_scope_check" CHECK (("stageId" IS NULL) <> ("poolId" IS NULL));
ALTER TABLE "ScreeningQuota" ADD CONSTRAINT "ScreeningQuota_target_check" CHECK ("target" >= 0);
