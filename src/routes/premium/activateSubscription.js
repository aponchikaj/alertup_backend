import express from "express";
import whoami from "../../middlewares/whoami.js";
import USERS from "../../models/user.model.js";

const router = express.Router();

const PREMIUM_PLANS = {
  "P-11X27865HK279192ENFH7Q5Q": "Basic",
  "P-2TG459541U474594GNFH7S6Y": "Platinum",
  "P-8R946168441544305NFH7R7A": "Elite",
  "P-9TJ12709BF866930RNFH7TSQ": "Professional",
};

router.post("/api/premium/activate-subscription", whoami, async (req, res) => {
  try {
    const { subscriptionID, planId } = req.body;
    if (!subscriptionID || !planId) return res.status(400).send({ Success: false, Message: "Missing data" });

    const user = await USERS.findById(req.user._id);
    if (!user) return res.status(404).send({ Success: false, Message: "User not found" });

    const planName = PREMIUM_PLANS[planId];
    if (!planName) return res.status(400).send({ Success: false, Message: "Invalid plan ID" });

    // Save subscription info to user
    user.premium = {
      hasPremium: true,
      premiumType: planName,
      subscriptionId: subscriptionID,
      to: null // recurring, so no expiration date for now
    };

    // Save transaction (optional)
    user.transactions.push({
      subscriptionId: subscriptionID,
      plan: planName,
      date: new Date()
    });

    await user.save();
    res.send({ Success: true, Message: "Subscription activated" });
  } catch (err) {
    console.error("Activate subscription error:", err);
    res.status(500).send({ Success: false, Message: "Server error" });
  }
});

export default router;
