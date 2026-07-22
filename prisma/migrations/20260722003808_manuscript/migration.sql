-- CreateEnum
CREATE TYPE "ManuscriptSectionKind" AS ENUM ('TITLE_PAGE', 'ABSTRACT', 'INTRODUCTION', 'METHODS', 'RESULTS', 'DISCUSSION', 'CONCLUSION', 'ACKNOWLEDGMENTS', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ManuscriptSectionStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED');

-- CreateEnum
CREATE TYPE "ManuscriptVersionOrigin" AS ENUM ('EXPLICIT', 'LOCK_RELEASE', 'TAKEOVER', 'RESTORE');

-- CreateEnum
CREATE TYPE "ManuscriptCommentStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "Manuscript" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Manuscript',
    "citationStyleId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Manuscript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManuscriptSection" (
    "id" TEXT NOT NULL,
    "manuscriptId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "ManuscriptSectionKind" NOT NULL DEFAULT 'CUSTOM',
    "order" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "contentText" TEXT NOT NULL DEFAULT '',
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "status" "ManuscriptSectionStatus" NOT NULL DEFAULT 'DRAFT',
    "assigneeId" TEXT,
    "lockedById" TEXT,
    "lockAcquiredAt" TIMESTAMP(3),
    "lockHeartbeatAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManuscriptSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManuscriptSectionVersion" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "capturedVersion" INTEGER NOT NULL,
    "origin" "ManuscriptVersionOrigin" NOT NULL,
    "content" JSONB NOT NULL,
    "contentText" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "note" TEXT,
    "savedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManuscriptSectionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManuscriptComment" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "quotedText" TEXT,
    "status" "ManuscriptCommentStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "mentions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManuscriptComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Manuscript_projectId_key" ON "Manuscript"("projectId");

-- CreateIndex
CREATE INDEX "ManuscriptSection_manuscriptId_order_idx" ON "ManuscriptSection"("manuscriptId", "order");

-- CreateIndex
CREATE INDEX "ManuscriptSection_assigneeId_idx" ON "ManuscriptSection"("assigneeId");

-- CreateIndex
CREATE INDEX "ManuscriptSectionVersion_sectionId_idx" ON "ManuscriptSectionVersion"("sectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptSectionVersion_sectionId_versionNumber_key" ON "ManuscriptSectionVersion"("sectionId", "versionNumber");

-- CreateIndex
CREATE INDEX "ManuscriptComment_sectionId_status_idx" ON "ManuscriptComment"("sectionId", "status");

-- CreateIndex
CREATE INDEX "ManuscriptComment_parentId_idx" ON "ManuscriptComment"("parentId");

-- AddForeignKey
ALTER TABLE "Manuscript" ADD CONSTRAINT "Manuscript_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Manuscript" ADD CONSTRAINT "Manuscript_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptSection" ADD CONSTRAINT "ManuscriptSection_manuscriptId_fkey" FOREIGN KEY ("manuscriptId") REFERENCES "Manuscript"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptSection" ADD CONSTRAINT "ManuscriptSection_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptSection" ADD CONSTRAINT "ManuscriptSection_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptSectionVersion" ADD CONSTRAINT "ManuscriptSectionVersion_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "ManuscriptSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptSectionVersion" ADD CONSTRAINT "ManuscriptSectionVersion_savedById_fkey" FOREIGN KEY ("savedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptComment" ADD CONSTRAINT "ManuscriptComment_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "ManuscriptSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptComment" ADD CONSTRAINT "ManuscriptComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptComment" ADD CONSTRAINT "ManuscriptComment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptComment" ADD CONSTRAINT "ManuscriptComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ManuscriptComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
