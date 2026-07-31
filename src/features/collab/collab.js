import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../../db/prisma.js';
import config from '../../config/index.js';
import { PERMISSIONS } from '../../auth/permissions.js';

/* ============================================================================
   Collaborative editing channel — socket.io.
   ----------------------------------------------------------------------------
   One room per building ("editor:{buildingId}"), joined only by users who hold
   CAN_EDIT_MAP there. Three event families flow through it:

     presence  — who is in the editor right now (join/leave/roster)
     cursor    — live pointer positions, volatile (a lost frame is fine)
     op        — "I changed X" notifications carrying the server row

   The socket layer is deliberately NOT the source of truth. Every mutation
   still goes through the REST routes (validation, permissions, rate limits,
   graph-cache invalidation); the room only relays what the server already
   accepted, so a malicious payload can desync one browser's view but never
   corrupt the database. Relay is also why join is permission-gated: everyone
   in the room could edit via REST anyway, so relaying between them grants
   nothing new.

   SSE (features/realtime) stays as-is for the public emergency feed — that
   audience is anonymous visitors on flaky mobile connections, where SSE's
   auto-reconnect semantics are the right tool. Sockets are for the handful of
   authenticated editors who need bidirectional, low-latency traffic.
   ========================================================================= */

/** Peers per building. Beyond this a floor plan is not being "edited". */
const MAX_ROOM_SIZE = 32;

/** Relayed op payload cap — a whole drawing tops out at 512KB. */
const MAX_OP_BYTES = 700 * 1024;

/** Ops a client may relay. Unknown kinds are dropped, not forwarded. */
const OP_KINDS = new Set([
  'node:upsert',
  'node:delete',
  'edge:upsert',
  'edge:delete',
  'poi:upsert',
  'poi:delete',
  'floor:upsert',
  'floor:delete',
  'drawing',
]);

/** Cursor colors. Assigned by join order per room, so two peers never share a
 *  color until the palette runs out. */
const CURSOR_COLORS = [
  '#2563eb',
  '#db2777',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#dc2626',
  '#4d7c0f',
];

const roomKey = (buildingId) => `editor:${buildingId}`;

let io = null;

/** roomKey -> Map<socketId, peer>. Presence is in-memory: a restart empties
 *  the rooms and clients simply re-join, same lifecycle as the SSE streams. */
const rooms = new Map();

const roster = (key) => Array.from(rooms.get(key)?.values() ?? []);

const pickColor = (key) => {
  const used = new Set(roster(key).map((peer) => peer.color));
  return CURSOR_COLORS.find((color) => !used.has(color)) ?? CURSOR_COLORS[0];
};

/** Cookie header -> value of `userToken`, or null. Minimal on purpose — the
 *  handshake carries exactly one cookie we care about. */
const tokenFromCookieHeader = (header) => {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'userToken') return decodeURIComponent(rest.join('='));
  }
  return null;
};

/**
 * Handshake auth — the socket twin of middlewares/whoami.js: cookie first,
 * then the auth payload (Safari/iOS localStorage fallback), same tokenVersion
 * revocation rule. Failures reject the connection outright; there is nothing
 * an unauthenticated socket may do.
 */
const authenticate = async (socket) => {
  const token =
    tokenFromCookieHeader(socket.handshake.headers?.cookie) ||
    socket.handshake.auth?.token ||
    null;
  if (!token) throw new Error('Authentication required.');

  const data = jwt.verify(token, config.jwt.secret);
  if (!data || !data.userID) throw new Error('Invalid token.');

  const user = await prisma.user.findUnique({ where: { id: data.userID } });
  if (!user) throw new Error('Invalid token.');
  if ((user.tokenVersion || 0) !== (data.tokenVersion || 0)) {
    throw new Error('Session expired.');
  }
  return user;
};

/** Owner, or member whose role carries CAN_EDIT_MAP — the same rule the REST
 *  editor routes enforce, resolved socket-shaped. */
const canEditBuilding = async (userId, buildingId) => {
  if (typeof buildingId !== 'string' || !buildingId) return false;
  const building = await prisma.building.findUnique({
    where: { id: buildingId },
    include: {
      members: { where: { userId }, include: { role: true } },
    },
  });
  if (!building) return false;
  if (building.ownerId === userId) return true;
  const role = building.members[0]?.role;
  return Boolean(role?.permissions?.includes(PERMISSIONS.CAN_EDIT_MAP));
};

