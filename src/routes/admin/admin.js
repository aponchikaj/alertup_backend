import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../../db/prisma.js';
import config from '../../config/index.js';
import isAdmin from '../../middlewares/isAdmin.js';
import sendMail from '../../services/sendEmail.js';
import { authLimiter } from '../../services/rateLimiter.js';
import { displayName } from '../../services/displayName.js';
import { escapeHtml } from '../../services/escapeHtml.js';
import { ok, fail } from '../../utils/respond.js';
import { isId } from '../../utils/ids.js';
import { legacyBuilding } from '../buildings/buildings.js';

/**
 * Normalize a search query: `?q=a&q=b` arrives as an array, and unbounded
 * input has no business reaching the database. Prisma `contains` takes the
 * string literally, so no regex escaping is needed anymore.
 */
const searchTerm = (q) => {
  const raw = Array.isArray(q) ? q[0] : q;
  return String(raw ?? '').slice(0, 100);
};

/** Case-insensitive contains filter across the admin-searchable user fields. */
const userSearchWhere = (q) =>
  q
    ? {
        OR: ['name', 'lastname', 'company', 'email'].map((field) => ({
          [field]: { contains: q, mode: 'insensitive' },
        })),
      }
    : {};

const router = express.Router();

// The premium system is gone: /api/admin/premiumUsers and
// /api/admin/user/givePremium/:id no longer exist, and user rows carry no
// premium fields.

// ########################################### IF ADMIN? SECTION ###########################################

// Reaching this handler means isAdmin verified the token — it returns 401/403 otherwise.
router.get('/api/admin/isAdmin', isAdmin, async (req, res) => {
  return ok(res);
});

// ########################################### LOGIN SECTION ###########################################

router.post('/api/admin/login', authLimiter, async (req, res) => {
  const { user, password } = req.body;

  try {
    if (!user || !password) {
      return fail(res, 401, 'Invalid credentials.');
    }

    if (user !== config.admin.user || password !== config.admin.pass) {
      return fail(res, 401, 'Invalid credentials.');
    }

    const adminToken = jwt.sign({ isAdmin: true }, config.jwt.secret, {
      expiresIn: '1h',
    });

    // Determine whether the current request is secure (HTTPS)
    const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    res.cookie('adminToken', adminToken, {
      httpOnly: true,
      secure: reqIsSecure,
      sameSite: reqIsSecure ? 'None' : 'Lax',
      maxAge: 60 * 60 * 1000,
      path: '/', // Ensure cookie is available across all paths
    });

    ok(res, { message: 'Logged in.' });

    // Security notification after the response — a mail outage must not block
    // the login itself.
    try {
      const adminLoginHTML = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h1 style="color: #d32f2f; margin-top: 0;">🔐 Admin Login Alert</h1>
            <p style="color: #333; font-size: 16px;">Security Notification</p>
            <p style="color: #666;">Someone logged in as <strong>admin</strong> on AlertUp.</p>
            <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #f44336;">
              <p style="margin: 0; color: #c62828; font-weight: bold;">⚠️ Login Details</p>
              <p style="margin: 5px 0; color: #666; font-size: 14px;"><strong>IP Address:</strong> ${req.ip}</p>
              <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;"><strong>Device:</strong> ${escapeHtml(req.headers['user-agent'] || '')}</p>
            </div>
            <p style="color: #666; font-size: 14px;">If this wasn't you, secure your account immediately.</p>
            <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Security Team</strong></p>
          </div>
        </div>
      `;
      await sendMail(
        config.email.notifyRecipient,
        'New admin login – AlertUp',
        `Admin Login Alert: Someone logged in as admin on AlertUp. IP: ${req.ip}, Device: ${req.headers['user-agent']}. If this wasn't you, secure your account immediately.`,
        undefined,
        adminLoginHTML
      );
    } catch (err) {
      console.error('MAIL ERROR:', err);
    }
  } catch (err) {
    console.error('Admin login error:', err);
    if (!res.headersSent) return fail(res, 500, 'Server error.');
  }
});

