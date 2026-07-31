import { createServer } from 'node:http';
import { io as ioc } from 'socket.io-client';
import { initCollab, closeCollab, peersFor } from '../features/collab/collab.js';
import { createUser, createBuilding, addMember } from './helpers.js';

/* ============================================================================
   Collab socket server — auth, room gating, relay.
   ----------------------------------------------------------------------------
   The room only relays what REST already accepted, so the property that
   matters most here is WHO can get in: no token → no connection, no
   CAN_EDIT_MAP → no room. The relay tests then prove presence/cursor/op
   actually reach the other side.
   ========================================================================= */

let httpServer;
let baseUrl;

const connect = (cookie, auth) =>
  ioc(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    ...(cookie ? { extraHeaders: { cookie: cookie.join('; ') } } : {}),
    ...(auth ? { auth } : {}),
  });

/** Wait for one event, with a hard timeout so a silent drop fails fast. */
const once = (socket, event, ms = 4000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event}`)),
      ms,
    );
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const join = (socket, buildingId) =>
  new Promise((resolve) => socket.emit('editor:join', { buildingId }, resolve));

beforeAll(async () => {
  httpServer = createServer();
  initCollab(httpServer, { allowAll: true });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  baseUrl = `http://localhost:${httpServer.address().port}`;
});

afterAll(async () => {
  closeCollab();
  await new Promise((resolve) => httpServer.close(resolve));
});

describe('collab authentication', () => {
  test('a connection without a token is rejected', async () => {
    const socket = connect(null, null);
    const err = await once(socket, 'connect_error');
    expect(err.message).toMatch(/Authentication required/);
    socket.close();
  });

  test('a garbage token is rejected', async () => {
    const socket = connect(['userToken=not-a-jwt']);
    await once(socket, 'connect_error');
    socket.close();
  });

  test('a valid cookie connects; auth payload works as the fallback', async () => {
    const { cookie, token } = await createUser();

    const viaCookie = connect(cookie);
    await once(viaCookie, 'connect');
    viaCookie.close();

    const viaAuth = connect(null, { token });
    await once(viaAuth, 'connect');
    viaAuth.close();
  });
});

describe('collab rooms', () => {
  test('join is refused without CAN_EDIT_MAP and allowed with it', async () => {
    const { user: owner, cookie: ownerCookie } = await createUser();
    const { building, roles } = await createBuilding(owner.id);
    const { user: outsider, cookie: outsiderCookie } = await createUser();
    const { user: editor, cookie: editorCookie } = await createUser();
    // "Map Editor" is one of the seeded system roles carrying CAN_EDIT_MAP.
    const editorRole =
      Object.values(roles).find((r) => r.permissions.includes('CAN_EDIT_MAP')) ??
      roles['Map Editor'];
    await addMember(building.id, editor.id, editorRole.id);

    const outsiderSocket = connect(outsiderCookie);
    await once(outsiderSocket, 'connect');
    const refused = await join(outsiderSocket, building.id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('FORBIDDEN');
    outsiderSocket.close();

    const ownerSocket = connect(ownerCookie);
    await once(ownerSocket, 'connect');
    const ownerJoin = await join(ownerSocket, building.id);
    expect(ownerJoin.ok).toBe(true);
    expect(ownerJoin.self.userId).toBe(owner.id);

    const editorSocket = connect(editorCookie);
    await once(editorSocket, 'connect');
    // The owner hears the presence update caused by the editor joining.
    const presenceWait = once(ownerSocket, 'editor:presence');
    const editorJoin = await join(editorSocket, building.id);
    expect(editorJoin.ok).toBe(true);
    // Two peers, two distinct cursor colors.
    expect(editorJoin.peers).toHaveLength(2);
    expect(new Set(editorJoin.peers.map((p) => p.color)).size).toBe(2);

    const presence = await presenceWait;
    expect(presence.peers.map((p) => p.userId).sort()).toEqual(
      [owner.id, editor.id].sort(),
    );

    // Disconnect drops the peer from the roster.
    const leaveWait = once(ownerSocket, 'editor:presence');
    editorSocket.close();
    const afterLeave = await leaveWait;
    expect(afterLeave.peers.map((p) => p.userId)).toEqual([owner.id]);
    expect(peersFor(building.id)).toHaveLength(1);

    ownerSocket.close();
  });

  test('a nonexistent building refuses the join', async () => {
    const { cookie } = await createUser();
    const socket = connect(cookie);
    await once(socket, 'connect');
    const reply = await join(socket, 'cnope00000000000000000000');
    expect(reply.ok).toBe(false);
    socket.close();
  });
});

describe('collab relay', () => {
  let building;
  let a;
  let b;

  beforeEach(async () => {
    const { user: owner, cookie } = await createUser();
    let roles;
    ({ building, roles } = await createBuilding(owner.id));
    const { user: editor, cookie: editorCookie } = await createUser();
    const role = Object.values(roles).find((r) =>
      r.permissions.includes('CAN_EDIT_MAP'),
    );
    await addMember(building.id, editor.id, role.id);

    a = connect(cookie);
    b = connect(editorCookie);
    await Promise.all([once(a, 'connect'), once(b, 'connect')]);
    await Promise.all([join(a, building.id), join(b, building.id)]);
  });

  afterEach(() => {
    a?.close();
    b?.close();
  });

  test('ops relay to the other editor but not back to the sender', async () => {
    const op = { kind: 'node:upsert', node: { id: 'n1', x: 1, y: 2 } };
    let echoed = false;
    a.on('editor:op', () => {
      echoed = true;
    });

    const received = once(b, 'editor:op');
    a.emit('editor:op', { op });
    const payload = await received;

    expect(payload.op).toEqual(op);
    expect(echoed).toBe(false);
  });

  test('unknown op kinds are dropped, not forwarded', async () => {
    let leaked = false;
    b.on('editor:op', () => {
      leaked = true;
    });
    a.emit('editor:op', { op: { kind: 'shell:exec', cmd: 'rm -rf /' } });
    // Give the relay a beat; nothing should arrive.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(leaked).toBe(false);
  });

  test('cursors relay with the sender identity attached', async () => {
    const received = once(b, 'editor:cursor');
    a.emit('editor:cursor', { x: 120, y: 340, floorId: 'f1' });
    const cursor = await received;
    expect(cursor).toMatchObject({ x: 120, y: 340, floorId: 'f1' });
    expect(typeof cursor.name).toBe('string');
    expect(cursor.color).toMatch(/^#/);
  });

  test('malformed cursors are dropped', async () => {
    let leaked = false;
    b.on('editor:cursor', () => {
      leaked = true;
    });
    a.emit('editor:cursor', { x: 'NaN-ish', y: {} });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(leaked).toBe(false);
  });
});
