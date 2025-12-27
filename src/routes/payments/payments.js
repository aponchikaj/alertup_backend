import express from "express";
import whoami from "../../middlewares/whoami.js";
import USERS from "../../models/user.model.js";
import BUILDINGS from "../../models/building.model.js";

const router = express.Router();

// Stub: Apple merchant validation cannot be performed without Apple certificate
router.post('/api/payments/apple-validate', express.json(), async (req, res) => {
  try {
    const { validationURL } = req.body;
    if (!validationURL) return res.status(400).send({ Success: false, Message: 'Missing validationURL' });

    // Merchant validation requires Apple merchant certificate and server-side call.
    // This endpoint is a stub to indicate configuration is needed.
    return res.status(501).send({ Success: false, Message: 'Server not configured for Apple merchant validation. Upload Apple Pay certificate and implement validation.' });
  } catch (err) {
    console.error('Apple validate error:', err);
    res.status(500).send({ Success: false, Message: 'Server error' });
  }
});

// Charge endpoint (test-mode / simulation)
// Accepts { token, amount, plan, method } and activates premium for the authenticated user.
router.post('/api/payments/charge', whoami, express.json(), async (req, res) => {
  try {
    const { token, amount, plan, method } = req.body;
    if (!token || !plan) return res.status(400).send({ Success: false, Message: 'Missing token or plan' });

    const user = await USERS.findById(req.user._id);
    if (!user) return res.status(404).send({ Success: false, Message: 'User not found' });

    // Activate premium for 30 days (simulation). In production, verify token with gateway.
    const now = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 30);

    user.premium = {
      hasPremium: true,
      premiumType: plan,
      subscriptionId: token,
      from: now,
      to
    };

    if (!user.transactions) user.transactions = [];
    user.transactions.push({
      transactionId: token,
      method: method || 'wallet',
      plan,
      amount: amount || null,
      date: now
    });

    await user.save();

    // Reactivate deactivated buildings
    await BUILDINGS.updateMany(
      { owner: user._id, isDeactivated: true },
      { $set: { isDeactivated: false } }
    );

    res.send({ Success: true, Message: 'Payment accepted (simulated). Premium activated.', plan, expires: to });
  } catch (err) {
    console.error('Charge error:', err);
    res.status(500).send({ Success: false, Message: 'Charge failed' });
  }
});

export default router;
