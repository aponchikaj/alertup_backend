import express from "express";
import dotenv from "dotenv";
import paypal from "@paypal/checkout-server-sdk";
import USERS from "../../models/user.model.js";
import BUILDINGS from "../../models/building.model.js";
import whoami from "../../middlewares/whoami.js";
import sendMail from "../../services/sendEmail.js";
import axios from "axios";
import { getPayPalAccessToken } from "../../services/paypal.js";

dotenv.config();
const router = express.Router();

/* ---------------- PayPal Client ---------------- */
// Use sandbox environment by default unless PAYPAL_SANDBOX is explicitly set to 'false'
const useSandboxEnv = process.env.PAYPAL_SANDBOX !== 'false';
const paypalEnv = useSandboxEnv
  ? new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
  : new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
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
    
    // Check if premium has expired
    const now = new Date();
    if (user.premium?.hasPremium && user.premium?.to && new Date(user.premium.to) < now) {
      // Premium expired, update status
      user.premium.hasPremium = false;
      await user.save();
    }
    
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

// ✅ Create order for one-time payment
router.post("/api/premium/purchase", whoami, async (req, res) => {
  try {
    console.log("Purchase request received:", req.body);
    const { option } = req.body;
    
    if (!option) {
      console.error("Missing plan option in request");
      return res.send({ Success: false, Message: "Missing plan option" });
    }
    
    if (!isValidPlan(option)) {
      console.error("Invalid plan option:", option);
      return res.send({ Success: false, Message: `Invalid plan: ${option}` });
    }

    const plan = PREMIUM_PLANS[option];
    console.log("Selected plan:", plan);
    
    if (!plan) {
      console.error("Plan not found in PREMIUM_PLANS");
      return res.send({ Success: false, Message: "Plan configuration error" });
    }

    // Check if PayPal credentials are configured
    if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
      console.error("PayPal credentials not configured");
      return res.send({ 
        Success: false, 
        Message: "PayPal payment system not configured. Please contact support." 
      });
    }

    console.log("Getting PayPal access token...");
    let accessToken;
    try {
      accessToken = await getPayPalAccessToken();
      console.log("PayPal access token obtained");
    } catch (tokenError) {
      console.error("Failed to get PayPal access token:", tokenError);
      return res.send({ 
        Success: false, 
        Message: "Failed to authenticate with PayPal. Please check PayPal credentials.", 
        error: tokenError.message 
      });
    }

    // Create PayPal order for one-time payment
    // Ensure price is formatted correctly (2 decimal places, string format)
    const priceValue = parseFloat(plan.price).toFixed(2);
    
    // Simplified order structure - minimal required fields
    const orderData = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: priceValue
          },
          description: `${plan.name} - 1 Month Premium Access`
        }
      ],
      application_context: {
        brand_name: "AlertUp",
        landing_page: "NO_PREFERENCE",
        user_action: "PAY_NOW",
        return_url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/premium/success`,
        cancel_url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/premium`
      }
    };
    
    // Determine PayPal API URL (sandbox or live)
    // Determine PayPal API URL (sandbox or live)
    const useSandbox = process.env.PAYPAL_SANDBOX !== 'false';
    const paypalApiUrl = useSandbox
      ? "https://api-m.sandbox.paypal.com/v2/checkout/orders"
      : "https://api-m.paypal.com/v2/checkout/orders";
    
    console.log(`Creating PayPal order with ${useSandbox ? 'SANDBOX' : 'LIVE'} API`);
    console.log(`PayPal API URL: ${paypalApiUrl}`);
    console.log("Order data:", JSON.stringify(orderData, null, 2));
    
    let response;
    try {
      response = await axios.post(
        paypalApiUrl,
        orderData,
        {
          headers: { 
            Authorization: `Bearer ${accessToken}`, 
            "Content-Type": "application/json",
            "Prefer": "return=representation"
          },
        }
      );
    } catch (paypalError) {
      console.error("=== PayPal API Error Details ===");
      console.error("Status:", paypalError.response?.status);
      console.error("Full Error Response:", JSON.stringify(paypalError.response?.data, null, 2));
      console.error("Error Message:", paypalError.message);
      
      // Extract detailed error information
      const errorData = paypalError.response?.data;
      let paypalErrorMessage = "PayPal API error";
      let errorDetails = [];
      
      if (errorData) {
        // PayPal v2 API error format
        if (errorData.name) {
          paypalErrorMessage = errorData.name;
        }
        if (errorData.message) {
          paypalErrorMessage = errorData.message;
        }
        if (errorData.details) {
          errorDetails = errorData.details.map(d => `${d.field}: ${d.issue}`).join(", ");
          paypalErrorMessage += ` - ${errorDetails}`;
        }
        if (errorData.debug_id) {
          console.error("PayPal Debug ID:", errorData.debug_id);
        }
      }
      
      return res.send({ 
        Success: false, 
        Message: paypalErrorMessage || paypalError.message || "Payment failed",
        error: errorData,
        details: `Status: ${paypalError.response?.status}`,
        debug_id: errorData?.debug_id
      });
    }

    console.log("PayPal order created:", response.data);

    const approveURL = response.data.links?.find((l) => l.rel === "approve")?.href;
    if (!approveURL) {
      console.error("No approval URL in PayPal response");
      return res.send({ Success: false, Message: "PayPal approval link missing", paypalResponse: response.data });
    }

    console.log("Order created successfully, orderID:", response.data.id);
    res.send({ 
      Success: true, 
      Message: { 
        orderID: response.data.id, 
        approveURL,
        plan: option,
        price: plan.price
      } 
    });
  } catch (err) {
    console.error("Order creation error - Full error:", err);
    console.error("Error response data:", err.response?.data);
    console.error("Error status:", err.response?.status);
    console.error("Error message:", err.message);
    
    const errorMessage = err.response?.data?.message || err.response?.data?.error_description || err.message || "Payment failed";
    res.send({ 
      Success: false, 
      Message: errorMessage, 
      error: err.response?.data || err.details,
      details: err.message || err.details
    });
  }
});

