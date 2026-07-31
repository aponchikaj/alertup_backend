import prisma from '../../db/prisma.js';
import { isId } from '../../utils/ids.js';

// Assembles the live context the system prompt is built from. Every lookup is
// best-effort: a bad nodeId must degrade the prompt, never fail the request.

const POI_CAP = 30;

export async function fetchChatContext({ buildingId, nodeId, destinationNodeId }) {
  const context = {
    buildingName: 'this building',
    floorNumber: null,
    floorName: null,
    nodeLabel: null,
    destinationName: null,
    emergencyActive: false,
    emergencyMessage: null,
    pois: [],
  };

  if (!buildingId || !isId(buildingId)) return context;

  try {
    const [building, node, destination] = await Promise.all([
      prisma.building.findUnique({
        where: { id: buildingId },
        select: { name: true, emergencyMode: true, emergencyMessage: true },
      }),
      nodeId && isId(nodeId)
        ? prisma.node.findFirst({
            where: { id: nodeId, buildingId },
            select: {
              label: true,
              floorId: true,
              floor: { select: { floorNumber: true, name: true } },
            },
          })
        : null,
      destinationNodeId && isId(destinationNodeId)
        ? prisma.node.findFirst({
            where: { id: destinationNodeId, buildingId },
            select: { label: true, poi: { select: { name: true } } },
          })
        : null,
    ]);

    if (!building) return context;
    context.buildingName = building.name;
    context.emergencyActive = building.emergencyMode;
    context.emergencyMessage = building.emergencyMode ? building.emergencyMessage : null;

    if (node) {
      context.nodeLabel = node.label;
      context.floorNumber = node.floor?.floorNumber ?? null;
      context.floorName = node.floor?.name ?? null;

      const pois = await prisma.poi.findMany({
        where: { node: { floorId: node.floorId } },
        select: { name: true, category: true },
        take: POI_CAP,
        orderBy: { name: 'asc' },
      });
      context.pois = pois;
    }

    if (destination) {
      context.destinationName = destination.poi?.name || destination.label || null;
    }
  } catch (err) {
    console.error('AI context fetch error (degrading gracefully):', err.message);
  }

  return context;
}
