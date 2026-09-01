# Yatra Clubbing — Backend (Express + MongoDB)

REST API for the Yatra Clubbing app. Hosted on **Railway**. The Next.js frontend (on Vercel) calls this API via `NEXT_PUBLIC_API_URL`.

## Architecture

- **Backend (this repo):** Express + MongoDB + Razorpay + Cloudinary + Flaxxa (WhatsApp). All `app/api/*` logic that used to live in the Next.js app now lives here.
- **Frontend (Vercel):** Next.js, UI only. Every API call goes to `NEXT_PUBLIC_API_URL`.
- **Event identifier:** events use a short public **code** (e.g. `RC26`) as the canonical API/URL identifier. A legacy `slug` is kept as an optional alias for backward compatibility.

## Run locally

```bash
npm install
# create .env from .env.example and fill in values
npm run dev        # http://localhost:3000
```

Health check: `GET /health`

## API routes

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/public/event` | public | Active public event (landing page) |
| `POST /api/register` | public | Save/update a booking (upsert by `ref`) |
| `POST /api/create-order` | public | Create a Razorpay order |
| `POST /api/verify-payment` | public | Verify Razorpay signature |
| `POST /api/whatsapp` | public | Send booking-confirmation WhatsApp (Flaxxa) |
| `POST /api/webhook/razorpay` | public (signature) | Razorpay webhook → mark paid + WhatsApp |
| `GET/POST/PUT/DELETE /api/events` | admin | Event CRUD (keyed by `code` or `slug`) |
| `POST /api/events/:id/status` | admin | Set event status |
| `GET/DELETE /api/registrations` | admin | List/delete registrations |
| `POST /api/verify-student` | admin | Approve/reject student ID + WhatsApp |
| `POST /api/admin/login` / `logout` | — | Admin token session |
| `GET/POST /api/admin/refund-all` | admin | Bulk refunds |
| `GET /api/admin/refund-audit` | admin | Razorpay reconciliation audit |
| `POST /api/admin/refund-manual` | admin | Refund by payment ID |

**Admin auth:** the `ADMIN_TOKEN` is posted to `/api/admin/login`, which returns `{ ok, token }`. The frontend stores it and sends it as `Authorization: Bearer <token>` on every admin call. (The backend also sets an optional `yc_admin_token` cookie.)

## Deploy to Railway

1. Create a new Railway project and a new service from this repo (or a connected GitHub repo).
2. Set the following **variables** (Railway → service → Variables):
   - `PORT` = `3000` (Railway usually injects this; keep the default `3000`)
   - `MONGODB_URI` = `mongodb+srv://<user>:<password>@cluster0.f6wu1ck.mongodb.net/?appName=Cluster0`
   - `MONGODB_DB` = `yatra`
   - `ADMIN_TOKEN` = a strong secret token
   - `FRONTEND_URL` = `https://<your-app>.vercel.app` (comma-separated if multiple)
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
   - `FLAXXA_API_URL`, `FLAXXA_TOKEN`
3. Deploy. Railway runs `npm start` (`node src/index.js`).
4. Copy the service's public URL, e.g. `https://yatra-backend.up.railway.app`.

## Razorpay webhook

In the Razorpay Dashboard → Settings → Webhooks, point it to:

```
https://yatra-backend.up.railway.app/api/webhook/razorpay
```

with secret = your `RAZORPAY_WEBHOOK_SECRET`. Enable at least the **`payment.captured`** event (and `order.paid`).

## Vercel (frontend) setup

Set only ONE variable in the Vercel project:

- `NEXT_PUBLIC_API_URL` = `https://yatra-backend.up.railway.app`

All sensitive backend vars (`MONGODB_URI`, `ADMIN_TOKEN`, `RAZORPAY_*`, `CLOUDINARY_*`, `FLAXXA_*`) are **no longer needed** on the frontend — they moved to the backend.

> ⚠️ Security: the Mongo credentials were shared during setup. Consider rotating the database password in Atlas after go-live. Never commit `.env` or credentials. The `mongodb+srv://` SRV string resolves fine on Railway/Vercel (a local `querySrv ECONNREFUSED` is a sandbox DNS quirk only).
