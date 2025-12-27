import express from "express";
import dotenv from "dotenv";
import USERS from "../../models/user.model.js";
import BUILDINGS from "../../models/building.model.js";
import whoami from "../../middlewares/whoami.js";
import sendMail from "../../services/sendEmail.js";
import { getPaymentLink, getAllPaymentLinks } from "../../services/nowpayments.js";

dotenv.config();
const router = express.Router();

/* ---------------- Premium Plans (NowPayments) ---------------- */
const PREMIUM_PLANS = {
  Basic: { price: 4.99, name: "Basic Premium", invoiceId: "6349197134", link: "https://nowpayments.io/payment/?iid=6349197134", limits: { maxBuildings: 3, maxFloors: 5 } },
  Platinum: { price: 8.99, name: "Platinum Premium", invoiceId: "5899684860", link: "https://nowpayments.io/payment/?iid=5899684860", limits: { maxBuildings: 6, maxFloors: 10 } },
  Elite: { price: 12.99, name: "Elite Premium", invoiceId: "5973950086", link: "https://nowpayments.io/payment/?iid=5973950086", limits: { maxBuildings: 10, maxFloors: 20 } },
  Professional: { price: 24.99, name: "Professional Premium", invoiceId: "6194298377", link: "https://nowpayments.io/payment/?iid=6194298377", limits: { maxBuildings: 25, maxFloors: 50 } },
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

// ✅ Create payment - return NowPayments link
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

    // Return payment link for NowPayments
    res.send({ 
      Success: true, 
      Message: { 
        paymentLink: plan.link,
        invoiceId: plan.invoiceId,
        plan: option,
        price: plan.price,
        currency: "USD"
      } 
    });
  } catch (err) {
    console.error("Order creation error:", err);
    res.send({ 
      Success: false, 
      Message: "Payment initialization failed",
      error: err.message
    });
  }
});

// ✅ Manually confirm/activate premium (for webhook or manual verification)
router.post("/api/premium/confirm", whoami, async (req, res) => {
  try {
    const { invoiceId, plan } = req.body;
    if (!invoiceId) return res.send({ Success: false, Message: "Missing invoice ID" });
    if (!plan || !isValidPlan(plan)) return res.send({ Success: false, Message: "Invalid plan" });

    const user = await USERS.findById(req.user._id);
    if (!user) return res.send({ Success: false, Message: "User not found" });

    // Activate premium for the user
    return activatePremium(user, plan, invoiceId, res);
  } catch (err) {
    console.error("Confirm purchase error:", err);
    res.send({ Success: false, Message: "Purchase confirmation failed" });
  }
});

// Helper function to activate premium
const activatePremium = async (user, planOption, invoiceId, res) => {
  try {
    const wasPremium = user.premium?.hasPremium || false;
    const now = new Date();
    const expirationDate = addDays(30); // 1 month from now

    // Update user premium status with expiration date
    user.premium = {
      hasPremium: true,
      premiumType: planOption,
      invoiceId: invoiceId, // Store invoice ID for reference
      from: now,
      to: expirationDate, // Set expiration to 1 month from purchase
    };

    // Save transaction
    if (!user.transactions) user.transactions = [];
    user.transactions.push({
      invoiceId: invoiceId,
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

// Note: Premium will expire after 1 month from purchase date

export default router;
