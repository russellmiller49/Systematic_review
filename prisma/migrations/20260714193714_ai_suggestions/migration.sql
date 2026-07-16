-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('PENDING', 'SUBMITTED', 'COMPLETED', 'FAILED', 'CANCELED');

-- AlterTable
ALTER TABLE "ScreeningStage" ADD COLUMN     "aiRankingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiShowScores" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "AiScreeningRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "providerBatchId" TEXT,
    "requestKeys" JSONB,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "succeededCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "usage" JSONB,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiScreeningRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningSuggestion" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "suggestedDecision" "Decision" NOT NULL,
    "rationale" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiExtractionRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "totalFields" INTEGER NOT NULL DEFAULT 0,
    "suggestedCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "notFoundCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "usage" JSONB,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiExtractionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionSuggestion" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "value" JSONB,
    "sourceQuote" TEXT,
    "pageNumber" INTEGER,
    "sourceAnchor" JSONB,
    "confidence" DOUBLE PRECISION,
    "notFound" BOOLEAN NOT NULL DEFAULT false,
    "invalidReason" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiScreeningRun_stageId_createdAt_idx" ON "AiScreeningRun"("stageId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiScreeningRun_projectId_status_idx" ON "AiScreeningRun"("projectId", "status");

-- CreateIndex
CREATE INDEX "ScreeningSuggestion_runId_idx" ON "ScreeningSuggestion"("runId");

-- CreateIndex
CREATE INDEX "ScreeningSuggestion_stageId_score_idx" ON "ScreeningSuggestion"("stageId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningSuggestion_stageId_citationId_key" ON "ScreeningSuggestion"("stageId", "citationId");

-- CreateIndex
CREATE INDEX "AiExtractionRun_studyId_templateId_createdAt_idx" ON "AiExtractionRun"("studyId", "templateId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiExtractionRun_projectId_status_idx" ON "AiExtractionRun"("projectId", "status");

-- CreateIndex
CREATE INDEX "ExtractionSuggestion_runId_idx" ON "ExtractionSuggestion"("runId");

-- CreateIndex
CREATE INDEX "ExtractionSuggestion_studyId_idx" ON "ExtractionSuggestion"("studyId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionSuggestion_templateId_studyId_fieldId_key" ON "ExtractionSuggestion"("templateId", "studyId", "fieldId");

-- AddForeignKey
ALTER TABLE "AiScreeningRun" ADD CONSTRAINT "AiScreeningRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiScreeningRun" ADD CONSTRAINT "AiScreeningRun_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ScreeningStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiScreeningRun" ADD CONSTRAINT "AiScreeningRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningSuggestion" ADD CONSTRAINT "ScreeningSuggestion_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ScreeningStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningSuggestion" ADD CONSTRAINT "ScreeningSuggestion_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningSuggestion" ADD CONSTRAINT "ScreeningSuggestion_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiScreeningRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiExtractionRun" ADD CONSTRAINT "AiExtractionRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiExtractionRun" ADD CONSTRAINT "AiExtractionRun_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiExtractionRun" ADD CONSTRAINT "AiExtractionRun_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ExtractionTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiExtractionRun" ADD CONSTRAINT "AiExtractionRun_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FullTextFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiExtractionRun" ADD CONSTRAINT "AiExtractionRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionSuggestion" ADD CONSTRAINT "ExtractionSuggestion_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiExtractionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionSuggestion" ADD CONSTRAINT "ExtractionSuggestion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ExtractionTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionSuggestion" ADD CONSTRAINT "ExtractionSuggestion_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionSuggestion" ADD CONSTRAINT "ExtractionSuggestion_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "ExtractionField"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
