-- CreateTable
CREATE TABLE "IncidentArchive" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "buildingName" TEXT NOT NULL,
    "ownerId" TEXT,
    "kind" TEXT NOT NULL,
    "emergencyId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentArchive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncidentArchive_buildingId_idx" ON "IncidentArchive"("buildingId");

-- CreateIndex
CREATE INDEX "IncidentArchive_ownerId_idx" ON "IncidentArchive"("ownerId");

-- CreateIndex
CREATE INDEX "IncidentArchive_emergencyId_idx" ON "IncidentArchive"("emergencyId");
