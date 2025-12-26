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
router.post("/api/premium/checkout", whoami, async (req, res) => {
  try {
    const { option } = req.body;

    if (!req.user.verified)
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
      const verifyReq =
        new paypal.notifications.WebhookEventVerifySignatureRequest();

      verifyReq.requestBody({
        auth_algo: req.headers["paypal-auth-algo"],
        cert_url: req.headers["paypal-cert-url"],
        transmission_id: req.headers["paypal-transmission-id"],
        transmission_sig: req.headers["paypal-transmission-sig"],
        transmission_time: req.headers["paypal-transmission-time"],
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: req.body
      });

      const response = await paypalClient.execute(verifyReq);

      if (response.result.verification_status !== "SUCCESS")
        return res.sendStatus(400);

      if (req.body.event_type !== "PAYMENT.CAPTURE.COMPLETED")
        return res.sendStatus(200);

      const capture = req.body.resource;
      const orderID = capture.supplementary_data.related_ids.order_id;
      const description =
        capture.purchase_units?.[0]?.description || "Premium-Basic";

      const plan = description.split("-")[1];
      if (!isValidPlan(plan)) return res.sendStatus(200);

      const user = await USERS.findOne({
        "transactions.orderID": orderID
      });

      if (!user) return res.sendStatus(200);

      user.premium = {
        hasPremium: true,
        premiumType: plan,
        to: addDays(30)
      };

      await user.save();
      res.sendStatus(200);
    } catch (err) {
      console.error(err);
      res.sendStatus(500);
    }
  }
);

export default router;
