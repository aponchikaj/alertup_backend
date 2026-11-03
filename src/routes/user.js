import express from 'express';
const router = express.Router();

import whoami from '../middlewares/whoami.js';
import { ok, fail } from '../utils/respond.js';
import prisma from '../db/prisma.js';

router.get('/api/me', whoami, async (req, res) => {
    try {
        // whoami just loaded this row (password already omitted globally), so
        // it is as fresh as a re-query would be.
        const user = req.user;
        if (!user || !user.id) return fail(res, 401, 'Unauthorized.');

        // Legacy response keys the frontend reads, mapped from the new columns
        // (phones -> phone, TwoFactorEnabled -> twoFactorEnabled, _id -> id).
        // The premium/transactions/Buildings/scanned/notifications fields are
        // gone from the account model and simply no longer appear.
        const safeUser = {
            id: user.id,
            email: user.email,
            userType: user.userType,
            name: user.name,
            lastname: user.lastname,
            company: user.company,
            country: user.country,
            countryCode: user.countryCode,
            phones: user.phone,
            verified: user.verified,
            TwoFactorEnabled: user.twoFactorEnabled,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        };

        // FX-023: the frontend's permission model (`hasPermission`,
        // PermissionGuard) reads these two. Without them every member was
        // locked out in the UI of what the API itself allowed.
        const [owned, memberships] = await Promise.all([
            prisma.building.findMany({ where: { ownerId: user.id }, select: { id: true } }),
            prisma.buildingMember.findMany({
                where: { userId: user.id },
                select: { buildingId: true, role: { select: { name: true, permissions: true } } },
            }),
        ]);
        safeUser.Buildings = owned.map((b) => b.id);
        safeUser.memberships = Object.fromEntries(
            memberships.map((m) => [m.buildingId, { role: m.role.name, permissions: m.role.permissions }])
        );

        return ok(res, { data: safeUser });
    } catch (err) {
        console.error('/api/me error:', err);
        return fail(res, 500, 'Server error.');
    }
});

export default router;
