-- CreateEnum
CREATE TYPE "EffectMeasure" AS ENUM ('RR', 'OR', 'RD', 'MD', 'SMD', 'PROPORTION', 'GENERIC_IV');

-- CreateEnum
CREATE TYPE "PoolingModel" AS ENUM ('FIXED', 'RANDOM');

-- CreateEnum
CREATE TYPE "ProportionTransform" AS ENUM ('LOGIT', 'FREEMAN_TUKEY');

-- CreateEnum
CREATE TYPE "EffectDirection" AS ENUM ('HIGHER_IS_BETTER', 'LOWER_IS_BETTER');

-- CreateEnum
CREATE TYPE "AnalysisRole" AS ENUM ('G1_EVENTS', 'G1_TOTAL', 'G2_EVENTS', 'G2_TOTAL', 'G1_MEAN', 'G1_SD', 'G1_N', 'G2_MEAN', 'G2_SD', 'G2_N', 'EFFECT_ESTIMATE', 'EFFECT_SE', 'EFFECT_CI_LOW', 'EFFECT_CI_UP', 'STUDY_DESIGN');

-- CreateTable
CREATE TABLE "AnalysisOutcome" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "outcomeDefinitionId" TEXT,
    "name" TEXT NOT NULL,
    "timepoint" TEXT,
    "measure" "EffectMeasure" NOT NULL,
    "direction" "EffectDirection" NOT NULL DEFAULT 'LOWER_IS_BETTER',
    "model" "PoolingModel" NOT NULL DEFAULT 'RANDOM',
    "proportionTransform" "ProportionTransform" NOT NULL DEFAULT 'LOGIT',
    "groupLabels" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisFieldMap" (
    "id" TEXT NOT NULL,
    "analysisOutcomeId" TEXT NOT NULL,
    "role" "AnalysisRole" NOT NULL,
    "templateId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,

    CONSTRAINT "AnalysisFieldMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisStudyExclusion" (
    "id" TEXT NOT NULL,
    "analysisOutcomeId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisStudyExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalysisOutcome_projectId_order_idx" ON "AnalysisOutcome"("projectId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisFieldMap_analysisOutcomeId_role_key" ON "AnalysisFieldMap"("analysisOutcomeId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisStudyExclusion_analysisOutcomeId_studyId_key" ON "AnalysisStudyExclusion"("analysisOutcomeId", "studyId");

-- AddForeignKey
ALTER TABLE "AnalysisOutcome" ADD CONSTRAINT "AnalysisOutcome_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisOutcome" ADD CONSTRAINT "AnalysisOutcome_outcomeDefinitionId_fkey" FOREIGN KEY ("outcomeDefinitionId") REFERENCES "OutcomeDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisOutcome" ADD CONSTRAINT "AnalysisOutcome_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisFieldMap" ADD CONSTRAINT "AnalysisFieldMap_analysisOutcomeId_fkey" FOREIGN KEY ("analysisOutcomeId") REFERENCES "AnalysisOutcome"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisFieldMap" ADD CONSTRAINT "AnalysisFieldMap_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ExtractionTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisStudyExclusion" ADD CONSTRAINT "AnalysisStudyExclusion_analysisOutcomeId_fkey" FOREIGN KEY ("analysisOutcomeId") REFERENCES "AnalysisOutcome"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisStudyExclusion" ADD CONSTRAINT "AnalysisStudyExclusion_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisStudyExclusion" ADD CONSTRAINT "AnalysisStudyExclusion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
