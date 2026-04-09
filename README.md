# 🚨 AlertUp — Backend

REST API for AlertUp — a real-time alert and notification platform. Handles user management, alert creation, delivery logic, and push/email notifications.

> ✍️ Built at **age 15** (2025-2026)

---

## Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB
- **Auth:** JWT
- **Notifications:** Nodemailer / Web Push

---

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/auth/register` | Register new user |
| `POST` | `/api/auth/login` | Login and receive JWT |
| `GET` | `/api/alerts` | Get all alerts for user |
| `POST` | `/api/alerts` | Create a new alert |
| `DELETE` | `/api/alerts/:id` | Delete an alert |

---

## Run Locally

```bash
git clone https://github.com/aponchikaj/alertup_backend
cd alertup_backend
npm install
cp .env.example .env
npm run dev
```

---

## Environment Variables

```env
PORT=5000
MONGO_URI=your_mongo_connection
JWT_SECRET=your_secret
EMAIL_USER=your_email
EMAIL_PASS=your_email_password
```

---

## Related

Frontend: [alertup_front](https://github.com/aponchikaj/alertup_front)

---

> 🇬🇪 Built in Tbilisi, Georgia by [Lazare Mirziashvili](https://github.com/aponchikaj)