// ✅ Confirm/Activate premium purchase from checkout
router.post("/api/premium/confirm", whoami, async (req, res) => {
  try {
    const { orderID, plan } = req.body;
    if (!orderID) return res.send({ Success: false, Message: "Missing order ID" });
    if (!plan || !isValidPlan(plan)) return res.send({ Success: false, Message: "Invalid plan" });

    const user = await USERS.findById(req.user._id);
    if (!user) return res.send({ Success: false, Message: "User not found" });

    // Get order details from PayPal and capture payment
    const accessToken = await getPayPalAccessToken();
    const useSandbox = process.env.PAYPAL_SANDBOX !== 'false';
    const apiBase = useSandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
    const orderResponse = await axios.get(
      `${apiBase}/v2/checkout/orders/${orderID}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const order = orderResponse.data;
    
    // Check if order is already captured
    if (order.status === "COMPLETED") {
      // Payment already captured, just activate premium
      return activatePremium(user, plan, orderID, res);
    }

    // Capture the payment if not already captured
    if (order.status === "APPROVED") {
      const captureResponse = await axios.post(
        `${apiBase}/v2/checkout/orders/${orderID}/capture`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
      );

      if (captureResponse.data.status !== "COMPLETED") {
        return res.send({ Success: false, Message: "Payment not completed" });
      }

      return activatePremium(user, plan, orderID, res);
    }

    res.send({ Success: false, Message: `Order status: ${order.status}` });
  } catch (err) {
    console.error("Confirm purchase error:", err.response?.data || err.message);
    res.send({ Success: false, Message: "Purchase confirmation failed" });
  }
});

// Helper function to activate premium
const activatePremium = async (user, planOption, orderID, res) => {
  try {
    const wasPremium = user.premium?.hasPremium || false;
    const now = new Date();
    const expirationDate = addDays(30); // 1 month from now

    // Update user premium status with expiration date
    user.premium = {
      hasPremium: true,
      premiumType: planOption,
      subscriptionId: orderID, // Store order ID for reference
      from: now,
      to: expirationDate, // Set expiration to 1 month from purchase
    };

    // Save transaction
    if (!user.transactions) user.transactions = [];
    user.transactions.push({
      orderId: orderID,
      plan: planOption,
      amount: PREMIUM_PLANS[planOption].price,
      date: now,
    });

    await user.save();

    // Reactivate all deactivated buildings if user just purchased premium
    if (!wasPremium) {
      await BUILDINGS.updateMany(
        { owner: user._id, isDeactivated: true },
        { $set: { isDeactivated: false } }
      );
    }

    res.send({ Success: true, Message: "Premium activated successfully", expirationDate });
  } catch (err) {
    console.error("Activate premium error:", err);
    res.send({ Success: false, Message: "Failed to activate premium" });
  }
};

// Note: One-time purchases cannot be cancelled, but premium will expire after 1 month

// ✅ Webhook for payment events
router.post("/api/premium/webhook", express.json({ type: "application/json" }), async (req, res) => {
  try {
    const resource = req.body.resource;
    const eventType = req.body.event_type;

    // Payment completed for one-time purchase
    if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
      const orderID = resource.supplementary_data?.related_ids?.order_id;
      if (orderID) {
        // Find user by order ID in transactions
        const user = await USERS.findOne({ "transactions.orderId": orderID });
        if (user && !user.premium?.hasPremium) {
          // This is a backup activation in case frontend confirmation fails
          // The frontend confirmation should handle this, but this ensures it works
          const transaction = user.transactions.find(t => t.orderId === orderID);
          if (transaction && transaction.plan) {
            const now = new Date();
            const expirationDate = addDays(30);
            
            user.premium = {
              hasPremium: true,
              premiumType: transaction.plan,
              subscriptionId: orderID,
              from: now,
              to: expirationDate,
            };
            await user.save();

            // Reactivate buildings
            await BUILDINGS.updateMany(
              { owner: user._id, isDeactivated: true },
              { $set: { isDeactivated: false } }
            );
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

export default router;
