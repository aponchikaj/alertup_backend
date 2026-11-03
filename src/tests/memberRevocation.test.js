import { createServer } from 'node:http';
import { io as ioc } from 'socket.io-client';
import prisma from '../db/prisma.js';
import { initCollab, closeCollab, peersFor, recheckEditors } from '../features/collab/collab.js';
import { subscribe, closeUserStreams, closeAll } from '../features/realtime/broadcaster.js';
import { createUser, createBuilding, addMember } from './helpers.js';

/* ============================================================================
   FX-056 — losing access to a building ends live access to it.

   Edit rights were checked on `editor:join` only, and member feeds on
   connect only, so a removed member (or an editor whose role was downgraded)
   kept receiving every live map edit and every member-only event until they
   happened to reconnect.
   ========================================================================= */

let httpServer;
let baseUrl;

const connect = (cookie) =>
  ioc(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: { cookie: cookie.join('; ') },
  });

const once = (socket, event, ms = 4000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), ms);
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

afterEach(() => closeAll());

test('a removed editor is dropped from the live editor room; the owner stays', async () => {
  const { user: owner, cookie: ownerCookie } = await createUser();
  const { building, roles } = await createBuilding(owner.id);
  const { user: editor, cookie: editorCookie } = await createUser();
  const editorRole = Object.values(roles).find((r) => r.permissions.includes('CAN_EDIT_MAP'));
  await addMember(building.id, editor.id, editorRole.id);

  const ownerSocket = connect(ownerCookie);
  const editorSocket = connect(editorCookie);
  await Promise.all([once(ownerSocket, 'connect'), once(editorSocket, 'connect')]);
  expect((await join(ownerSocket, building.id)).ok).toBe(true);
  expect((await join(editorSocket, building.id)).ok).toBe(true);
  expect(peersFor(building.id)).toHaveLength(2);

  await prisma.buildingMember.deleteMany({ where: { buildingId: building.id, userId: editor.id } });
  const revoked = once(editorSocket, 'editor:revoked');
  const removed = await recheckEditors(building.id);

  expect(removed).toBe(1);
  await revoked;
  expect(peersFor(building.id).map((p) => p.userId)).toEqual([owner.id]);

  ownerSocket.close();
  editorSocket.close();
});

test('closeUserStreams ends only that user\'s member feeds in that building', () => {
  const revoked = [];
  subscribe('b1', () => {}, { userId: 'u1', onRevoke: () => revoked.push('u1-b1') });
  subscribe('b1', () => {}, { userId: 'u2', onRevoke: () => revoked.push('u2-b1') });
  subscribe('b2', () => {}, { userId: 'u1', onRevoke: () => revoked.push('u1-b2') });
  subscribe('b1', () => {}, { onRevoke: () => revoked.push('public') }); // public stream, no user

  expect(closeUserStreams('b1', 'u1')).toBe(1);
  expect(revoked).toEqual(['u1-b1']);
});
