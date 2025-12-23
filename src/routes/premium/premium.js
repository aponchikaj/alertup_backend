import express from 'express';
import USERS from '../../models/user.model.js';
import whoami from '../../middlewares/whoami.js';
import paypal from '@paypal/checkout-server-sdk';
import dotenv from 'dotenv';
import crypto from 'crypto'
dotenv.config();

const router = express.Router();

// PayPal environment setup
let paypalEnv;
if (process.env.PAYPAL_ENV === "live") {
    paypalEnv = new paypal.core.LiveEnvironment(
        process.env.PAYPAL_CLIENT_ID,
        process.env.PAYPAL_CLIENT_SECRET
    );
} else {
    paypalEnv = new paypal.core.SandboxEnvironment(
        process.env.PAYPAL_CLIENT_ID,
        process.env.PAYPAL_CLIENT_SECRET
    );
}
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnv);

// Premium options
const PREMIUM_OPTIONS = {
  Basic: { title: "Basic", limits: { maxBuildings: 3, maxFloors: 5 }, price: 4.99, onSale: false, salePrice: 0 },
  Platinum: { title: "Platinum", limits: { maxBuildings: 6, maxFloors: 10 }, price: 9.99, onSale: false, salePrice: 0 },
  Elite: { title: "Elite", limits: { maxBuildings: 10, maxFloors: 20 }, price: 19.99, onSale: false, salePrice: 0 },
  Professional: { title: "Professional", limits: { maxBuildings: 25, maxFloors: 50 }, price: 29.99, onSale: false, salePrice: 0 }
};

// GET premium status
router.get('/api/premium/status', whoami, async (req, res) => {
  try {
    const user = await USERS.findById(req.user._id);
    if (!user) return res.send({ Success: false, Message: "Something went wrong." });
    return res.send({ Success: true, Message: { 
      premiumType: user.premium?.premiumType || null,
      expires: user.premium?.to || null,
      hasPremium: user.premium?.hasPremium || false
    }});
  } catch { return res.send({ Success: false, Message: 'Server error.' }); }
});

// GET premium plans
router.get('/api/premium/plans', (req, res) => {
  return res.send({ Success: true, Message: PREMIUM_OPTIONS });
});

// POST create PayPal order (checkout)
router.post('/api/premium/checkout', whoami, async (req, res) => {
  const { option } = req.body;

  if(req.user.verified ==false){
    return res.send({Success:false,Message:"Not verified."})
  }

  if (!option || !PREMIUM_OPTIONS[option]) {
    return res.send({ Success: false, Message: "Invalid premium option." });
  }

  const plan = PREMIUM_OPTIONS[option];
  const price = plan.onSale ? plan.salePrice : plan.price;

  // Create PayPal order
  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer("return=representation");
  request.requestBody({
    intent: "CAPTURE",
    purchase_units: [{
      amount: {
        currency_code: "USD",
        value: price.toString()
      },
      description: `${plan.title} Premium Plan`
    }]
  });

  try {
    const order = await paypalClient.execute(request);
    return res.send({ Success: true, Message: { orderID: order.result.id, plan: option, price } });
  } catch (err) {
    console.error(err);
    return res.send({ Success: false, Message: "PayPal order creation failed." });
  }
});

// POST capture PayPal payment after approval
router.post('/api/premium/capture', whoami, async (req, res) => {
  const { orderID, option } = req.body;
  if (!orderID || !option || !PREMIUM_OPTIONS[option]) return res.send({ Success: false, Message: "Invalid request." });

  const request = new paypal.orders.OrdersCaptureRequest(orderID);
  request.requestBody({});

  try {
    const capture = await paypalClient.execute(request);

    // Activate premium for 30 days
    const user = await USERS.findById(req.user._id);
    const now = new Date();
    const expires = new Date(now.setDate(now.getDate() + 30));

    user.premium = {
      hasPremium: true,
      premiumType: option,
      to: expires
    };
    await user.save();

    return res.send({ Success: true, Message: "Premium activated successfully!", capture });
  } catch (err) {
    console.error(err);
    return res.send({ Success: false, Message: "Payment capture failed." });
  }
});

// Cancel premium
router.post('/api/premium/cancel', whoami, async (req, res) => {
  try {
    const user = await USERS.findById(req.user._id);
    user.premium = { hasPremium: false, premiumType: null, to: null };
    await user.save();
    return res.send({ Success: true, Message: "Premium canceled." });
  } catch { return res.send({ Success: false, Message: "Server error." }); }
});

router.post('/api/premium/webhook', express.json({ type: 'application/json' }), async (req, res) => {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID; // from your .env
  const transmissionId = req.headers['paypal-transmission-id'];
  const transmissionTime = req.headers['paypal-transmission-time'];
  const certUrl = req.headers['paypal-cert-url'];
  const authAlgo = req.headers['paypal-auth-algo'];
  const transmissionSig = req.headers['paypal-transmission-sig'];
  const webhookEvent = req.body;

  // Verify webhook signature
  const verifyRequest = new paypal.notifications.WebhookEventVerifySignatureRequest();
  verifyRequest.requestBody({
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
    webhook_event: webhookEvent
  });

  try {
    const response = await paypalClient.execute(verifyRequest);

    if (response.result.verification_status !== 'SUCCESS') {
      return res.status(400).send('Webhook verification failed');
    }

    // Handle specific event types
    if (webhookEvent.event_type === 'CHECKOUT.ORDER.APPROVED' || webhookEvent.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const orderID = webhookEvent.resource.id;
      const payerEmail = webhookEvent.resource.payer?.email_address;

      // OPTIONAL: find user by email or by metadata if you sent it in purchase_units
      const user = await USERS.findOne({ email: payerEmail });
      if (user) {
        const planOption = webhookEvent.resource.purchase_units?.[0]?.description?.split(' ')[0] || 'Basic';
        const now = new Date();
        const expires = new Date(now.setDate(now.getDate() + 30));

        user.premium = {
          hasPremium: true,
          premiumType: planOption,
          to: expires
        };

        user.transactions.push(
          {
            orderID:orderID,
            date:Date.now(),
            plan:planOption,
            transmissionId:transmissionId,
            transmissionTime:transmissionTime
          }
        )

        await user.save();
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

export default router;
