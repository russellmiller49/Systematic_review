-- CreateTable
CREATE TABLE "GuidelineScreeningPool" (
    "id" TEXT NOT NULL,
    "guidelineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuidelineScreeningPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuidelineScreeningPoolMember" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GuidelineScreeningPoolMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuidelineScreeningPool_guidelineId_key"
ON "GuidelineScreeningPool"("guidelineId");

-- CreateIndex
CREATE UNIQUE INDEX "GuidelineScreeningPoolMember_projectId_key"
ON "GuidelineScreeningPoolMember"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GuidelineScreeningPoolMember_poolId_projectId_key"
ON "GuidelineScreeningPoolMember"("poolId", "projectId");

-- CreateIndex
CREATE INDEX "GuidelineScreeningPoolMember_poolId_order_idx"
ON "GuidelineScreeningPoolMember"("poolId", "order");

-- AddForeignKey
ALTER TABLE "GuidelineScreeningPool"
ADD CONSTRAINT "GuidelineScreeningPool_guidelineId_fkey"
FOREIGN KEY ("guidelineId") REFERENCES "Project"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuidelineScreeningPool"
ADD CONSTRAINT "GuidelineScreeningPool_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuidelineScreeningPoolMember"
ADD CONSTRAINT "GuidelineScreeningPoolMember_poolId_fkey"
FOREIGN KEY ("poolId") REFERENCES "GuidelineScreeningPool"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuidelineScreeningPoolMember"
ADD CONSTRAINT "GuidelineScreeningPoolMember_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
