-- CreateIndex
CREATE INDEX "BuildingInvite_roleId_idx" ON "BuildingInvite"("roleId");

-- CreateIndex
CREATE INDEX "BuildingInvite_invitedById_idx" ON "BuildingInvite"("invitedById");

-- CreateIndex
CREATE INDEX "EmergencyEvent_triggeredById_idx" ON "EmergencyEvent"("triggeredById");
