import express from "express";
import prisma from "../../db/prisma.js";
import whoami from "../../middlewares/whoami.js";
import sendMail from "../../services/sendEmail.js";
import { ok, fail } from "../../utils/respond.js";

const router = express.Router();

router.post("/api/review/alertup", whoami, async (req, res) => {
  const { stars, comment } = req.body;

  try {
    // Validate stars
    if (typeof stars !== "number" || stars < 1 || stars > 5) {
      return fail(res, 400, "Stars must be between 1 and 5.");
    }

    // Validate comment length
    if (comment && comment.length > 500) {
      return fail(res, 400, "Comment too long.");
    }

    // Check if user already sent a review (userId is unique on Review)
    const exists = await prisma.review.findUnique({
      where: { userId: req.user.id },
    });

    if (exists) {
      return fail(res, 409, "Already sent.");
    }

    const displayName =
      req.user.userType === "COMPANY" ? req.user.company : req.user.name;

    try {
      await prisma.review.create({
        data: {
          userId: req.user.id,
          userName: displayName,
          userType: req.user.userType,
          stars,
          comment,
        },
      });
    } catch (err) {
      // Unique(userId) race: two submissions in flight — same answer as the
      // pre-check above.
      if (err.code === "P2002") return fail(res, 409, "Already sent.");
      throw err;
    }

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

    return ok(res, { message: "Sent." });
  } catch (err) {
    console.error(err);
    return fail(res, 500, "Something went wrong.");
  }
});

router.get("/api/review/already", whoami, async (req, res) => {
  try {
    const exists = await prisma.review.findUnique({
      where: { userId: req.user.id },
    });

    // success:false + "Sent" is the legacy contract the frontend reads to know
    // the user already reviewed; it now rides a real conflict status.
    if (exists) {
      return fail(res, 409, "Sent");
    }

    return ok(res, { message: "Can" });
  } catch (err) {
    console.error(err);
    return fail(res, 500, "Something went wrong.");
  }
});

export default router;
