import axios from "axios";
import qs from "qs";

export const getPayPalAccessToken = async () => {
  try {
    // Helper to sanitize env values (strip surrounding quotes and trim)
    const getEnv = (key) => {
      const v = process.env[key];
      if (!v && v !== "") return undefined;
      return String(v).replace(/^\s*"(.*)"\s*$/s, "$1").trim();
    };
  
    // Determine environment from sanitized env vars
    const envSetting = (getEnv('PAYPAL_ENV') || '').toLowerCase();
    const sandboxFlag = getEnv('PAYPAL_SANDBOX');
    const useSandbox = (() => {
      if (envSetting === 'live') return false;
      if (envSetting === 'sandbox') return true;
      return sandboxFlag !== 'false' && sandboxFlag !== '0';
    })();

    const apiUrl = useSandbox
      ? "https://api-m.sandbox.paypal.com/v1/oauth2/token"
      : "https://api-m.paypal.com/v1/oauth2/token";

    console.log(`PAYPAL_ENV: ${getEnv('PAYPAL_ENV') || 'not set'}`);
    console.log(`PAYPAL_SANDBOX: ${getEnv('PAYPAL_SANDBOX') || 'not set'}`);
    console.log(`Using PayPal ${useSandbox ? 'SANDBOX' : 'LIVE'} environment`);
    console.log(`API URL: ${apiUrl}`);

    const clientId = getEnv('PAYPAL_CLIENT_ID') || '';
    const clientSecret = getEnv('PAYPAL_CLIENT_SECRET') || '';
    console.log('PAYPAL_CLIENT_ID present:', !!clientId);
    console.log('PAYPAL_CLIENT_SECRET present:', !!clientSecret);
  
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

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
