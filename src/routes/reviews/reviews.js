import express from "express";
import WEBSITE_REVIEWS from "../../models/reviews.model.js";
import whoami from "../../middlewares/whoami.js";
import sendMail from "../../services/sendEmail.js";

const router = express.Router();

router.post("/api/review/alertup", whoami, async (req, res) => {
  const { stars, comment } = req.body;

  try {
    // Validate stars
    if (typeof stars !== "number" || stars < 1 || stars > 5) {
      return res.send({
        Success: false,
        Message: "Stars must be between 1 and 5.",
      });
    }

    // Validate comment length
    if (comment && comment.length > 500) {
      return res.send({
        Success: false,
        Message: "Comment too long.",
      });
    }

    // Check if user already sent review
    const exists = await WEBSITE_REVIEWS.findOne({
      userID: req.user._id,
    });

    if (exists) {
      return res.send({
        Success: false,
        Message: "Already sent.",
      });
    }

    const displayName =
      req.user.userType === "Individual"
        ? req.user.name
        : req.user.company;

    const reviewConfig = {
      userID: req.user._id,
      userName: displayName,
      userType: req.user.userType,
      stars: stars,
      comment: comment,
    };

    const newWebsiteReview = new WEBSITE_REVIEWS(reviewConfig);
    await newWebsiteReview.save();

    // Email HTML
    const reviewThankYouHTML = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #ffffff; padding: 30px; border-radius: 8px;">
          <h1 style="color: #FF7B22;">🙏 Thank You for Your Feedback</h1>

          <p>Hello <strong>${displayName}</strong>,</p>

          <p>
            Thank you for taking the time to leave a review about
            <strong>AlertUp</strong>.
          </p>

          <p>
            Your feedback helps us understand what we’re doing well and where
            we can improve.
          </p>

          <p>
            If you ever have ideas or suggestions, feel free to reply to this
            email — we’d love to hear from you.
          </p>

          <p style="margin-top: 24px;">
            Thanks again for supporting AlertUp 🚀
          </p>

          <p style="margin-top: 30px;">
            Best regards,<br />
            <strong>Lazare Mirziashvili</strong><br />
            Founder, AlertUp
          </p>
        </div>
      </div>
    `;

    // Send email (do not block response if fails)
    try {
      await sendMail(
        req.user.email,
        "Thank you for your feedback on AlertUp",
        "Thank you for supporting AlertUp 🚀",
        "lazaremirziashvili8@gmail.com",
        reviewThankYouHTML
      );
    } catch (err) {
      console.error("Couldn't send email:", err.message);
    }

    return res.send({
      Success: true,
      Message: "Sent.",
    });
  } catch (err) {
    console.error(err);
    return res.send({
      Success: false,
      Message: "Something went wrong.",
    });
  }
});

router.get("/api/review/already", whoami, async (req, res) => {
  try {
    const exists = await WEBSITE_REVIEWS.findOne({
      userID: req.user._id,
    });

    if (exists) {
      return res.send({
        Success: false,
        Message: "Sent",
      });
    }

    return res.send({
      Success: true,
      Message: "Can",
    });
  } catch {
    return res.send({
      Success: false,
      Message: "Something went wrong.",
    });
  }
});

export default router;
