# Deploying Capital Asset CU to Render

This project is one Node/Express app: it serves `index.html` + `style.css`
and exposes `POST /api/send-email` (Gmail SMTP via Nodemailer).
Render runs it with a single Web Service — no separate frontend hosting needed.

## 1. Prerequisites

- A GitHub (or GitLab) account with this folder pushed as a repository.
  Commit `index.html`, `style.css`, `server.js`, `package.json`, and this file.
  **Do NOT commit `.env`** — it is gitignored; secrets go in Render's dashboard.
- A Google account with **2-Step Verification ON**, and a **16-character
  App Password** for Mail
  (Google Account → Security → 2-Step Verification → App passwords → Mail).
  Note: your existing app password may contain spaces when Google shows it —
  enter it **without spaces**.

## 2. Push to GitHub

```bash
cd c:\Users\Phemcode\Downloads\Compressed\Capital-Asset-main\Capital-Asset-main
git init
git add index.html style.css server.js package.json setup.md .gitignore
git commit -m "Capital Asset CU dashboard"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

(If the repo already exists, just `git add/commit/push` as normal.)

## 3. Create the Web Service on Render

1. Go to https://dashboard.render.com → **New +** → **Web Service**.
2. Connect your Git provider and select the repo above.
3. Fill in these settings:

   | Setting           | Value              |
   |-------------------|--------------------|
   | Name              | `capital-asset-cu` (or anything) |
   | Region            | closest to you     |
   | Branch            | `main`             |
   | Runtime           | `Node`             |
   | Build Command     | `npm install`      |
   | Start Command     | `npm start`        |
   | Instance Type     | `Free`             |

4. The project already reads `process.env.PORT`, which is how Render assigns
   the port — no code change needed.

## 4. Add environment variables

On the service page go to **Environment** → **Add Environment Variable**
(or **Environment Variables** section) and add:

| Key                | Value                                      |
|--------------------|--------------------------------------------|
| `GMAIL_USER`         | `datainfodeskdata@gmail.com`               |
| `GMAIL_APP_PASSWORD` | your 16-character app password, no spaces |
| `NODE_VERSION`       | `20` (keeps the runtime pinned)            |

Do **not** set `PORT` — Render injects it automatically.

Click **Save Changes** (this triggers a redeploy).

## 5. Verify

1. Wait for the deploy log to show:
   `Capital Asset notification server running on http://localhost:<PORT>`
   (Render overrides the port; the message text still says localhost
   but the app is live.)
2. Open the **service URL** Render gives you
   (e.g. `https://capital-asset-cu.onrender.com`).
3. Log in and run a deposit/withdrawal/trade with email notifications on —
   the confirmation should arrive at `datainfodeskdata@gmail.com`.

## 6. Local development (unchanged)

```bash
npm install
npm start        # http://localhost:3000
```

Local secrets live in `.env` (gitignored):

```
GMAIL_USER=datainfodeskdata@gmail.com
GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx   # no spaces
PORT=3000
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Page loads but emails fail with an auth error in Render logs | App password wrong/expired or contains spaces — regenerate at Google Account → Security → App passwords and update `GMAIL_APP_PASSWORD`, then redeploy. Also confirm 2-Step Verification is on for the Gmail account. |
| `Missing required fields: to, subject, body` (400) | Frontend/ backend mismatch — redeploy so both come from the same commit. |
| Service sleeps / first load is slow | Normal on Render Free tier: the service spins down after ~15 min idle and wakes on the next visit (can take ~30–60 s). |
| Deploy fails on `npm install` | Check the build log; usually fixed by confirming `package.json` lists `express`, `cors`, `dotenv`, `nodemailer` (it does) and `NODE_VERSION=20` is set. |
| Login/demo data missing after redeploy | Expected: accounts live in the **browser's** localStorage, not on the server. Each visitor's data stays on their own device. Seed logins: `rick.carl@gmail.com` / `carl123`, admin `admin` / `admin456`. |
