-- Assessment-level freshness covers every rating origin plus applicability context. Nullable
-- keeps the migration safe for any draft created before this version; null is treated as stale
-- until the draft is regenerated.
ALTER TABLE "GradeAssessment" ADD COLUMN "sourceFingerprint" TEXT;
