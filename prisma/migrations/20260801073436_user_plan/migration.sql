-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('STARTER', 'BUSINESS');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "plan" "Plan" NOT NULL DEFAULT 'STARTER';
