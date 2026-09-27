import request from 'supertest';
import app from '../../server.js';
import { clearAll } from '../features/wayfinding/graphCache.js';
import { buildBriefFacts, briefTemplate } from '../features/ai/evacuationBrief.routes.js';
import { createUser, createBuilding, createFloor, createNode, connectNodes } from './helpers.js';

/* ============================================================================
   The evacuation brief.

   Deliberately NOT a chat agent. An evacuating person should not be typing,
   and the launcher stays hidden during an emergency for exactly that reason.
   What the overlay gets instead is ONE sentence, phrased from the route
   Dijkstra already computed.

   The model never queries for a route here — it is handed one. That is what
   makes it impossible for the sentence to contradict the red line on screen.
   If no provider answers, the template renders the identical facts, which is
   why the template is what these tests exercise.
   ========================================================================= */

beforeEach(() => clearAll());

const seedWithExit = async ({ scale = 50 } = {}) => {
  const { user } = await createUser();
  const { building } = await createBuilding(user.id);
  const floor = await createFloor(building.id, {
    floorNumber: 1,
    name: 'Ground',
    scalePixelsPerMeter: scale,
  });
  const here = await createNode(building.id, floor.id, { x: 0, label: 'Lobby' });
  const exit = await createNode(building.id, floor.id, {
    x: 500,
    type: 'EMERGENCY_EXIT',
    label: 'North Exit',
  });
  await connectNodes(here, exit);
  return { building, floor, here, exit };
};

describe('buildBriefFacts', () => {
  test('names the real exit and its distance', async () => {
    const { building, here } = await seedWithExit();

    const facts = await buildBriefFacts({ buildingId: building.id, nodeId: here.id });

    expect(facts.found).toBe(true);
    expect(facts.exitName).toBe('North Exit');
    expect(facts.distanceMeters).toBeGreaterThan(0);
  });

  test('never claims an exit when the building has none', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const here = await createNode(building.id, floor.id, { label: 'Lobby' });
    const other = await createNode(building.id, floor.id, { x: 200 });
    await connectNodes(here, other);

    const facts = await buildBriefFacts({ buildingId: building.id, nodeId: here.id });

    expect(facts.found).toBe(false);
    expect(facts.exitName).toBeUndefined();
  });

  test('reports nothing when the position is unknown', async () => {
    const { building } = await seedWithExit();

    const facts = await buildBriefFacts({ buildingId: building.id, nodeId: null });

    expect(facts.found).toBe(false);
  });

  test('ignores a node from another building', async () => {
    const mine = await seedWithExit();
    const theirs = await seedWithExit();

    const facts = await buildBriefFacts({
      buildingId: mine.building.id,
      nodeId: theirs.here.id,
    });

    expect(facts.found).toBe(false);
  });

  /**
   * B16: this brief is read alongside the drawn route on the same overlay,
   * so it must never contradict it. Every other evacuation surface
   * (`/evacuate`, the QR scan route) always searches under the `emergency`
   * profile — elevators off-limits unless the building says its cars are
   * evacuation-rated — and the brief now has to agree.
   */
  test('reports no route when the only way out is a lift the building has not rated for evacuation', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const ground = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 50 });
    const upper = await createFloor(building.id, { floorNumber: 2, scalePixelsPerMeter: 50 });
    const here = await createNode(building.id, upper.id, { label: 'Office' });
    const lift = await createNode(building.id, ground.id, { type: 'TRANSIT' });
    const exit = await createNode(building.id, ground.id, {
      x: 300,
      type: 'EMERGENCY_EXIT',
      label: 'Side Exit',
    });
    await connectNodes(here, lift, { transitType: 'ELEVATOR', distance: 0, weight: 300 });
    await connectNodes(lift, exit);

    const facts = await buildBriefFacts({ buildingId: building.id, nodeId: here.id });

    // The `emergency` profile blocks ELEVATOR outright when the building has
    // not declared its cars evacuation-rated, and this is the only path out
    // — exactly what /evacuate and the scan route would also report.
    expect(facts.found).toBe(false);
  });

  test('flags a route through the lift when the building rates its cars for evacuation', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id, {
      routingProfile: { elevatorEvacuationRated: true },
    });
    const ground = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 50 });
    const upper = await createFloor(building.id, { floorNumber: 2, scalePixelsPerMeter: 50 });
    const here = await createNode(building.id, upper.id, { label: 'Office' });
    const lift = await createNode(building.id, ground.id, { type: 'TRANSIT' });
    const exit = await createNode(building.id, ground.id, {
      x: 300,
      type: 'EMERGENCY_EXIT',
      label: 'Side Exit',
    });
    await connectNodes(here, lift, { transitType: 'ELEVATOR', distance: 0, weight: 300 });
    await connectNodes(lift, exit);

    const facts = await buildBriefFacts({ buildingId: building.id, nodeId: here.id });

    expect(facts.found).toBe(true);
    expect(facts.usesElevator).toBe(true);
  });
});

describe('briefTemplate — the answer when no model is available', () => {
  test('names the exit, the floor and the distance', () => {
    const text = briefTemplate(
      { found: true, exitName: 'North Exit', exitFloorNumber: 1, distanceMeters: 40, floorChanges: 0 },
      'en'
    );

    expect(text).toContain('North Exit');
    expect(text).toContain('40');
  });

  test('omits the distance rather than printing zero', () => {
    const text = briefTemplate(
      { found: true, exitName: 'North Exit', exitFloorNumber: 1, floorChanges: 0 },
      'en'
    );

    expect(text).toContain('North Exit');
    expect(text).not.toMatch(/\b0\s*m\b/);
  });

  test('tells the truth when there is no route', () => {
    const text = briefTemplate({ found: false }, 'en');

    expect(text).toMatch(/exit sign/i);
    expect(text).not.toMatch(/North|metres|floor \d/);
  });

  test('has a Georgian rendering too', () => {
    const text = briefTemplate({ found: false }, 'ka');

    expect(text).toBeTruthy();
    expect(text).not.toMatch(/exit sign/i);
  });
});

describe('POST /api/ai/evacuation-brief', () => {
  test('is anonymous and returns the brief', async () => {
    const { building, here } = await seedWithExit();

    const res = await request(app)
      .post('/api/ai/evacuation-brief')
      .send({ buildingId: building.id, nodeId: here.id, locale: 'en' });

    expect(res.status).toBe(200);
    expect(res.body.data.found).toBe(true);
    expect(res.body.data.text).toContain('North Exit');
  });

  test('answers usefully even with no AI provider configured', async () => {
    const { building, here } = await seedWithExit();

    const res = await request(app)
      .post('/api/ai/evacuation-brief')
      .send({ buildingId: building.id, nodeId: here.id, locale: 'en' });

    // The deterministic template is the answer, not an error.
    expect(res.status).toBe(200);
    expect(res.body.data.text).toBeTruthy();
  });

  test('400s an invalid building id', async () => {
    const res = await request(app).post('/api/ai/evacuation-brief').send({ buildingId: 'nope' });

    expect(res.status).toBe(400);
  });
});
