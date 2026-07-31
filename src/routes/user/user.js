import express from 'express';
const router = express.Router();

import whoami from '../../middlewares/whoami.js';
import USERS from '../../models/user.model.js';

router.get('/api/me', whoami, async (req, res) => {
    try {
        if (!req.user || !req.user._id) return res.status(401).send({ Success: false, Message: 'Unauthorized.' });

        // Fetch fresh user from database (exclude sensitive fields)
        const user = await USERS.findById(req.user._id).select('-password -__v');
        if (!user) return res.status(404).send({ Success: false, Message: 'User not found.' });

        // Mark lapsed premium as expired.
        //
        // This deliberately does NOT deactivate the user's buildings any more.
        // It used to, but with no way to purchase premium that side effect could
        // only ever take buildings offline — and a deactivated building means an
        // occupant scanning a QR during a fire gets nothing. Availability of an
        // evacuation route must never depend on billing state.
        const now = new Date();
        if (user.premium?.hasPremium && user.premium?.to && new Date(user.premium.to) < now) {
            user.premium.hasPremium = false;
            await user.save();
        }

        // Sanitize response (remove sensitive props if any)
        const safeUser = user.toObject();
        delete safeUser.password;
        delete safeUser.__v;

        return res.send({ Success: true, Message: safeUser });
    } catch (err) {
        console.error('/api/me error:', err);
        return res.status(500).send({ Success: false, Message: 'Server error.' });
    }
});

export default router;