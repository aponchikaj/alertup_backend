import BUILDINGS from '../models/building.model.js';
import Node from '../models/node.model.js';
import Floor from '../models/floor.model.js';
import LOGS from '../models/logs.model.js';
import EMERGENCIES from '../models/emergencies.model.js';
import WEBSITE_REVIEWS from '../models/reviews.model.js';
import VERIFICATIONS from '../models/verificatios.model.js';
import USERS from '../models/user.model.js';

/**
 * Remove a building and everything hanging off it.
 *
 * Deleting the building document alone leaves nodes, floors, logs and
 * emergencies referencing an id that no longer resolves, and those records are
 * unreachable through the owner-scoped routes afterwards, so nothing can ever
 * clean them up.
 */
export const deleteBuildingCascade = async (buildingId) => {
  // Collected before the delete — querying afterwards returns nothing, so the
  // orphaned-edge cleanup below would silently do nothing.
  const nodeIds = await Node.find({ buildingId }).distinct('_id');

  await Node.deleteMany({ buildingId });
  await Floor.deleteMany({ buildingId });
  await LOGS.deleteMany({ buildingID: buildingId });
  await EMERGENCIES.deleteMany({ buildingID: buildingId });

  // Nodes in other buildings should never point here, but a stale cross-edge
  // would make Dijkstra traverse into deleted geometry.
  if (nodeIds.length) {
    await Node.updateMany(
      { connections: { $in: nodeIds } },
      { $pull: { connections: { $in: nodeIds } } },
    );
  }

  await BUILDINGS.findByIdAndDelete(buildingId);
};

/**
 * Remove a user and every record that belongs to them.
 *
 * Account deletion used to drop only the user document, leaving their buildings
 * live and their QR codes resolving — while the farewell email told them all
 * their data had been removed.
 */
export const deleteUserCascade = async (userId) => {
  const buildingIds = await BUILDINGS.find({ owner: userId }).distinct('_id');

  for (const buildingId of buildingIds) {
    await deleteBuildingCascade(buildingId);
  }

  await WEBSITE_REVIEWS.deleteMany({ userID: userId });
  await VERIFICATIONS.deleteMany({ verificationBy: userId });
  await USERS.findByIdAndDelete(userId);
};
