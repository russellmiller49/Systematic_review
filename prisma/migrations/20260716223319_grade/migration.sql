-- CreateEnum
CREATE TYPE "GradeDomain" AS ENUM ('RISK_OF_BIAS', 'INCONSISTENCY', 'INDIRECTNESS', 'IMPRECISION', 'PUBLICATION_BIAS');

-- CreateEnum
CREATE TYPE "GradeJudgment" AS ENUM ('NOT_SERIOUS', 'SERIOUS', 'VERY_SERIOUS');

-- CreateEnum
CREATE TYPE "GradeCertainty" AS ENUM ('HIGH', 'MODERATE', 'LOW', 'VERY_LOW');

-- CreateEnum
CREATE TYPE "GradeAssessmentStatus" AS ENUM ('DRAFT', 'REVIEWED');

-- CreateEnum
CREATE TYPE "GradeStartingLevel" AS ENUM ('HIGH', 'LOW');

-- CreateEnum
CREATE TYPE "GradeRatingOrigin" AS ENUM ('AUTO', 'HUMAN', 'AI_APPLIED');

-- AlterEnum
ALTER TYPE "ExportKind" ADD VALUE 'GRADE';

-- CreateTable
CREATE TABLE "GradeAssessment" (
    "id" TEXT NOT NULL,
    "analysisOutcomeId" TEXT NOT NULL,
    "status" "GradeAssessmentStatus" NOT NULL DEFAULT 'DRAFT',
    "startingLevel" "GradeStartingLevel" NOT NULL DEFAULT 'HIGH',
    "certainty" "GradeCertainty" NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GradeAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeDomainRating" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "domain" "GradeDomain" NOT NULL,
    "judgment" "GradeJudgment" NOT NULL,
    "rationale" TEXT NOT NULL,
    "origin" "GradeRatingOrigin" NOT NULL DEFAULT 'AUTO',
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "metrics" JSONB,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GradeDomainRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiGradeRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "analysisOutcomeId" TEXT NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "totalDomains" INTEGER NOT NULL DEFAULT 0,
    "suggestedCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "usage" JSONB,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiGradeRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeDomainSuggestion" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "analysisOutcomeId" TEXT NOT NULL,
    "domain" "GradeDomain" NOT NULL,
    "suggestedJudgment" "GradeJudgment" NOT NULL,
    "rationale" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradeDomainSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GradeAssessment_analysisOutcomeId_key" ON "GradeAssessment"("analysisOutcomeId");

-- CreateIndex
CREATE UNIQUE INDEX "GradeDomainRating_assessmentId_domain_key" ON "GradeDomainRating"("assessmentId", "domain");

-- CreateIndex
CREATE INDEX "AiGradeRun_analysisOutcomeId_createdAt_idx" ON "AiGradeRun"("analysisOutcomeId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiGradeRun_projectId_status_idx" ON "AiGradeRun"("projectId", "status");

-- CreateIndex
CREATE INDEX "GradeDomainSuggestion_runId_idx" ON "GradeDomainSuggestion"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "GradeDomainSuggestion_analysisOutcomeId_domain_key" ON "GradeDomainSuggestion"("analysisOutcomeId", "domain");

-- AddForeignKey
ALTER TABLE "GradeAssessment" ADD CONSTRAINT "GradeAssessment_analysisOutcomeId_fkey" FOREIGN KEY ("analysisOutcomeId") REFERENCES "AnalysisOutcome"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeAssessment" ADD CONSTRAINT "GradeAssessment_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeAssessment" ADD CONSTRAINT "GradeAssessment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeDomainRating" ADD CONSTRAINT "GradeDomainRating_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "GradeAssessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeDomainRating" ADD CONSTRAINT "GradeDomainRating_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGradeRun" ADD CONSTRAINT "AiGradeRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGradeRun" ADD CONSTRAINT "AiGradeRun_analysisOutcomeId_fkey" FOREIGN KEY ("analysisOutcomeId") REFERENCES "AnalysisOutcome"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGradeRun" ADD CONSTRAINT "AiGradeRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeDomainSuggestion" ADD CONSTRAINT "GradeDomainSuggestion_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiGradeRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeDomainSuggestion" ADD CONSTRAINT "GradeDomainSuggestion_analysisOutcomeId_fkey" FOREIGN KEY ("analysisOutcomeId") REFERENCES "AnalysisOutcome"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
