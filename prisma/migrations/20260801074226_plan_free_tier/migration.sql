-- Add FREE to Plan and make it the default for new accounts.
-- Postgres refuses ADD VALUE + use-in-default inside one transaction, so the
-- enum is recreated instead — safe here because the column is days old.
CREATE TYPE "Plan_new" AS ENUM ('FREE', 'STARTER', 'BUSINESS');
ALTER TABLE "User" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "plan" TYPE "Plan_new" USING ("plan"::text::"Plan_new");
DROP TYPE "Plan";
ALTER TYPE "Plan_new" RENAME TO "Plan";
ALTER TABLE "User" ALTER COLUMN "plan" SET DEFAULT 'FREE';
