import request from 'supertest';
import app from '../../server.js';
import { createUser, createOwnerWithBuilding, addMember } from './helpers.js';

/* ============================================================================
   FX-023 — /api/me tells the frontend what the user may do, and where.

   The frontend's permission model (`hasPermission`, PermissionGuard) reads
   `memberships` and `Buildings` from /api/me, but the backend never sent
   them — so a member granted CAN_TRIGGER_EMERGENCY or CAN_VIEW_ANALYTICS was
   locked out in the UI while the API itself would have allowed them.
   ========================================================================= */

test('returns owned building ids', async () => {
  const { cookie, building } = await createOwnerWithBuilding();

  const res = await request(app).get('/api/me').set('Cookie', cookie);

  expect(res.status).toBe(200);
  expect(res.body.data.Buildings).toEqual([building.id]);
});

test('returns each membership with its role and permissions', async () => {
  const { building, roles } = await createOwnerWithBuilding();
  const role = Object.values(roles).find((r) => r.permissions.length > 0);
  const { user: member, cookie } = await createUser();
  await addMember(building.id, member.id, role.id);

  const res = await request(app).get('/api/me').set('Cookie', cookie);

  expect(res.body.data.memberships).toEqual({
    [building.id]: { role: role.name, permissions: role.permissions },
  });
  expect(res.body.data.Buildings).toEqual([]);
});
