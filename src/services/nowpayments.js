// NowPayments.io Payment Service
// Handles crypto payment links and invoice management

const PAYMENT_LINKS = {
  Basic: {
    price: 4.99,
    currency: "USD",
    invoiceId: "6349197134",
    link: "https://nowpayments.io/payment/?iid=6349197134",
    name: "Basic Premium"
  },
  Platinum: {
    price: 8.99,
    currency: "USD",
    invoiceId: "5899684860",
    link: "https://nowpayments.io/payment/?iid=5899684860",
    name: "Platinum Premium"
  },
  Elite: {
    price: 12.99,
    currency: "USD",
    invoiceId: "5973950086",
    link: "https://nowpayments.io/payment/?iid=5973950086",
    name: "Elite Premium"
  },
  Professional: {
    price: 24.99,
    currency: "USD",
    invoiceId: "6194298377",
    link: "https://nowpayments.io/payment/?iid=6194298377",
    name: "Professional Premium"
  }
};

// Preferred stablecoins to offer to users
const PREFERRED_CURRENCIES = ["USDT", "USDC"];

export const getPaymentLink = (planName, preferredCurrency) => {
  const base = PAYMENT_LINKS[planName];
  if (!base) return null;
  // If preferredCurrency provided and supported, append coin param
  if (preferredCurrency && PREFERRED_CURRENCIES.includes(preferredCurrency)) {
    // Many NowPayments payment pages accept `&coin=`; append `coin` param.
    return `${base.link}&coin=${encodeURIComponent(preferredCurrency)}`;
  }
  // Otherwise return the base link and frontend will let user choose
  return base.link;
};

export const getAllPaymentLinks = () => {
  return PAYMENT_LINKS;
};

export const getPreferredCurrencies = () => {
  return PREFERRED_CURRENCIES;
};

export const validatePlanPrice = (planName, price) => {
  const paymentInfo = PAYMENT_LINKS[planName];
  if (!paymentInfo) return false;
  return Math.abs(paymentInfo.price - price) < 0.01; // Allow for floating point variance
};
