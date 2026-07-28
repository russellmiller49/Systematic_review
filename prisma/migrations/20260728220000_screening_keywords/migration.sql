-- CreateEnum
CREATE TYPE "ScreeningKeywordCategory" AS ENUM ('INCLUDE', 'EXCLUDE');

-- CreateTable
CREATE TABLE "ScreeningKeyword" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "normalizedTerm" TEXT NOT NULL,
    "category" "ScreeningKeywordCategory" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningKeyword_projectId_normalizedTerm_key"
ON "ScreeningKeyword"("projectId", "normalizedTerm");

-- CreateIndex
CREATE INDEX "ScreeningKeyword_projectId_category_createdAt_idx"
ON "ScreeningKeyword"("projectId", "category", "createdAt");

-- AddForeignKey
ALTER TABLE "ScreeningKeyword"
ADD CONSTRAINT "ScreeningKeyword_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningKeyword"
ADD CONSTRAINT "ScreeningKeyword_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
