-- CreateEnum
CREATE TYPE "CohortMethod" AS ENUM ('REGISTRY_ID', 'COMPOSITE');

-- CreateEnum
CREATE TYPE "CohortCandidateStatus" AS ENUM ('SUGGESTED', 'LINKED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TextLayerStatus" AS ENUM ('PENDING', 'EXTRACTED', 'NO_TEXT_LAYER', 'FAILED');

-- AlterEnum
ALTER TYPE "ExportKind" ADD VALUE 'ANALYSIS';

-- AlterTable
ALTER TABLE "Citation" ADD COLUMN     "affiliations" JSONB;

-- AlterTable
ALTER TABLE "FullTextFile" ADD COLUMN     "pageCount" INTEGER,
ADD COLUMN     "textStatus" "TextLayerStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "textVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CohortCandidate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "citationAId" TEXT NOT NULL,
    "citationBId" TEXT NOT NULL,
    "method" "CohortMethod" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "signals" JSONB NOT NULL,
    "status" "CohortCandidateStatus" NOT NULL DEFAULT 'SUGGESTED',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CohortCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FullTextPage" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "FullTextPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CohortCandidate_projectId_status_idx" ON "CohortCandidate"("projectId", "status");

-- CreateIndex
CREATE INDEX "CohortCandidate_citationBId_idx" ON "CohortCandidate"("citationBId");

-- CreateIndex
CREATE UNIQUE INDEX "CohortCandidate_projectId_citationAId_citationBId_key" ON "CohortCandidate"("projectId", "citationAId", "citationBId");

-- CreateIndex
CREATE UNIQUE INDEX "FullTextPage_fileId_page_key" ON "FullTextPage"("fileId", "page");

-- AddForeignKey
ALTER TABLE "CohortCandidate" ADD CONSTRAINT "CohortCandidate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortCandidate" ADD CONSTRAINT "CohortCandidate_citationAId_fkey" FOREIGN KEY ("citationAId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortCandidate" ADD CONSTRAINT "CohortCandidate_citationBId_fkey" FOREIGN KEY ("citationBId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortCandidate" ADD CONSTRAINT "CohortCandidate_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FullTextPage" ADD CONSTRAINT "FullTextPage_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FullTextFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
