import express from 'express';
const router = express.Router();

import whoami from '../../middlewares/whoami.js';
import USERS from '../../models/user.model.js';
import BUILDINGS from '../../models/building.model.js';

router.get('/api/me', whoami, async (req, res) => {
    try {
        if (!req.user || !req.user._id) return res.status(401).send({ Success: false, Message: 'Unauthorized.' });

        // Fetch fresh user from database (exclude sensitive fields)
        const user = await USERS.findById(req.user._id).select('-password -__v');
        if (!user) return res.status(404).send({ Success: false, Message: 'User not found.' });

        // Check premium expiration and update if necessary
        const now = new Date();
        if (user.premium && user.premium.hasPremium && user.premium.to) {
            const expires = new Date(user.premium.to);
            if (expires < now) {
                user.premium.hasPremium = false;
                await user.save();

                // Deactivate any active buildings owned by this user and notify by email
                try {
                    const activeBuildings = await BUILDINGS.find({ owner: user._id, isDeactivated: false });
                    if (activeBuildings && activeBuildings.length) {
                        await BUILDINGS.updateMany({ owner: user._id, isDeactivated: false }, { $set: { isDeactivated: true } });
                        try {
                            const sendMail = (await import('../../services/sendEmail.js')).default;
                            for (const b of activeBuildings) {
                                const subject = `Your AlertUp premium expired — ${b.buildingName} deactivated`;
                                const text = `Hello ${user.username || ''},\n\nYour premium subscription has expired and your building \"${b.buildingName}\" was deactivated.\n\nTo reactivate premium and restore access to your building, please visit https://www.alertup.world/premium and complete a purchase.\n\nIf you have any questions, reply to this email.`;
                                await sendMail(user.email, subject, text);
                            }
                        } catch (emailErr) {
                            console.error('Failed to send deactivation emails in /api/me:', emailErr);
                        }
                    }
                } catch (bErr) {
                    console.error('Failed to deactivate buildings on premium expiry:', bErr);
                }
            }
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