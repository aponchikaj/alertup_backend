import axios from "axios";
import qs from "qs";

export const getPayPalAccessToken = async () => {
  try {
    // Determine sandbox vs live. Respect PAYPAL_ENV (live/sandbox) first, then PAYPAL_SANDBOX.
    const useSandbox = (() => {
      if (process.env.PAYPAL_ENV) {
        const e = process.env.PAYPAL_ENV.toLowerCase();
        if (e === 'live') return false;
        if (e === 'sandbox') return true;
      }
      return process.env.PAYPAL_SANDBOX !== 'false';
    })();

    const apiUrl = useSandbox
      ? "https://api-m.sandbox.paypal.com/v1/oauth2/token"
      : "https://api-m.paypal.com/v1/oauth2/token";

    console.log(`PAYPAL_ENV: ${process.env.PAYPAL_ENV || 'not set'}`);
    console.log(`PAYPAL_SANDBOX: ${process.env.PAYPAL_SANDBOX || 'not set'}`);
    console.log(`Using PayPal ${useSandbox ? 'SANDBOX' : 'LIVE'} environment`);
    console.log(`API URL: ${apiUrl}`);

    // Log presence of credentials (do NOT log the secret itself)
    console.log('PAYPAL_CLIENT_ID present:', !!process.env.PAYPAL_CLIENT_ID);
    console.log('PAYPAL_CLIENT_SECRET present:', !!process.env.PAYPAL_CLIENT_SECRET);

    const auth = Buffer.from(
      `${process.env.PAYPAL_CLIENT_ID || ''}:${process.env.PAYPAL_CLIENT_SECRET || ''}`
    ).toString("base64");

    const res = await axios.post(
      apiUrl,
      qs.stringify({ grant_type: "client_credentials" }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${auth}`,
        },
      }
    );

    return res.data.access_token;
  } catch (err) {
    console.error("PayPal access token error:", err.response?.data || err.message);
    console.error("PayPal access token error status:", err.response?.status);

    // Attach more context to the thrown error so caller can return details
    const details = err.response?.data || { message: err.message };
    const status = err.response?.status;
    const e = new Error("Failed to get PayPal access token");
    e.details = details;
    e.status = status;
    throw e;
  }
};
