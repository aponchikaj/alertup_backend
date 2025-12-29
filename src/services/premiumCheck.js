import USERS from "../models/user.model.js";
import BUILDINGS from "../models/building.model.js";
import sendMail from "./sendEmail.js";

/**
 * Check premium status and deactivate buildings for users with expired premium
 * This function should be called daily via cron job
 */
export const checkPremiumStatus = async () => {
  try {
    const now = new Date();

    // Find all users with expired premium (to date has passed)
    const usersWithExpiredPremium = await USERS.find({
      $or: [
        { "premium.hasPremium": true, "premium.to": { $lt: now } },
        { "premium.hasPremium": false }
      ]
    });

    for (const user of usersWithExpiredPremium) {
      // Check if premium has expired
      const hasExpiredPremium = user.premium?.hasPremium && user.premium?.to && new Date(user.premium.to) < now;
      const hasNoPremium = !user.premium?.hasPremium;
      
      // Skip if user has active premium
      if (user.premium?.hasPremium && !hasExpiredPremium) {
        continue;
      }

      // For users without premium, check if they've been registered for more than 1 month
      if (hasNoPremium) {
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        const userCreatedAt = user._id.getTimestamp ? user._id.getTimestamp() : (user.updatedAt || new Date());
        
        // Only process if user was created more than 1 month ago
        if (userCreatedAt > oneMonthAgo) {
          continue; // User is still within the 1 month grace period
        }
      }

      // If premium expired, update status
      if (hasExpiredPremium) {
        user.premium.hasPremium = false;
        await user.save();
      }

      // Get all buildings for this user
      const userBuildings = await BUILDINGS.find({ owner: user._id });
      
      if (userBuildings.length <= 1) {
        continue; // User has 1 or fewer buildings, nothing to deactivate
      }

      // Find the first active building (or first building if all are deactivated)
      const firstBuilding = userBuildings.find(b => !b.isDeactivated) || userBuildings[0];
      
      // Deactivate all buildings except the first one
      const buildingsToDeactivate = userBuildings.filter(
        b => b._id.toString() !== firstBuilding._id.toString()
      );

      if (buildingsToDeactivate.length === 0) {
        continue; // No buildings to deactivate
      }

      // Deactivate buildings
      await BUILDINGS.updateMany(
        { _id: { $in: buildingsToDeactivate.map(b => b._id) } },
        { $set: { isDeactivated: true } }
      );

      // Send deactivation email
      const buildingNames = buildingsToDeactivate.map(b => b.buildingName).join(", ");
      const expirationMessage = hasExpiredPremium 
        ? "Your premium subscription has expired." 
        : "Your free trial period has ended.";
      
      const deactivationEmailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #FF7B22;">Building Deactivation Notice</h2>
          <p>Dear ${user.name || "User"},</p>
          <p>${expirationMessage} We have deactivated the following buildings:</p>
          <ul>
            ${buildingsToDeactivate.map(b => `<li><strong>${b.buildingName}</strong></li>`).join("")}
          </ul>
          <p>You can keep <strong>${firstBuilding.buildingName}</strong> active on the free plan.</p>
          <p>To reactivate all your buildings and unlock premium features, please purchase a premium plan.</p>
          <p style="margin-top: 30px;">
            <a href="https://alertup.world/premium" 
               style="background-color: #FF7B22; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
              Purchase Premium
            </a>
          </p>
          <p style="margin-top: 20px; color: #666; font-size: 12px;">
            This is an automated message. Please do not reply to this email.
          </p>
        </div>
      `;

      const emailSubject = hasExpiredPremium 
        ? "Premium Expired - Building Deactivation Notice - AlertUp"
        : "Building Deactivation Notice - AlertUp";
      
      const emailText = hasExpiredPremium
        ? `Your premium subscription has expired. Buildings ${buildingNames} have been deactivated. Purchase premium to reactivate them. Visit https://alertup.world/premium`
        : `Your free trial has ended. Buildings ${buildingNames} have been deactivated. Purchase premium to reactivate them. Visit https://alertup.world/premium`;

      await sendMail(
        user.email,
        emailSubject,
        emailText,
        undefined,
        deactivationEmailHtml
      );

      // Send premium invoice/upgrade email
      const premiumInvoiceHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #FF7B22;">Upgrade to Premium - AlertUp</h2>
          <p>Dear ${user.name || "User"},</p>
          <p>Unlock the full potential of AlertUp with our premium plans:</p>
          <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3>Premium Plans:</h3>
            <ul style="list-style: none; padding: 0;">
              <li style="padding: 10px; border-bottom: 1px solid #ddd;">
                <strong>Basic Premium</strong> - $4.99/month<br>
                <small>3 buildings, 5 floors per building</small>
              </li>
              <li style="padding: 10px; border-bottom: 1px solid #ddd;">
                <strong>Platinum Premium</strong> - $8.99/month<br>
                <small>6 buildings, 10 floors per building</small>
              </li>
              <li style="padding: 10px; border-bottom: 1px solid #ddd;">
                <strong>Elite Premium</strong> - $12.99/month<br>
                <small>10 buildings, 20 floors per building</small>
              </li>
              <li style="padding: 10px;">
                <strong>Professional Premium</strong> - $24.99/month<br>
                <small>25 buildings, 50 floors per building</small>
              </li>
            </ul>
          </div>
          <p style="margin-top: 30px;">
            <a href="https://alertup.world/premium" 
               style="background-color: #FF7B22; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
              Purchase Premium Plan
            </a>
          </p>
          <p style="margin-top: 20px; color: #666; font-size: 12px;">
            This is an automated message. Please do not reply to this email.
          </p>
        </div>
      `;

      await sendMail(
        user.email,
        "Purchase Premium - AlertUp",
        `Purchase premium to unlock all features. Visit https://alertup.world/premium to see our plans.`,
        undefined,
        premiumInvoiceHtml
      );
    }
  } catch (err) {
    console.error("❌ Error in premium status check:", err);
  }
};

