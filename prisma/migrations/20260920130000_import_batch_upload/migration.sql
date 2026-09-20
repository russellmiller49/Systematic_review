-- Preserve original decoded uploads separately from parsed citation rows.
-- Historical batches have no upload: normalized chunks cannot reconstruct it.
CREATE TABLE "ImportBatchUpload" (
    "batchId" TEXT NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "ImportBatchUpload_pkey" PRIMARY KEY ("batchId")
);

ALTER TABLE "ImportBatchUpload" ADD CONSTRAINT "ImportBatchUpload_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
