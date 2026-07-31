import { loadBuildingGraph } from './graphService.js';

// Per-building graph cache. Explicit invalidation from every editor write is
// the primary mechanism; the TTL is a safety net. Single-instance deployment
// makes this authoritative; the scale path is Postgres LISTEN/NOTIFY-driven
// invalidation behind this same API.

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 50;

const cache = new Map(); // buildingId -> {graph, loadedAt}

export async function getGraph(buildingId) {
  const id = String(buildingId);
  const entry = cache.get(id);
  if (entry && Date.now() - entry.loadedAt < TTL_MS) {
    // Refresh LRU position.
    cache.delete(id);
    cache.set(id, entry);
    return entry.graph;
  }

  const graph = await loadBuildingGraph(id);
  cache.delete(id);
  cache.set(id, { graph, loadedAt: Date.now() });
  while (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return graph;
}

export function invalidate(buildingId) {
  cache.delete(String(buildingId));
}

export function clearAll() {
  cache.clear();
}
