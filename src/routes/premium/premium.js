import express from "express";
import dotenv from "dotenv";
import paypal from "@paypal/checkout-server-sdk";
import USERS from "../../models/user.model.js";
import whoami from "../../middlewares/whoami.js";
import sendMail from "../../services/sendEmail.js";
import axios from "axios";
import { getPayPalAccessToken } from "../../services/paypal.js";

dotenv.config();
const router = express.Router();

/* ---------------- PayPal Client ---------------- */
const paypalEnv = new paypal.core.LiveEnvironment(
  process.env.PAYPAL_CLIENT_ID,
  process.env.PAYPAL_CLIENT_SECRET
);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnv);

/* ---------------- Premium Plans ---------------- */
const PREMIUM_PLANS = {
  Basic: { price: 4.99, name: "Basic Premium", planId: process.env.PAYPAL_BASIC_PLAN_ID,limits: { maxBuildings: 3, maxFloors: 5 } },
  Platinum: { price: 8.99, name: "Platinum Premium", planId: process.env.PAYPAL_PLATINUM_PLAN_ID,limits: { maxBuildings: 6, maxFloors: 10 } },
  Elite: { price: 12.99, name: "Elite Premium", planId: process.env.PAYPAL_ELITE_PLAN_ID,limits: { maxBuildings: 10, maxFloors: 20 } },
  Professional: { price: 24.99, name: "Professional Premium", planId: process.env.PAYPAL_PRO_PLAN_ID,limits: { maxBuildings: 25, maxFloors: 50 } },
};

const addDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};

const isValidPlan = (plan) => !!PREMIUM_PLANS[plan];

/* ---------------- Routes ---------------- */

// ✅ Check user premium status
router.get("/api/premium/status", whoami, async (req, res) => {
  try {
    const user = await USERS.findById(req.user._id);
    if (!user) return res.send({ Success: false, Message: "User not found" });
    res.send({
      Success: true,
      Message: user.premium || { hasPremium: false },
    });
  } catch (err) {
    res.send({ Success: false, Message: "Server error" });
  }
});

// ✅ List available plans
router.get("/api/premium/plans", (_, res) => {
  res.send({ Success: true, Message: PREMIUM_PLANS });
});

// ✅ Create subscription
router.post("/api/premium/subscribe", whoami, async (req, res) => {
  try {
    const { option } = req.body;
    if (!isValidPlan(option)) return res.send({ Success: false, Message: "Invalid plan" });

    const planId = PREMIUM_PLANS[option].planId;
    const accessToken = await getPayPalAccessToken();

    const response = await axios.post(
      "https://api-m.paypal.com/v1/billing/subscriptions",
      {
        plan_id: planId,
        application_context: {
          brand_name: "AlertUp",
          user_action: "SUBSCRIBE_NOW",
          return_url: `${process.env.FRONTEND_URL}/premium/success`,
          cancel_url: `${process.env.FRONTEND_URL}/premium/cancel`,
        },
      },
      {
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      }
    );

    const approveURL = response.data.links.find((l) => l.rel === "approve")?.href;
    if (!approveURL) return res.send({ Success: false, Message: "PayPal approval link missing" });

    res.send({ Success: true, Message: { subscriptionID: response.data.id, approveURL } });
  } catch (err) {
    console.error("Subscription creation error:", err.response?.data || err.message);
    res.send({ Success: false, Message: "Subscription failed", error: err.response?.data });
  }
});

// ✅ Cancel subscription
router.post("/api/premium/cancel", whoami, async (req, res) => {
  try {
    const user = await USERS.findById(req.user._id);
    if (!user?.premium?.subscriptionId) return res.send({ Success: false, Message: "No active subscription" });

    const accessToken = await getPayPalAccessToken();
    await axios.post(
      `https://api-m.paypal.com/v1/billing/subscriptions/${user.premium.subscriptionId}/cancel`,
      { reason: "User requested cancellation" },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    user.premium.hasPremium = false;
    user.premium.subscriptionId = null;
    await user.save();

    res.send({ Success: true, Message: "Subscription canceled" });
  } catch (err) {
    console.error("Cancel subscription error:", err.response?.data || err.message);
    res.send({ Success: false, Message: "Cancellation failed" });
  }
});

// ✅ Webhook
router.post("/api/premium/webhook", express.json({ type: "application/json" }), async (req, res) => {
  try {
    const resource = req.body.resource;
    const eventType = req.body.event_type;

    // Subscription activated
    if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED") {
      const user = await USERS.findOne({ email: resource.subscriber.email_address });
      if (!user) return res.sendStatus(200);

      const premiumOption = Object.keys(PREMIUM_PLANS).find((p) => PREMIUM_PLANS[p].planId === resource.plan_id);
      user.premium = { hasPremium: true, premiumType: premiumOption, subscriptionId: resource.id, to: null };
      await user.save();
    }

    // Payment completed
    if (eventType === "PAYMENT.SALE.COMPLETED") {
      const sale = resource;
      const user = await USERS.findOne({ "premium.subscriptionId": sale.billing_agreement_id });
      if (user) {
        user.transactions.push({ subscriptionId: sale.billing_agreement_id, amount: sale.amount.total, date: new Date() });
        await user.save();
      }
    }

    // Subscription cancelled
    if (eventType === "BILLING.SUBSCRIPTION.CANCELLED") {
      const sub = resource;
      const user = await USERS.findOne({ "premium.subscriptionId": sub.id });
      if (user) {
        user.premium.hasPremium = false;
        user.premium.subscriptionId = null;
        await user.save();
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

export default router;
