import express from 'express';
const router = express.Router();

import whoami from '../../middlewares/whoami.js';
import { ok, fail } from '../../utils/respond.js';

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

        return ok(res, { data: safeUser });
    } catch (err) {
        console.error('/api/me error:', err);
        return fail(res, 500, 'Server error.');
    }
});

export default router;
