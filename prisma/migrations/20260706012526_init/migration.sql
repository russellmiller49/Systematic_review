-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('OWNER', 'ADMIN', 'REVIEWER', 'ADJUDICATOR', 'EXTRACTOR', 'STATISTICIAN', 'LIBRARIAN', 'PANEL_MEMBER', 'TRAINEE', 'OBSERVER');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "ReviewType" AS ENUM ('SYSTEMATIC_REVIEW', 'SYSTEMATIC_REVIEW_META_ANALYSIS', 'DIAGNOSTIC_TEST_ACCURACY', 'SCOPING_REVIEW', 'RAPID_REVIEW', 'LIVING_SYSTEMATIC_REVIEW', 'GUIDELINE_EVIDENCE_REVIEW');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNING', 'SCREENING', 'EXTRACTION', 'ANALYSIS', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CriterionType" AS ENUM ('INCLUSION', 'EXCLUSION');

-- CreateEnum
CREATE TYPE "OutcomeType" AS ENUM ('PRIMARY', 'SECONDARY');

-- CreateEnum
CREATE TYPE "ImportFormat" AS ENUM ('RIS', 'BIBTEX', 'CSV', 'NBIB');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PREVIEWED', 'COMMITTED', 'FAILED');

-- CreateEnum
CREATE TYPE "CitationStatus" AS ENUM ('ACTIVE', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "IdentifierType" AS ENUM ('DOI', 'PMID', 'PMCID', 'URL', 'ISBN', 'REGISTRY_ID', 'OTHER');

-- CreateEnum
CREATE TYPE "DedupMethod" AS ENUM ('EXACT_DOI', 'EXACT_PMID', 'NORMALIZED_TITLE', 'FUZZY');

-- CreateEnum
CREATE TYPE "DedupCandidateStatus" AS ENUM ('SUGGESTED', 'MERGED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DedupGroupStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "StageType" AS ENUM ('TITLE_ABSTRACT', 'FULL_TEXT');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('PENDING', 'COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "ResolutionVia" AS ENUM ('CONSENSUS', 'ADJUDICATION', 'SINGLE_REVIEWER');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('INCLUDE', 'EXCLUDE', 'MAYBE', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('OPEN', 'RESOLVED', 'VOIDED');

-- CreateEnum
CREATE TYPE "ReasonStage" AS ENUM ('TITLE_ABSTRACT', 'FULL_TEXT', 'BOTH');

-- CreateEnum
CREATE TYPE "RetrievalOutcome" AS ENUM ('PENDING', 'RETRIEVED', 'NOT_RETRIEVED');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'TEXTAREA', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'MULTI_SELECT', 'BOOLEAN');

-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ExportKind" AS ENUM ('CITATIONS', 'SCREENING', 'EXTRACTION', 'ROB', 'PRISMA', 'AUDIT', 'FULL');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('CSV', 'JSON');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "passwordChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reviewType" "ReviewType" NOT NULL,
    "researchQuestion" TEXT,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PLANNING',
    "registrationPlatform" TEXT,
    "registrationId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roles" "ProjectRole"[],
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectInvitation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roles" "ProjectRole"[],
    "token" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Protocol" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "background" TEXT,
    "reviewQuestion" TEXT,
    "population" TEXT,
    "intervention" TEXT,
    "comparator" TEXT,
    "outcomesNarrative" TEXT,
    "studyDesigns" TEXT[],
    "setting" TEXT,
    "dateRestrictionFrom" INTEGER,
    "dateRestrictionTo" INTEGER,
    "languageRestrictions" TEXT[],
    "databases" TEXT[],
    "grayLiteratureSources" TEXT[],
    "searchStrategyNotes" TEXT,
    "subgroupAnalysisPlan" TEXT,
    "sensitivityAnalysisPlan" TEXT,
    "metaAnalysisPlan" TEXT,
    "gradePlan" TEXT,
    "extractionTemplateId" TEXT,
    "riskOfBiasToolId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Protocol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PICOQuestion" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "question" TEXT NOT NULL,
    "population" TEXT,
    "intervention" TEXT,
    "comparator" TEXT,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PICOQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EligibilityCriterion" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "type" "CriterionType" NOT NULL,
    "category" TEXT,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EligibilityCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutcomeDefinition" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "OutcomeType" NOT NULL DEFAULT 'PRIMARY',
    "measure" TEXT,
    "timepoint" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutcomeDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolVersion" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtocolVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolAmendment" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtocolAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExclusionReason" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "stage" "ReasonStage" NOT NULL DEFAULT 'BOTH',
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExclusionReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportSource" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "format" "ImportFormat" NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PREVIEWED',
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "parsedRecords" INTEGER NOT NULL DEFAULT 0,
    "failedRecords" INTEGER NOT NULL DEFAULT 0,
    "committedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Citation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "CitationStatus" NOT NULL DEFAULT 'ACTIVE',
    "duplicateOfId" TEXT,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "authors" JSONB NOT NULL,
    "year" INTEGER,
    "journal" TEXT,
    "volume" TEXT,
    "issue" TEXT,
    "pages" TEXT,
    "abstract" TEXT,
    "doi" TEXT,
    "pmid" TEXT,
    "url" TEXT,
    "language" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Citation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitationSourceRecord" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "citationId" TEXT,
    "rowNumber" INTEGER NOT NULL,
    "rawRecord" TEXT NOT NULL,
    "parsed" JSONB,
    "parseErrors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationSourceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitationIdentifier" (
    "id" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "type" "IdentifierType" NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "CitationIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeduplicationGroup" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "DedupGroupStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeduplicationGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeduplicationCandidate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "groupId" TEXT,
    "citationAId" TEXT NOT NULL,
    "citationBId" TEXT NOT NULL,
    "method" "DedupMethod" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reasons" JSONB NOT NULL,
    "status" "DedupCandidateStatus" NOT NULL DEFAULT 'SUGGESTED',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeduplicationCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Study" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "notes" TEXT,
    "inQuantitativeSynthesis" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Study_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudyReportLink" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "isPrimaryReport" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "StudyReportLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningStage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "StageType" NOT NULL,
    "reviewersPerCitation" INTEGER NOT NULL DEFAULT 2,
    "blinded" BOOLEAN NOT NULL DEFAULT true,
    "maybeGeneratesConflict" BOOLEAN NOT NULL DEFAULT true,
    "unblindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitationStageResult" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "outcome" "Decision" NOT NULL,
    "resolvedVia" "ResolutionVia" NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationStageResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningAssignment" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningDecision" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "Decision" NOT NULL,
    "exclusionReasonId" TEXT,
    "notes" TEXT,
    "labels" TEXT[],
    "flaggedForDiscussion" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningConflict" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ScreeningConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningAdjudication" (
    "id" TEXT NOT NULL,
    "conflictId" TEXT NOT NULL,
    "adjudicatorId" TEXT NOT NULL,
    "finalDecision" "Decision" NOT NULL,
    "exclusionReasonId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreeningAdjudication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FullTextFile" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FullTextFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitationFullTextLink" (
    "id" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationFullTextLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FullTextRetrievalAttempt" (
    "id" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "outcome" "RetrievalOutcome" NOT NULL,
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FullTextRetrievalAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionTemplate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "sourceTemplateId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionField" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "FieldType" NOT NULL,
    "section" TEXT,
    "helpText" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionAssignment" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "extractorId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionForm" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "citationId" TEXT,
    "extractorId" TEXT NOT NULL,
    "status" "FormStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionValue" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "sourceQuote" TEXT,
    "pageNumber" INTEGER,
    "notes" TEXT,
    "sourceAnchor" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionConflict" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ExtractionConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionAdjudication" (
    "id" TEXT NOT NULL,
    "conflictId" TEXT NOT NULL,
    "adjudicatorId" TEXT NOT NULL,
    "finalValue" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractionAdjudication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskOfBiasTool" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isBuiltin" BOOLEAN NOT NULL DEFAULT false,
    "judgmentScale" JSONB NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskOfBiasTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskOfBiasAssignment" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "assessorId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskOfBiasAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskOfBiasDomain" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "guidance" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RiskOfBiasDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskOfBiasSignalingQuestion" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "guidance" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "allowedAnswers" JSONB NOT NULL,

    CONSTRAINT "RiskOfBiasSignalingQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskOfBiasAssessment" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "assessorId" TEXT NOT NULL,
    "status" "FormStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "overallJudgment" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskOfBiasAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskOfBiasJudgment" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "judgment" TEXT NOT NULL,
    "support" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskOfBiasJudgment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskOfBiasSignalingResponse" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "RiskOfBiasSignalingResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskOfBiasConflict" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "domainId" TEXT,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "RiskOfBiasConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskOfBiasAdjudication" (
    "id" TEXT NOT NULL,
    "conflictId" TEXT NOT NULL,
    "adjudicatorId" TEXT NOT NULL,
    "finalJudgment" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskOfBiasAdjudication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrismaSnapshot" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrismaSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrismaCount" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "breakdown" JSONB,

    CONSTRAINT "PrismaCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousValue" JSONB,
    "newValue" JSONB,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "ExportKind" NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT,
    "error" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_orgId_userId_key" ON "OrganizationMember"("orgId", "userId");

-- CreateIndex
CREATE INDEX "Project_orgId_idx" ON "Project"("orgId");

-- CreateIndex
CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectInvitation_token_key" ON "ProjectInvitation"("token");

-- CreateIndex
CREATE INDEX "ProjectInvitation_projectId_idx" ON "ProjectInvitation"("projectId");

-- CreateIndex
CREATE INDEX "ProjectInvitation_email_idx" ON "ProjectInvitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Protocol_projectId_key" ON "Protocol"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Protocol_extractionTemplateId_key" ON "Protocol"("extractionTemplateId");

-- CreateIndex
CREATE INDEX "PICOQuestion_protocolId_idx" ON "PICOQuestion"("protocolId");

-- CreateIndex
CREATE INDEX "EligibilityCriterion_protocolId_type_idx" ON "EligibilityCriterion"("protocolId", "type");

-- CreateIndex
CREATE INDEX "OutcomeDefinition_protocolId_idx" ON "OutcomeDefinition"("protocolId");

-- CreateIndex
CREATE UNIQUE INDEX "ProtocolVersion_protocolId_versionNumber_key" ON "ProtocolVersion"("protocolId", "versionNumber");

-- CreateIndex
CREATE INDEX "ProtocolAmendment_protocolId_idx" ON "ProtocolAmendment"("protocolId");

-- CreateIndex
CREATE UNIQUE INDEX "ExclusionReason_projectId_label_key" ON "ExclusionReason"("projectId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "ImportSource_projectId_name_key" ON "ImportSource"("projectId", "name");

-- CreateIndex
CREATE INDEX "ImportBatch_projectId_idx" ON "ImportBatch"("projectId");

-- CreateIndex
CREATE INDEX "Citation_projectId_status_idx" ON "Citation"("projectId", "status");

-- CreateIndex
CREATE INDEX "Citation_projectId_normalizedTitle_idx" ON "Citation"("projectId", "normalizedTitle");

-- CreateIndex
CREATE INDEX "Citation_projectId_doi_idx" ON "Citation"("projectId", "doi");

-- CreateIndex
CREATE INDEX "Citation_projectId_pmid_idx" ON "Citation"("projectId", "pmid");

-- CreateIndex
CREATE INDEX "CitationSourceRecord_batchId_idx" ON "CitationSourceRecord"("batchId");

-- CreateIndex
CREATE INDEX "CitationSourceRecord_citationId_idx" ON "CitationSourceRecord"("citationId");

-- CreateIndex
CREATE INDEX "CitationIdentifier_type_value_idx" ON "CitationIdentifier"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "CitationIdentifier_citationId_type_value_key" ON "CitationIdentifier"("citationId", "type", "value");

-- CreateIndex
CREATE INDEX "DeduplicationGroup_projectId_status_idx" ON "DeduplicationGroup"("projectId", "status");

-- CreateIndex
CREATE INDEX "DeduplicationCandidate_citationBId_idx" ON "DeduplicationCandidate"("citationBId");

-- CreateIndex
CREATE INDEX "DeduplicationCandidate_projectId_status_idx" ON "DeduplicationCandidate"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeduplicationCandidate_citationAId_citationBId_key" ON "DeduplicationCandidate"("citationAId", "citationBId");

-- CreateIndex
CREATE INDEX "Study_projectId_idx" ON "Study"("projectId");

-- CreateIndex
CREATE INDEX "StudyReportLink_citationId_idx" ON "StudyReportLink"("citationId");

-- CreateIndex
CREATE UNIQUE INDEX "StudyReportLink_studyId_citationId_key" ON "StudyReportLink"("studyId", "citationId");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningStage_projectId_type_key" ON "ScreeningStage"("projectId", "type");

-- CreateIndex
CREATE INDEX "CitationStageResult_stageId_outcome_idx" ON "CitationStageResult"("stageId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "CitationStageResult_stageId_citationId_key" ON "CitationStageResult"("stageId", "citationId");

-- CreateIndex
CREATE INDEX "ScreeningAssignment_reviewerId_status_idx" ON "ScreeningAssignment"("reviewerId", "status");

-- CreateIndex
CREATE INDEX "ScreeningAssignment_stageId_citationId_idx" ON "ScreeningAssignment"("stageId", "citationId");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningAssignment_stageId_citationId_reviewerId_key" ON "ScreeningAssignment"("stageId", "citationId", "reviewerId");

-- CreateIndex
CREATE INDEX "ScreeningDecision_stageId_decision_idx" ON "ScreeningDecision"("stageId", "decision");

-- CreateIndex
CREATE INDEX "ScreeningDecision_citationId_idx" ON "ScreeningDecision"("citationId");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningDecision_stageId_citationId_reviewerId_key" ON "ScreeningDecision"("stageId", "citationId", "reviewerId");

-- CreateIndex
CREATE INDEX "ScreeningConflict_stageId_status_idx" ON "ScreeningConflict"("stageId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningConflict_stageId_citationId_key" ON "ScreeningConflict"("stageId", "citationId");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningAdjudication_conflictId_key" ON "ScreeningAdjudication"("conflictId");

-- CreateIndex
CREATE UNIQUE INDEX "FullTextFile_storageKey_key" ON "FullTextFile"("storageKey");

-- CreateIndex
CREATE INDEX "FullTextFile_projectId_idx" ON "FullTextFile"("projectId");

-- CreateIndex
CREATE INDEX "FullTextFile_sha256_idx" ON "FullTextFile"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "CitationFullTextLink_citationId_fileId_key" ON "CitationFullTextLink"("citationId", "fileId");

-- CreateIndex
CREATE INDEX "FullTextRetrievalAttempt_citationId_idx" ON "FullTextRetrievalAttempt"("citationId");

-- CreateIndex
CREATE INDEX "ExtractionTemplate_projectId_idx" ON "ExtractionTemplate"("projectId");

-- CreateIndex
CREATE INDEX "ExtractionField_templateId_order_idx" ON "ExtractionField"("templateId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionField_templateId_key_key" ON "ExtractionField"("templateId", "key");

-- CreateIndex
CREATE INDEX "ExtractionAssignment_extractorId_status_idx" ON "ExtractionAssignment"("extractorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionAssignment_templateId_studyId_extractorId_key" ON "ExtractionAssignment"("templateId", "studyId", "extractorId");

-- CreateIndex
CREATE INDEX "ExtractionForm_studyId_idx" ON "ExtractionForm"("studyId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionForm_templateId_studyId_extractorId_key" ON "ExtractionForm"("templateId", "studyId", "extractorId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionValue_formId_fieldId_key" ON "ExtractionValue"("formId", "fieldId");

-- CreateIndex
CREATE INDEX "ExtractionConflict_templateId_status_idx" ON "ExtractionConflict"("templateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionConflict_studyId_fieldId_key" ON "ExtractionConflict"("studyId", "fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionAdjudication_conflictId_key" ON "ExtractionAdjudication"("conflictId");

-- CreateIndex
CREATE INDEX "RiskOfBiasTool_projectId_idx" ON "RiskOfBiasTool"("projectId");

-- CreateIndex
CREATE INDEX "RiskOfBiasAssignment_assessorId_status_idx" ON "RiskOfBiasAssignment"("assessorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RiskOfBiasAssignment_toolId_studyId_assessorId_key" ON "RiskOfBiasAssignment"("toolId", "studyId", "assessorId");

-- CreateIndex
CREATE INDEX "RiskOfBiasDomain_toolId_order_idx" ON "RiskOfBiasDomain"("toolId", "order");

-- CreateIndex
CREATE INDEX "RiskOfBiasSignalingQuestion_domainId_order_idx" ON "RiskOfBiasSignalingQuestion"("domainId", "order");

-- CreateIndex
CREATE INDEX "RiskOfBiasAssessment_studyId_idx" ON "RiskOfBiasAssessment"("studyId");

-- CreateIndex
CREATE UNIQUE INDEX "RiskOfBiasAssessment_toolId_studyId_assessorId_key" ON "RiskOfBiasAssessment"("toolId", "studyId", "assessorId");

-- CreateIndex
CREATE UNIQUE INDEX "RiskOfBiasJudgment_assessmentId_domainId_key" ON "RiskOfBiasJudgment"("assessmentId", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "RiskOfBiasSignalingResponse_assessmentId_questionId_key" ON "RiskOfBiasSignalingResponse"("assessmentId", "questionId");

-- CreateIndex
CREATE INDEX "RiskOfBiasConflict_toolId_status_idx" ON "RiskOfBiasConflict"("toolId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RiskOfBiasConflict_studyId_domainId_key" ON "RiskOfBiasConflict"("studyId", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "RiskOfBiasAdjudication_conflictId_key" ON "RiskOfBiasAdjudication"("conflictId");

-- CreateIndex
CREATE INDEX "PrismaSnapshot_projectId_idx" ON "PrismaSnapshot"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "PrismaCount_snapshotId_key_key" ON "PrismaCount"("snapshotId", "key");

-- CreateIndex
CREATE INDEX "AuditEvent_projectId_createdAt_idx" ON "AuditEvent"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditEvent_projectId_userId_idx" ON "AuditEvent"("projectId", "userId");

-- CreateIndex
CREATE INDEX "AuditEvent_projectId_action_idx" ON "AuditEvent"("projectId", "action");

-- CreateIndex
CREATE INDEX "ExportJob_projectId_idx" ON "ExportJob"("projectId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Protocol" ADD CONSTRAINT "Protocol_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Protocol" ADD CONSTRAINT "Protocol_extractionTemplateId_fkey" FOREIGN KEY ("extractionTemplateId") REFERENCES "ExtractionTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Protocol" ADD CONSTRAINT "Protocol_riskOfBiasToolId_fkey" FOREIGN KEY ("riskOfBiasToolId") REFERENCES "RiskOfBiasTool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PICOQuestion" ADD CONSTRAINT "PICOQuestion_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "Protocol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EligibilityCriterion" ADD CONSTRAINT "EligibilityCriterion_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "Protocol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutcomeDefinition" ADD CONSTRAINT "OutcomeDefinition_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "Protocol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtocolVersion" ADD CONSTRAINT "ProtocolVersion_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "Protocol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtocolVersion" ADD CONSTRAINT "ProtocolVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtocolAmendment" ADD CONSTRAINT "ProtocolAmendment_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "Protocol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtocolAmendment" ADD CONSTRAINT "ProtocolAmendment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExclusionReason" ADD CONSTRAINT "ExclusionReason_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportSource" ADD CONSTRAINT "ImportSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ImportSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Citation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationSourceRecord" ADD CONSTRAINT "CitationSourceRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationSourceRecord" ADD CONSTRAINT "CitationSourceRecord_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationIdentifier" ADD CONSTRAINT "CitationIdentifier_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeduplicationGroup" ADD CONSTRAINT "DeduplicationGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeduplicationCandidate" ADD CONSTRAINT "DeduplicationCandidate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeduplicationCandidate" ADD CONSTRAINT "DeduplicationCandidate_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DeduplicationGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeduplicationCandidate" ADD CONSTRAINT "DeduplicationCandidate_citationAId_fkey" FOREIGN KEY ("citationAId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeduplicationCandidate" ADD CONSTRAINT "DeduplicationCandidate_citationBId_fkey" FOREIGN KEY ("citationBId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeduplicationCandidate" ADD CONSTRAINT "DeduplicationCandidate_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Study" ADD CONSTRAINT "Study_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Study" ADD CONSTRAINT "Study_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudyReportLink" ADD CONSTRAINT "StudyReportLink_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudyReportLink" ADD CONSTRAINT "StudyReportLink_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningStage" ADD CONSTRAINT "ScreeningStage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationStageResult" ADD CONSTRAINT "CitationStageResult_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ScreeningStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationStageResult" ADD CONSTRAINT "CitationStageResult_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningAssignment" ADD CONSTRAINT "ScreeningAssignment_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ScreeningStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningAssignment" ADD CONSTRAINT "ScreeningAssignment_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningAssignment" ADD CONSTRAINT "ScreeningAssignment_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningDecision" ADD CONSTRAINT "ScreeningDecision_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ScreeningStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningDecision" ADD CONSTRAINT "ScreeningDecision_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningDecision" ADD CONSTRAINT "ScreeningDecision_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningDecision" ADD CONSTRAINT "ScreeningDecision_exclusionReasonId_fkey" FOREIGN KEY ("exclusionReasonId") REFERENCES "ExclusionReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningConflict" ADD CONSTRAINT "ScreeningConflict_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ScreeningStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningConflict" ADD CONSTRAINT "ScreeningConflict_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningAdjudication" ADD CONSTRAINT "ScreeningAdjudication_conflictId_fkey" FOREIGN KEY ("conflictId") REFERENCES "ScreeningConflict"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningAdjudication" ADD CONSTRAINT "ScreeningAdjudication_adjudicatorId_fkey" FOREIGN KEY ("adjudicatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningAdjudication" ADD CONSTRAINT "ScreeningAdjudication_exclusionReasonId_fkey" FOREIGN KEY ("exclusionReasonId") REFERENCES "ExclusionReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FullTextFile" ADD CONSTRAINT "FullTextFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FullTextFile" ADD CONSTRAINT "FullTextFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationFullTextLink" ADD CONSTRAINT "CitationFullTextLink_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationFullTextLink" ADD CONSTRAINT "CitationFullTextLink_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FullTextFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FullTextRetrievalAttempt" ADD CONSTRAINT "FullTextRetrievalAttempt_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FullTextRetrievalAttempt" ADD CONSTRAINT "FullTextRetrievalAttempt_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionTemplate" ADD CONSTRAINT "ExtractionTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionTemplate" ADD CONSTRAINT "ExtractionTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionTemplate" ADD CONSTRAINT "ExtractionTemplate_sourceTemplateId_fkey" FOREIGN KEY ("sourceTemplateId") REFERENCES "ExtractionTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionField" ADD CONSTRAINT "ExtractionField_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ExtractionTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionAssignment" ADD CONSTRAINT "ExtractionAssignment_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ExtractionTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionAssignment" ADD CONSTRAINT "ExtractionAssignment_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionAssignment" ADD CONSTRAINT "ExtractionAssignment_extractorId_fkey" FOREIGN KEY ("extractorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionForm" ADD CONSTRAINT "ExtractionForm_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ExtractionTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionForm" ADD CONSTRAINT "ExtractionForm_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionForm" ADD CONSTRAINT "ExtractionForm_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionForm" ADD CONSTRAINT "ExtractionForm_extractorId_fkey" FOREIGN KEY ("extractorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionValue" ADD CONSTRAINT "ExtractionValue_formId_fkey" FOREIGN KEY ("formId") REFERENCES "ExtractionForm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionValue" ADD CONSTRAINT "ExtractionValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "ExtractionField"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionConflict" ADD CONSTRAINT "ExtractionConflict_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ExtractionTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionConflict" ADD CONSTRAINT "ExtractionConflict_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionConflict" ADD CONSTRAINT "ExtractionConflict_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "ExtractionField"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionAdjudication" ADD CONSTRAINT "ExtractionAdjudication_conflictId_fkey" FOREIGN KEY ("conflictId") REFERENCES "ExtractionConflict"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionAdjudication" ADD CONSTRAINT "ExtractionAdjudication_adjudicatorId_fkey" FOREIGN KEY ("adjudicatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasTool" ADD CONSTRAINT "RiskOfBiasTool_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasTool" ADD CONSTRAINT "RiskOfBiasTool_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasAssignment" ADD CONSTRAINT "RiskOfBiasAssignment_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "RiskOfBiasTool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasAssignment" ADD CONSTRAINT "RiskOfBiasAssignment_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasAssignment" ADD CONSTRAINT "RiskOfBiasAssignment_assessorId_fkey" FOREIGN KEY ("assessorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasDomain" ADD CONSTRAINT "RiskOfBiasDomain_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "RiskOfBiasTool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasSignalingQuestion" ADD CONSTRAINT "RiskOfBiasSignalingQuestion_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "RiskOfBiasDomain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasAssessment" ADD CONSTRAINT "RiskOfBiasAssessment_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "RiskOfBiasTool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasAssessment" ADD CONSTRAINT "RiskOfBiasAssessment_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasAssessment" ADD CONSTRAINT "RiskOfBiasAssessment_assessorId_fkey" FOREIGN KEY ("assessorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasJudgment" ADD CONSTRAINT "RiskOfBiasJudgment_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "RiskOfBiasAssessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasJudgment" ADD CONSTRAINT "RiskOfBiasJudgment_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "RiskOfBiasDomain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasSignalingResponse" ADD CONSTRAINT "RiskOfBiasSignalingResponse_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "RiskOfBiasAssessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasSignalingResponse" ADD CONSTRAINT "RiskOfBiasSignalingResponse_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "RiskOfBiasSignalingQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasConflict" ADD CONSTRAINT "RiskOfBiasConflict_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "RiskOfBiasTool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasConflict" ADD CONSTRAINT "RiskOfBiasConflict_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasConflict" ADD CONSTRAINT "RiskOfBiasConflict_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "RiskOfBiasDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasAdjudication" ADD CONSTRAINT "RiskOfBiasAdjudication_conflictId_fkey" FOREIGN KEY ("conflictId") REFERENCES "RiskOfBiasConflict"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskOfBiasAdjudication" ADD CONSTRAINT "RiskOfBiasAdjudication_adjudicatorId_fkey" FOREIGN KEY ("adjudicatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaSnapshot" ADD CONSTRAINT "PrismaSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaSnapshot" ADD CONSTRAINT "PrismaSnapshot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrismaCount" ADD CONSTRAINT "PrismaCount_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PrismaSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
