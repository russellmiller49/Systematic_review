-- CreateTable
CREATE TABLE "ReferenceEntry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "csl" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "firstAuthor" TEXT,
    "year" INTEGER,
    "doi" TEXT,
    "pmid" TEXT,
    "tags" TEXT[],
    "notes" TEXT,
    "citationId" TEXT,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferenceEntry_projectId_title_idx" ON "ReferenceEntry"("projectId", "title");

-- CreateIndex
CREATE INDEX "ReferenceEntry_projectId_createdAt_idx" ON "ReferenceEntry"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceEntry_projectId_doi_key" ON "ReferenceEntry"("projectId", "doi");

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceEntry_projectId_citationId_key" ON "ReferenceEntry"("projectId", "citationId");

-- AddForeignKey
ALTER TABLE "ReferenceEntry" ADD CONSTRAINT "ReferenceEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferenceEntry" ADD CONSTRAINT "ReferenceEntry_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferenceEntry" ADD CONSTRAINT "ReferenceEntry_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