router.post('/api/admin/logout', async (req, res) => {
  try {
    // Determine whether the current request is secure (HTTPS)
    const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    res.clearCookie('adminToken', {
      httpOnly: true,
      secure: reqIsSecure,
      sameSite: reqIsSecure ? 'None' : 'Lax',
      path: '/',
    });
    return ok(res, { message: 'Logged out.' });
  } catch {
    return fail(res, 500, 'Something went wrong.');
  }
});

// ########################################### SendMail SECTION ###########################################

router.post('/api/admin/sendMail', isAdmin, async (req, res) => {
  const { user, subject, text } = req.body;

  try {
    if (!user || !subject || !text) {
      return fail(res, 400, 'Invalid fields.');
    }

    const findUser = await prisma.user.findUnique({
      where: { email: String(user).toLowerCase().trim() },
    });

    if (!findUser) {
      return fail(res, 404, 'User not found.');
    }

    const adminMessageHTML = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
        <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h1 style="color: #FF7B22; margin-top: 0;">${escapeHtml(subject)}</h1>
          <p style="color: #333; font-size: 16px;">Hello <strong>${escapeHtml(displayName(findUser))}</strong>,</p>
          <p style="color: #666; white-space: pre-wrap;">${escapeHtml(text)}</p>
          <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
        </div>
      </div>
    `;

    try {
      await sendMail(findUser.email, String(subject), String(text), undefined, adminMessageHTML);
    } catch (err) {
      console.error('MAIL ERROR:', err);
      return fail(res, 502, "Couldn't send the email.");
    }

    return ok(res, { message: 'Sent.' });
  } catch (err) {
    console.error('Admin sendMail error:', err);
    return fail(res, 500, 'Server error.');
  }
});

// ########################################### DASHBOARD SECTION ###########################################

router.get('/api/admin/dashboard', isAdmin, async (req, res) => {
  try {
    const [USERS_COUNT, REPORTS_COUNT, BUILDINGS_COUNT] = await Promise.all([
      prisma.user.count(),
      prisma.report.count(),
      prisma.building.count(),
    ]);

    return ok(res, {
      data: { USERS_COUNT, REPORTS_COUNT, BUILDINGS_COUNT },
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    return fail(res, 500, 'Server error.');
  }
});

// ########################################### USERS SECTION ###########################################

router.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    let { q = '', page = 1, limit = 20 } = req.query;

    page = Math.max(parseInt(page) || 1, 1);
    limit = Math.min(parseInt(limit) || 20, 100);

    const term = searchTerm(q);
    const where = userSearchWhere(term);

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);

    return ok(res, {
      data: {
        users,
        page,
        totalPages: Math.ceil(total / limit),
        totalUsers: total,
      },
    });
  } catch (err) {
    console.error('Admin users list error:', err);
    return fail(res, 500, 'Server error.');
  }
});

router.get('/api/admin/user/:id', isAdmin, async (req, res) => {
  const userID = req.params.id;
  try {
    if (!userID || !isId(userID)) {
      return fail(res, 400, 'Invalid user ID');
    }

    // Password is omitted globally by the Prisma client; nothing else on the
    // row is admin-secret.
    const user = await prisma.user.findUnique({ where: { id: userID } });

    if (!user) {
      return fail(res, 404, 'User not found.');
    }

    return ok(res, { data: user });
  } catch (err) {
    console.error(err);
    return fail(res, 500, 'Server error.');
  }
});

router.delete('/api/admin/user/:id', isAdmin, async (req, res) => {
  const userID = req.params.id;
  const { reason } = req.body || {};
  try {
    if (!userID || !isId(userID)) {
      return fail(res, 400, 'Invalid user ID');
    }

    const user = await prisma.user.findUnique({ where: { id: userID } });

    if (!user) {
      return fail(res, 404, 'User not found.');
    }

    // Owned buildings cascade their floors/nodes/edges/roles/members/invites/
    // logs/emergencies/scans via FK. Invites the user sent on OTHER buildings
    // are removed explicitly (invitedById is a required FK), then the user row
    // itself — memberships cascade, scan events and reviews null out.
    await prisma.$transaction([
      prisma.building.deleteMany({ where: { ownerId: user.id } }),
      prisma.buildingInvite.deleteMany({ where: { invitedById: user.id } }),
      prisma.user.delete({ where: { id: user.id } }),
    ]);

    ok(res, { message: 'Deleted.' });

    try {
      const adminDeleteHTML = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h1 style="color: #d32f2f; margin-top: 0;">⚠️ Account Deletion Notice</h1>
            <p style="color: #333; font-size: 16px;">Hello Dear <strong>${escapeHtml(displayName(user))}</strong>,</p>
            <p style="color: #666;">We've decided that your account should be deleted.</p>
            <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #f44336;">
              <p style="margin: 0; color: #c62828; font-weight: bold;">Reason for Deletion</p>
              <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">${escapeHtml(reason)}</p>
            </div>
            <p style="color: #666; font-size: 14px;">All your data has been permanently removed from our system.</p>
            <p style="color: #666; font-size: 14px; margin-top: 20px;">We are sorry to see you go. If you have any questions, please contact our support team.</p>
            <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
          </div>
        </div>
      `;
      await sendMail(
        user.email,
        'Account deleted - AlertUp',
        `Hello Dear ${displayName(user)} we've decided that your account should be deleted. reason:${reason}. we are sorry goodbye.`,
        undefined,
        adminDeleteHTML
      );
    } catch (err) {
      console.error('MAIL ERROR:', err);
    }
  } catch (err) {
    console.error('Admin user delete error:', err);
    if (!res.headersSent) return fail(res, 500, 'Server error.');
  }
});

