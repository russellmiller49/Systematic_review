-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "isGuideline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parentProjectId" TEXT;

-- CreateIndex
CREATE INDEX "Project_parentProjectId_idx" ON "Project"("parentProjectId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_parentProjectId_fkey" FOREIGN KEY ("parentProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
