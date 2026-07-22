-- CreateEnum
CREATE TYPE "RetrievalRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "OrganizationLibrarySettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "institutionName" TEXT,
    "ezproxyBaseUrl" TEXT,
    "openUrlBaseUrl" TEXT,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationLibrarySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FullTextRetrievalRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "RetrievalRunStatus" NOT NULL DEFAULT 'RUNNING',
    "citationIds" JSONB NOT NULL,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "claimedCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "retrievedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FullTextRetrievalRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationLibrarySettings_orgId_key" ON "OrganizationLibrarySettings"("orgId");

-- CreateIndex
CREATE INDEX "FullTextRetrievalRun_projectId_status_idx" ON "FullTextRetrievalRun"("projectId", "status");

-- CreateIndex
CREATE INDEX "FullTextRetrievalRun_projectId_createdAt_idx" ON "FullTextRetrievalRun"("projectId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "OrganizationLibrarySettings" ADD CONSTRAINT "OrganizationLibrarySettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationLibrarySettings" ADD CONSTRAINT "OrganizationLibrarySettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FullTextRetrievalRun" ADD CONSTRAINT "FullTextRetrievalRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FullTextRetrievalRun" ADD CONSTRAINT "FullTextRetrievalRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
