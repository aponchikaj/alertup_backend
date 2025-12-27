import express from "express";
import dotenv from "dotenv";
import paypal from "@paypal/checkout-server-sdk";
import USERS from "../../models/user.model.js";
import whoami from "../../middlewares/whoami.js";
import sendMail from "../../services/sendEmail.js";

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
  Basic: { price: 4.99, limits: { maxBuildings: 3, maxFloors: 5 } },
  Platinum: { price: 8.99, limits: { maxBuildings: 6, maxFloors: 10 } },
  Elite: { price: 12.99, limits: { maxBuildings: 10, maxFloors: 20 } },
  Professional: { price: 24.99, limits: { maxBuildings: 25, maxFloors: 50 } },
};

/* ---------------- Helpers ---------------- */
const addDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};

const isValidPlan = (plan) => !!PREMIUM_PLANS[plan];

/* ---------------- APIs ---------------- */

// 1️⃣ Check premium status
router.get("/api/premium/status", whoami, async (req, res) => {
  try {
    const user = await USERS.findById(req.user._id).lean();
    if (!user) return res.send({ Success: false, Message: "User not found" });
    res.send({
      Success: true,
      Message: {
        hasPremium: user.premium?.hasPremium || false,
        premiumType: user.premium?.premiumType || null,
        expires: user.premium?.to || null,
      },
    });
  } catch {
    res.send({ Success: false, Message: "Server error" });
  }
});

// 2️⃣ Get available plans
router.get("/api/premium/plans", (_, res) => {
  res.send({ Success: true, Message: PREMIUM_PLANS });
});

// 3️⃣ Create PayPal order
router.post("/api/premium/checkout", whoami, async (req, res) => {
  try {
    const { option } = req.body;
    if (!isValidPlan(option)) return res.send({ Success: false, Message: "Invalid plan" });

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [{
        description: `Premium-${option}`,
        amount: { currency_code: "USD", value: PREMIUM_PLANS[option].price.toFixed(2) }
      }]
    });

    const order = await paypalClient.execute(request);
    res.send({ Success: true, Message: { orderID: order.result.id } });
  } catch (err) {
    console.error("Checkout error:", err);
    res.send({ Success: false, Message: "Checkout failed" });
  }
});

// 3️⃣ Capture payment
router.post("/api/premium/capture", whoami, async (req, res) => {
  try {
    const { orderID, option } = req.body;
    if (!orderID || !isValidPlan(option)) return res.send({ Success: false, Message: "Invalid request" });

    const captureRequest = new paypal.orders.OrdersCaptureRequest(orderID);
    captureRequest.requestBody({});
    const capture = await paypalClient.execute(captureRequest);

    if (capture.result.status !== "COMPLETED")
      return res.send({ Success: false, Message: "Payment not completed" });

    const amount = Number(capture.result.purchase_units[0].payments.captures[0].amount.value);
    if (amount !== PREMIUM_PLANS[option].price)
      return res.send({ Success: false, Message: "Price mismatch" });

    const user = await USERS.findById(req.user._id);
    if (!user) return res.send({ Success: false, Message: "User not found" });

    user.premium = { hasPremium: true, premiumType: option, to: addDays(30) };
    const transactionDate = new Date();
    user.transactions.push({ orderID, plan: option, amount, date: transactionDate });
    await user.save();

    // Send invoice email to user
    try {
      const invoiceHTML = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h1 style="color: #FF7B22; margin-top: 0;">Thank You for Your Purchase!</h1>
            <p style="color: #333; font-size: 16px;">Hello ${user.username},</p>
            <p style="color: #666;">Your premium subscription has been successfully activated. Below are your invoice details:</p>
            
            <div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin: 20px 0;">
              <h2 style="color: #333; margin-top: 0; font-size: 18px;">Invoice Details</h2>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; color: #666;">Order ID:</td>
                  <td style="padding: 8px 0; text-align: right; font-weight: bold; color: #333;">${orderID}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #666;">Plan:</td>
                  <td style="padding: 8px 0; text-align: right; font-weight: bold; color: #333;">${option} Premium</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #666;">Amount:</td>
                  <td style="padding: 8px 0; text-align: right; font-weight: bold; color: #FF7B22; font-size: 18px;">$${amount.toFixed(2)} USD</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #666;">Payment Date:</td>
                  <td style="padding: 8px 0; text-align: right; color: #333;">${transactionDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #666;">Valid Until:</td>
                  <td style="padding: 8px 0; text-align: right; color: #333;">${addDays(30).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td>
                </tr>
              </table>
            </div>
            
            <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #4caf50;">
              <p style="margin: 0; color: #2e7d32; font-weight: bold;">✓ Premium Status: Active</p>
              <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">You now have access to all premium features!</p>
            </div>
            
            <p style="color: #666; font-size: 14px; margin-top: 30px;">If you have any questions about your subscription, please don't hesitate to contact us.</p>
            
            <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
          </div>
          
          <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
            <p>This is an automated invoice. Please keep this email for your records.</p>
          </div>
        </div>
      `;

      const invoiceText = `
Thank You for Your Purchase!

Hello ${user.username},

Your premium subscription has been successfully activated.

Invoice Details:
- Order ID: ${orderID}
- Plan: ${option} Premium
- Amount: $${amount.toFixed(2)} USD
- Payment Date: ${transactionDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
- Valid Until: ${addDays(30).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}

Premium Status: Active
You now have access to all premium features!

If you have any questions about your subscription, please don't hesitate to contact us.

Best regards,
AlertUp Team
      `;

      await sendMail(
        user.email,
        `Invoice - ${option} Premium Subscription - AlertUp`,
        invoiceText,
        undefined,
        invoiceHTML
      );
    } catch (emailErr) {
      console.error("Failed to send invoice email:", emailErr);
      // Don't fail the request if email fails, payment was successful
    }

    res.send({ Success: true, Message: "Premium activated" });
  } catch (err) {
    console.error("Capture error:", err);
    res.send({ Success: false, Message: "Capture failed" });
  }
});

// 5️⃣ Webhook (PayPal notification)
router.post("/api/premium/webhook", express.json({ type: "application/json" }), async (req, res) => {
  try {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    const { "paypal-transmission-id": transmissionId, "paypal-transmission-time": transmissionTime, "paypal-cert-url": certUrl, "paypal-auth-algo": authAlgo, "paypal-transmission-sig": transmissionSig } = req.headers;

    if (!transmissionId || !transmissionSig) return res.sendStatus(400);

    const verifyRequest = new paypal.notifications.VerifyWebhookSignatureRequest();
    verifyRequest.requestBody({
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: req.body,
    });

    const verifyResponse = await paypalClient.execute(verifyRequest);
    if (verifyResponse.result.verification_status !== "SUCCESS") return res.sendStatus(400);

    if (req.body.event_type !== "PAYMENT.CAPTURE.COMPLETED") return res.sendStatus(200);

    const capture = req.body.resource;
    const orderID = capture.supplementary_data?.related_ids?.order_id;
    const plan = capture.purchase_units?.[0]?.description.split("-")[1];
    if (!isValidPlan(plan)) return res.sendStatus(200);

    const user = await USERS.findOne({ "transactions.orderID": orderID });
    if (!user) return res.sendStatus(200);

    user.premium = { hasPremium: true, premiumType: plan, to: addDays(30) };
    await user.save();
    console.log("Webhook processed successfully for orderID:", orderID);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

export default router;