const leaveRoom = (socket) => {
  const key = socket.data.roomKey;
  if (!key) return;
  socket.data.roomKey = null;
  socket.leave(key);

  const peers = rooms.get(key);
  if (peers?.delete(socket.id)) {
    if (peers.size === 0) rooms.delete(key);
    io?.to(key).emit('editor:presence', { peers: roster(key) });
  }
};

/**
 * Attach the collab server to an existing HTTP server.
 *
 * @param {import('http').Server} server
 * @param {{allowedOrigins?: string[], allowAll?: boolean}} corsOptions —
 *   passed in from server.js so the socket handshake enforces the same origin
 *   policy as every REST route, from the same computed list.
 */
export function initCollab(server, corsOptions = {}) {
  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || corsOptions.allowAll) return callback(null, true);
        if ((corsOptions.allowedOrigins || []).includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('Origin not allowed'));
      },
      credentials: true,
    },
    // Editors are on desks, not flaky mobile networks; skip long-polling.
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: MAX_OP_BYTES,
  });

  io.use((socket, next) => {
    authenticate(socket)
      .then((user) => {
        socket.data.user = {
          id: user.id,
          name: [user.name, user.lastname].filter(Boolean).join(' ') || user.email,
        };
        next();
      })
      .catch((err) => next(err instanceof Error ? err : new Error('Auth failed')));
  });

  io.on('connection', (socket) => {
    socket.on('editor:join', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const buildingId = payload?.buildingId;
        const allowed = await canEditBuilding(socket.data.user.id, buildingId);
        if (!allowed) return reply({ ok: false, error: 'FORBIDDEN' });

        const key = roomKey(buildingId);
        if ((rooms.get(key)?.size ?? 0) >= MAX_ROOM_SIZE) {
          return reply({ ok: false, error: 'ROOM_FULL' });
        }

        // One editor room per socket: joining another building implies the
        // user navigated away, so drop the old presence first.
        leaveRoom(socket);

        const peer = {
          socketId: socket.id,
          userId: socket.data.user.id,
          name: socket.data.user.name,
          color: pickColor(key),
        };
        if (!rooms.has(key)) rooms.set(key, new Map());
        rooms.get(key).set(socket.id, peer);
        socket.data.roomKey = key;
        socket.join(key);

        io.to(key).emit('editor:presence', { peers: roster(key) });
        return reply({ ok: true, self: peer, peers: roster(key) });
      } catch (err) {
        console.error('editor:join error:', err);
        return reply({ ok: false, error: 'SERVER_ERROR' });
      }
    });

    // Volatile: a dropped cursor frame is invisible, a queued backlog of them
    // is a cursor lagging seconds behind the hand that moves it.
    socket.on('editor:cursor', (payload) => {
      const key = socket.data.roomKey;
      if (!key) return;
      const peer = rooms.get(key)?.get(socket.id);
      if (!peer) return;
      const x = Number(payload?.x);
      const y = Number(payload?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      socket.volatile.to(key).emit('editor:cursor', {
        socketId: socket.id,
        userId: peer.userId,
        name: peer.name,
        color: peer.color,
        x,
        y,
        floorId: typeof payload?.floorId === 'string' ? payload.floorId : null,
        tool: typeof payload?.tool === 'string' ? payload.tool.slice(0, 32) : null,
      });
    });

    socket.on('editor:op', (payload) => {
      const key = socket.data.roomKey;
      if (!key) return;
      const op = payload?.op;
      if (!op || typeof op !== 'object' || !OP_KINDS.has(op.kind)) return;
      try {
        if (JSON.stringify(op).length > MAX_OP_BYTES) return;
      } catch {
        return;
      }
      socket.to(key).emit('editor:op', { op, socketId: socket.id });
    });

    socket.on('editor:leave', () => leaveRoom(socket));
    socket.on('disconnect', () => leaveRoom(socket));
  });

  return io;
}

/** Close all sockets (deploy shutdown). Safe to call when never initialized. */
export function closeCollab() {
  if (!io) return;
  io.close();
  io = null;
  rooms.clear();
}

/** Test hook: peers currently present for a building. */
export function peersFor(buildingId) {
  return roster(roomKey(buildingId));
}