router.put('/api/admin/user/:id', isAdmin, async (req, res) => {
  const userID = req.params.id;
  const { name, lastname, company, country, countryCode, phoneNumber, verified } = req.body;

  try {
    if (!userID || !isId(userID)) {
      return fail(res, 400, 'Invalid user ID.');
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (lastname !== undefined) updates.lastname = lastname;
    if (company !== undefined) updates.company = company;
    if (country !== undefined) updates.country = country;
    if (countryCode !== undefined) updates.countryCode = countryCode;
    if (phoneNumber !== undefined) updates.phone = phoneNumber;
    if (verified !== undefined) updates.verified = verified;
    // Plan changes are an ADMIN-ONLY write: no user-facing endpoint accepts
    // this field, so a tampered client cannot upgrade itself. This is the one
    // legitimate path (used after a payment lands).
    if (plan !== undefined) {
      if (!['FREE', 'STARTER', 'BUSINESS'].includes(plan)) {
        return fail(res, 422, 'plan must be FREE, STARTER or BUSINESS.');
      }
      updates.plan = plan;
    }

    const result = await prisma.user.updateMany({
      where: { id: userID },
      data: updates,
    });

    if (result.count === 0) {
      return fail(res, 404, 'User not found.');
    }

    return ok(res, { message: 'Updated.' });
  } catch (err) {
    console.error('Admin user update error:', err);
    return fail(res, 500, 'Server error.');
  }
});

// ########################################### BUILDINGS SECTION ###########################################

router.get('/api/admin/buildings', isAdmin, async (req, res) => {
  try {
    let { q = '', page = 1, limit = 20 } = req.query;

    page = Math.max(parseInt(page) || 1, 1);
    limit = Math.min(parseInt(limit) || 20, 100);

    const term = searchTerm(q);
    const where = term ? { name: { contains: term, mode: 'insensitive' } } : {};

    const [buildings, total] = await Promise.all([
      prisma.building.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { floors: { orderBy: { floorNumber: 'asc' } } },
      }),
      prisma.building.count({ where }),
    ]);

    return ok(res, {
      data: {
        buildings: buildings.map((b) => legacyBuilding(b, b.floors)),
        page,
        totalPages: Math.ceil(total / limit),
        totalUsers: total,
      },
    });
  } catch (err) {
    console.error('Admin buildings list error:', err);
    return fail(res, 500, 'Server error.');
  }
});

