-- FX-071: building consistency enforced by the database itself.
--
-- Prisma does not model triggers, so these never show up as schema drift;
-- they guard every write path (map editor, legacy shims, scripts, tests).

-- 1. Poi.buildingId is always its node's building. Backfill first.
UPDATE "Poi" p
SET "buildingId" = n."buildingId"
FROM "Node" n
WHERE n."id" = p."nodeId"
  AND (p."buildingId" IS NULL OR p."buildingId" <> n."buildingId");

CREATE OR REPLACE FUNCTION alertup_poi_building_from_node() RETURNS trigger AS $$
BEGIN
  SELECT n."buildingId" INTO NEW."buildingId" FROM "Node" n WHERE n."id" = NEW."nodeId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER poi_building_from_node
BEFORE INSERT OR UPDATE OF "nodeId", "buildingId" ON "Poi"
FOR EACH ROW EXECUTE FUNCTION alertup_poi_building_from_node();

-- 2. An edge's two nodes belong to the edge's building.
CREATE OR REPLACE FUNCTION alertup_edge_same_building() RETURNS trigger AS $$
DECLARE
  mismatched integer;
BEGIN
  SELECT count(*) INTO mismatched
  FROM "Node" n
  WHERE n."id" IN (NEW."sourceNodeId", NEW."targetNodeId")
    AND n."buildingId" <> NEW."buildingId";
  IF mismatched > 0 THEN
    RAISE EXCEPTION 'Edge % connects a node in a different building', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER edge_same_building
BEFORE INSERT OR UPDATE OF "sourceNodeId", "targetNodeId", "buildingId" ON "Edge"
FOR EACH ROW EXECUTE FUNCTION alertup_edge_same_building();

-- 3. A node sits on a floor of its own building.
CREATE OR REPLACE FUNCTION alertup_node_floor_same_building() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Floor" f WHERE f."id" = NEW."floorId" AND f."buildingId" <> NEW."buildingId"
  ) THEN
    RAISE EXCEPTION 'Node % is on a floor of a different building', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER node_floor_same_building
BEFORE INSERT OR UPDATE OF "floorId", "buildingId" ON "Node"
FOR EACH ROW EXECUTE FUNCTION alertup_node_floor_same_building();
