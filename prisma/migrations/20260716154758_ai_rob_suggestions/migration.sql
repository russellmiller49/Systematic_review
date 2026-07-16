-- CreateTable
CREATE TABLE "AiRobRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "totalDomains" INTEGER NOT NULL DEFAULT 0,
    "suggestedCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "notFoundCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "usage" JSONB,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiRobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RobSuggestion" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "suggestedJudgment" TEXT,
    "rationale" TEXT NOT NULL,
    "quotes" JSONB NOT NULL,
    "signalingAnswers" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION,
    "notFound" BOOLEAN NOT NULL DEFAULT false,
    "invalidReason" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RobSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiRobRun_studyId_toolId_createdAt_idx" ON "AiRobRun"("studyId", "toolId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiRobRun_projectId_status_idx" ON "AiRobRun"("projectId", "status");

-- CreateIndex
CREATE INDEX "RobSuggestion_runId_idx" ON "RobSuggestion"("runId");

-- CreateIndex
CREATE INDEX "RobSuggestion_studyId_idx" ON "RobSuggestion"("studyId");

-- CreateIndex
CREATE UNIQUE INDEX "RobSuggestion_toolId_studyId_domainId_key" ON "RobSuggestion"("toolId", "studyId", "domainId");

-- AddForeignKey
ALTER TABLE "AiRobRun" ADD CONSTRAINT "AiRobRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRobRun" ADD CONSTRAINT "AiRobRun_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRobRun" ADD CONSTRAINT "AiRobRun_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "RiskOfBiasTool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRobRun" ADD CONSTRAINT "AiRobRun_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FullTextFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRobRun" ADD CONSTRAINT "AiRobRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RobSuggestion" ADD CONSTRAINT "RobSuggestion_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRobRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RobSuggestion" ADD CONSTRAINT "RobSuggestion_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "RiskOfBiasTool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RobSuggestion" ADD CONSTRAINT "RobSuggestion_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RobSuggestion" ADD CONSTRAINT "RobSuggestion_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "RiskOfBiasDomain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