router.get('/api/admin/buildings/:id', isAdmin, async (req, res) => {
  const buildingID = req.params.id;

  try {
    if (!buildingID || !isId(buildingID)) {
      return fail(res, 400, 'Invalid building id.');
    }

    const building = await prisma.building.findUnique({
      where: { id: buildingID },
      include: { floors: { orderBy: { floorNumber: 'asc' } } },
    });

    if (!building) {
      return fail(res, 404, 'Building not found.');
    }

    return ok(res, { data: legacyBuilding(building, building.floors) });
  } catch (err) {
    console.error('Admin building fetch error:', err);
    return fail(res, 500, 'Server error.');
  }
});

router.delete('/api/admin/buildings/:id', isAdmin, async (req, res) => {
  const buildingID = req.params.id;

  try {
    if (!buildingID || !isId(buildingID)) {
      return fail(res, 400, 'Invalid building id.');
    }

    // Behavior change vs. Mongo: this delete now CASCADES — floors, nodes,
    // edges, roles, members, invites, logs, emergencies and scan events are
    // removed with the building. The old version deleted only the building
    // document and left all of that orphaned.
    const result = await prisma.building.deleteMany({ where: { id: buildingID } });

    if (result.count === 0) {
      return fail(res, 404, 'Building not found.');
    }

    return ok(res, { message: 'Deleted.' });
  } catch (err) {
    console.error('Admin delete building error:', err);
    return fail(res, 500, 'Server error.');
  }
});

// ########################################### REPORTS SECTION ###########################################

router.get('/api/admin/reports', isAdmin, async (req, res) => {
  try {
    const reports = await prisma.report.findMany({ orderBy: { createdAt: 'desc' } });

    return ok(res, { data: reports });
  } catch (err) {
    console.error('Admin reports list error:', err);
    return fail(res, 500, 'Server error.');
  }
});

router.delete('/api/admin/reports/:id', isAdmin, async (req, res) => {
  const reportID = req.params.id;

  try {
    if (!reportID || !isId(reportID)) {
      return fail(res, 400, 'Invalid report ID.');
    }

    const result = await prisma.report.deleteMany({ where: { id: reportID } });
    if (result.count === 0) {
      return fail(res, 404, 'Report not found.');
    }

    return ok(res, { message: 'Deleted.' });
  } catch (err) {
    console.error('Admin report delete error:', err);
    return fail(res, 500, 'Server error.');
  }
});

// ########################################### CONTACTS SECTION ###########################################

router.get('/api/admin/contacts', isAdmin, async (req, res) => {
  try {
    const contacts = await prisma.contact.findMany({ orderBy: { createdAt: 'desc' } });

    return ok(res, { data: contacts });
  } catch (err) {
    console.error('Admin contacts list error:', err);
    return fail(res, 500, 'Server error.');
  }
});

router.delete('/api/admin/contacts/:id', isAdmin, async (req, res) => {
  const contactID = req.params.id;

  try {
    if (!contactID || !isId(contactID)) {
      return fail(res, 400, 'Invalid contact ID.');
    }

    const result = await prisma.contact.deleteMany({ where: { id: contactID } });
    if (result.count === 0) {
      return fail(res, 404, 'Contact not found.');
    }

    return ok(res, { message: 'Deleted.' });
  } catch (err) {
    console.error('Admin contact delete error:', err);
    return fail(res, 500, 'Server error.');
  }
});

export default router;
