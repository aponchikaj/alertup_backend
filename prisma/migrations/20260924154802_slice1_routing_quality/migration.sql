/*
  Warnings:

  - A unique constraint covering the columns `[buildingId,externalId]` on the table `Node` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[buildingId,externalId]` on the table `Poi` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "EdgeDirection" AS ENUM ('BOTH', 'FORWARD', 'REVERSE');

-- CreateEnum
CREATE TYPE "EdgeRank" AS ENUM ('PRIMARY', 'SECONDARY');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'STAFF', 'EMERGENCY_ONLY');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'INTEGRATION');

-- AlterTable
ALTER TABLE "Building" ADD COLUMN     "routingProfile" JSONB;

-- AlterTable
ALTER TABLE "Edge" ADD COLUMN     "direction" "EdgeDirection" NOT NULL DEFAULT 'BOTH',
ADD COLUMN     "lengthM" DOUBLE PRECISION,
ADD COLUMN     "rank" "EdgeRank" NOT NULL DEFAULT 'PRIMARY',
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "visibility" "Visibility" NOT NULL DEFAULT 'PUBLIC';

-- AlterTable
ALTER TABLE "Floor" ADD COLUMN     "shortName" TEXT,
ADD COLUMN     "verticalOrder" INTEGER;

-- AlterTable
ALTER TABLE "Log" ADD COLUMN     "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM',
ADD COLUMN     "actorUserId" TEXT,
ADD COLUMN     "entity" TEXT,
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "payload" JSONB;

-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "visibility" "Visibility" NOT NULL DEFAULT 'PUBLIC';

-- AlterTable
ALTER TABLE "Poi" ADD COLUMN     "buildingId" TEXT,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "names" JSONB,
ADD COLUMN     "searchText" TEXT;

-- CreateTable
CREATE TABLE "Closure" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "floorId" TEXT,
    "edgeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nodeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "costMultiplier" DOUBLE PRECISION,
    "reason" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Closure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteRequest" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "fromNodeId" TEXT,
    "to" TEXT,
    "profile" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "src" TEXT,
    "found" BOOLEAN NOT NULL DEFAULT true,
    "distanceM" DOUBLE PRECISION,
    "durationSec" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouteRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchEvent" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "pickedPoiId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RealtimeEvent" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "event" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealtimeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Closure_buildingId_endsAt_idx" ON "Closure"("buildingId", "endsAt");

-- CreateIndex
CREATE INDEX "RouteRequest_buildingId_createdAt_idx" ON "RouteRequest"("buildingId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SearchEvent_buildingId_createdAt_idx" ON "SearchEvent"("buildingId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RealtimeEvent_createdAt_idx" ON "RealtimeEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RealtimeEvent_buildingId_seq_key" ON "RealtimeEvent"("buildingId", "seq");

-- CreateIndex
CREATE INDEX "Log_buildingId_entity_entityId_idx" ON "Log"("buildingId", "entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Node_buildingId_externalId_key" ON "Node"("buildingId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Poi_buildingId_externalId_key" ON "Poi"("buildingId", "externalId");

-- AddForeignKey
ALTER TABLE "Closure" ADD CONSTRAINT "Closure_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteRequest" ADD CONSTRAINT "RouteRequest_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchEvent" ADD CONSTRAINT "SearchEvent_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RealtimeEvent" ADD CONSTRAINT "RealtimeEvent_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: denormalize Poi.buildingId from its Node, and seed searchText for
-- existing rows so the new columns are usable immediately, not just for rows
-- written after this migration.
UPDATE "Poi" p SET "buildingId" = n."buildingId" FROM "Node" n WHERE n."id" = p."nodeId" AND p."buildingId" IS NULL;
UPDATE "Poi" SET "searchText" = lower("name" || ' ' || array_to_string("keywords", ' ')) WHERE "searchText" IS NULL;
-- optional later: CREATE EXTENSION pg_trgm; CREATE INDEX poi_searchtext_trgm ON "Poi" USING gin ("searchText" gin_trgm_ops);
