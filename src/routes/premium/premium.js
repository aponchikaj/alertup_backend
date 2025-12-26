import express from "express";
import dotenv from "dotenv";
import paypal from "@paypal/checkout-server-sdk";
import USERS from "../../models/user.model.js";
import whoami from "../../middlewares/whoami.js";

dotenv.config();
const router = express.Router();

/* ---------------------------------- */
/* PayPal Client */
/* ---------------------------------- */
const paypalEnv =
  process.env.PAYPAL_ENV === "live"
    ? new paypal.core.LiveEnvironment(
        process.env.PAYPAL_CLIENT_ID,
        process.env.PAYPAL_CLIENT_SECRET
      )
    : new paypal.core.SandboxEnvironment(
        process.env.PAYPAL_CLIENT_ID,
        process.env.PAYPAL_CLIENT_SECRET
      );

const paypalClient = new paypal.core.PayPalHttpClient(paypalEnv);

/* ---------------------------------- */
/* Premium Plans */
/* ---------------------------------- */
const PREMIUM_PLANS = {
  Basic: { price: 4.99, limits: { maxBuildings: 3, maxFloors: 5 } },
  Platinum: { price: 9.99, limits: { maxBuildings: 6, maxFloors: 10 } },
  Elite: { price: 19.99, limits: { maxBuildings: 10, maxFloors: 20 } },
  Professional: { price: 29.99, limits: { maxBuildings: 25, maxFloors: 50 } }
};

/* ---------------------------------- */
/* Helpers */
/* ---------------------------------- */
const addDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};

const isValidPlan = (plan) => !!PREMIUM_PLANS[plan];

/* ---------------------------------- */
/* GET premium status */
/* ---------------------------------- */
router.get("/api/premium/status", whoami, async (req, res) => {
  try {
    const user = await USERS.findById(req.user._id).lean();
    if (!user) return res.send({ Success: false, Message: "User not found" });

    res.send({
      Success: true,
      Message: {
        hasPremium: user.premium?.hasPremium || false,
        premiumType: user.premium?.premiumType || null,
        expires: user.premium?.to || null
      }
    });
  } catch {
    res.send({ Success: false, Message: "Server error" });
  }
});

/* ---------------------------------- */
/* GET premium plans */
/* ---------------------------------- */
router.get("/api/premium/plans", (_, res) => {
  res.send({ Success: true, Message: PREMIUM_PLANS });
});

/* ---------------------------------- */
/* CREATE PayPal Order */
/* ---------------------------------- */
const requireVerified = process.env.NODE_ENV === 'production';

router.post("/api/premium/checkout", whoami, async (req, res) => {
  try {
    const { option } = req.body;

    if (requireVerified && !req.user.verified)
      return res.send({ Success: false, Message: "Account not verified" });

    if (!isValidPlan(option))
      return res.send({ Success: false, Message: "Invalid plan" });

    const price = PREMIUM_PLANS[option].price;

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [
        {
          description: `Premium-${option}`,
          amount: {
            currency_code: "USD",
            value: price.toFixed(2)
          }
        }
      ]
    });

    const order = await paypalClient.execute(request);

    res.send({
      Success: true,
      Message: {
        orderID: order.result.id
      }
    });
  } catch (err) {
    console.error(err);
    res.send({ Success: false, Message: "Checkout failed" });
  }
});

/* ---------------------------------- */
/* CAPTURE PAYMENT */
/* ---------------------------------- */
router.post("/api/premium/capture", whoami, async (req, res) => {
  try {
    const { orderID, option } = req.body;

    if (!orderID || !isValidPlan(option))
      return res.send({ Success: false, Message: "Invalid request" });

    const captureRequest = new paypal.orders.OrdersCaptureRequest(orderID);
    captureRequest.requestBody({});

    const capture = await paypalClient.execute(captureRequest);

    if (capture.result.status !== "COMPLETED")
      return res.send({ Success: false, Message: "Payment not completed" });

    const amount =
      capture.result.purchase_units[0].payments.captures[0].amount.value;

    if (Number(amount) !== PREMIUM_PLANS[option].price)
      return res.send({ Success: false, Message: "Price mismatch" });

    const user = await USERS.findById(req.user._id);
    if (!user) return res.send({ Success: false, Message: "User not found" });

    // Prevent overwriting active premium
    if (user.premium?.hasPremium && user.premium.to > new Date()) {
      return res.send({
        Success: false,
        Message: "Premium already active"
      });
    }

    user.premium = {
      hasPremium: true,
      premiumType: option,
      to: addDays(30)
    };

    user.transactions.push({
      orderID,
      plan: option,
      amount,
      date: new Date()
    });

    await user.save();

    res.send({ Success: true, Message: "Premium activated" });
  } catch (err) {
    console.error(err);
    res.send({ Success: false, Message: "Capture failed" });
  }
});

/* ---------------------------------- */
/* PAYPAL WEBHOOK */
/* ---------------------------------- */
router.post(
  "/api/premium/webhook",
  express.json({ type: "application/json" }),
  async (req, res) => {
    try {
      // Note: @paypal/checkout-server-sdk doesn't include webhook verification
      // For production, consider using @paypal/payouts-sdk or implementing manual verification
      // For now, we'll process webhooks without SDK verification
      // In production, you should verify the webhook signature manually or use PayPal's REST API SDK
      
      // Basic validation: check if required fields exist
      if (!req.body || !req.body.event_type) {
        console.error("Invalid webhook payload");
        return res.sendStatus(400);
      }

      // Only process payment completion events
      if (req.body.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
        return res.sendStatus(200);
      }

      const capture = req.body.resource;
      if (!capture || !capture.supplementary_data?.related_ids?.order_id) {
        console.error("Invalid capture data in webhook");
        return res.sendStatus(200);
      }

      const orderID = capture.supplementary_data.related_ids.order_id;
      const description =
        capture.purchase_units?.[0]?.description || "Premium-Basic";

      const plan = description.split("-")[1];
      if (!isValidPlan(plan)) {
        console.error("Invalid plan in webhook:", plan);
        return res.sendStatus(200);
      }

      // Find user by orderID in transactions
      const user = await USERS.findOne({
        "transactions.orderID": orderID
      });

      if (!user) {
        console.error("User not found for orderID:", orderID);
        return res.sendStatus(200);
      }

      // Update user premium status
      user.premium = {
        hasPremium: true,
        premiumType: plan,
        to: addDays(30)
      };

      await user.save();
      console.log("Webhook processed successfully for orderID:", orderID);
      res.sendStatus(200);
    } catch (err) {
      console.error("Webhook error:", err);
      res.sendStatus(500);
    }
  }
);

export default router;

/* ---------------------------------- */
/* Test-only: activate premium for current user (non-production only) */
/* ---------------------------------- */
router.post('/api/premium/test-activate', whoami, async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.sendStatus(404);

  try {
    const { option } = req.body;
    if (!isValidPlan(option)) return res.send({ Success: false, Message: 'Invalid plan' });

    const user = await USERS.findById(req.user._id);
    if (!user) return res.send({ Success: false, Message: 'User not found' });

    user.premium = { hasPremium: true, premiumType: option, to: addDays(30) };
    user.transactions.push({ orderID: `TEST-${Date.now()}`, plan: option, amount: PREMIUM_PLANS[option].price, date: new Date() });
    await user.save();

    res.send({ Success: true, Message: 'Test premium activated' });
  } catch (err) {
    console.error(err);
    res.send({ Success: false, Message: 'Test activation failed' });
  }
});
