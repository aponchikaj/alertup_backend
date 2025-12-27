import axios from "axios";
import qs from "qs";

export const getPayPalAccessToken = async () => {
  try {
    const auth = Buffer.from(
      `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
    ).toString("base64");

    const res = await axios.post(
      "https://api-m.paypal.com/v1/oauth2/token",
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
    throw new Error("Failed to get PayPal access token");
  }
};
