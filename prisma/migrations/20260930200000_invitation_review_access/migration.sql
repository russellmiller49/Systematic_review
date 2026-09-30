ALTER TABLE "OrganizationInvitation" ADD COLUMN "projectAccess" JSONB;
ALTER TABLE "ScreeningQuota" ALTER COLUMN "target" DROP NOT NULL;
