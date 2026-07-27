-- Make the standard screening exclusion subgroups available in existing projects.
-- A case-insensitive match preserves any project-specific capitalization while widening
-- an existing stage-specific reason so screeners can use it at either screening stage.
WITH defaults(label, reason_order) AS (
  VALUES
    ('Wrong population', 0),
    ('Wrong intervention', 1),
    ('Wrong publication type', 2),
    ('Wrong outcomes', 3)
)
UPDATE "ExclusionReason" AS reason
SET
  "stage" = 'BOTH'::"ReasonStage",
  "updatedAt" = CURRENT_TIMESTAMP
FROM defaults
WHERE lower(reason."label") = lower(defaults.label)
  AND reason."stage" <> 'BOTH'::"ReasonStage";

WITH defaults(label, reason_order) AS (
  VALUES
    ('Wrong population', 0),
    ('Wrong intervention', 1),
    ('Wrong publication type', 2),
    ('Wrong outcomes', 3)
)
INSERT INTO "ExclusionReason" (
  "id",
  "projectId",
  "label",
  "stage",
  "order",
  "isActive",
  "createdAt",
  "updatedAt"
)
SELECT
  'er_' || md5(project."id" || ':' || defaults.label),
  project."id",
  defaults.label,
  'BOTH'::"ReasonStage",
  defaults.reason_order,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Project" AS project
CROSS JOIN defaults
WHERE NOT EXISTS (
  SELECT 1
  FROM "ExclusionReason" AS existing
  WHERE existing."projectId" = project."id"
    AND lower(existing."label") = lower(defaults.label)
);
