require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(derived, Buffer.from(hash, 'hex'));
  } catch (err) {
    return false;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection pool. Used for the member store (deposit/withdraw/settings).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Initialize the database schema on startup.
async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL not set; PostgreSQL member store disabled.');
    return;
  }
  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS members (
          email TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          password TEXT NOT NULL,
          account_number TEXT,
          balance NUMERIC(14,2) NOT NULL DEFAULT 0,
          is_demo BOOLEAN NOT NULL DEFAULT FALSE,
          frozen BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          phone TEXT,
          email_notifications BOOLEAN NOT NULL DEFAULT TRUE,
          sms_notifications BOOLEAN NOT NULL DEFAULT FALSE
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS member_transactions (
          id SERIAL PRIMARY KEY,
          member_email TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
          type TEXT NOT NULL,
          amount NUMERIC(14,2) NOT NULL,
          description TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      console.log('PostgreSQL schema initialized.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('PostgreSQL init failed (member store disabled):', err.message);
  }
}

app.use(cors());
app.use(express.json({ limit: '16kb' }));

// Serve the frontend (index.html, style.css) from this directory
app.use(express.static(__dirname, { cacheControl: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); } }));

// Health check so Render (and you) can confirm the service is awake
// without triggering an email send.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mailConfigured: Boolean(process.env.GMAIL_USER?.trim() && process.env.GMAIL_APP_PASSWORD?.trim())
  });
});

// Gmail SMTP transporter using your Google App Password.
// Created lazily so the server still boots (and serves the page) when
// credentials are missing — email calls then fail with a clear 503.
function getTransporter() {
  const user = (process.env.GMAIL_USER || '').trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) return null;
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

app.post('/api/send-email', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Expected a JSON object' });
    }

    const { to, subject, body } = req.body;

    if (!to || typeof subject !== 'string' || !subject.trim() ||
        typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, body' });
    }
    // Accept a single address or a small list (desk + member inbox).
    if (typeof to !== 'string' && !Array.isArray(to)) {
      return res.status(400).json({ error: 'Recipients must be an email address or list of addresses' });
    }
    const recipients = Array.isArray(to) ? to : to.split(',');
    const clean = [...new Set(recipients.filter(r => typeof r === 'string').map(r => r.trim()).filter(isEmail))].slice(0, 5);
    if (!clean.length) {
      return res.status(400).json({ error: 'No valid recipient email address' });
    }
    if (subject.length > 200 || body.length > 10000) {
      return res.status(400).json({ error: 'Subject or body too long' });
    }

    const transporter = getTransporter();
    if (!transporter) {
      return res.status(503).json({ error: 'Email service not configured (missing GMAIL_USER / GMAIL_APP_PASSWORD)' });
    }

    const info = await transporter.sendMail({
      from: `"${(process.env.SENDER_NAME || 'Capital Asset Credit Union').trim()}" <${process.env.GMAIL_USER.trim()}>`,
      to: clean.join(', '),
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>'),
    });

    console.log(`Email sent: ${info.messageId} to ${clean.join(', ')}`);
    res.json({ success: true, messageId: info.messageId, deliveredTo: clean });
  } catch (err) {
    console.error('Email send failed:', err.message);
    res.status(500).json({ error: 'Failed to send email', detail: err.message });
  }
});

function adminConfigured() {
  return Boolean(process.env.ADMIN_USERNAME?.trim() && process.env.ADMIN_PASSWORD?.trim());
}

// Report whether administrator credentials are configured via ADMIN_USERNAME /
// ADMIN_PASSWORD environment variables, so the frontend can show/hide the
// administrator entry point accordingly.
app.get('/api/admin/configured', (_req, res) => {
  res.json({ configured: adminConfigured() });
});

// Validate administrator credentials against the server environment variables.
// Credentials are never sent to the browser; this endpoint only returns success
// or failure so the client can gate the administrator console UI.
app.post('/api/admin/login', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Expected a JSON object' });
    }
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (!adminConfigured()) {
      return res.status(503).json({ error: 'Administrator login is not configured on the server' });
    }
    const expectedUser = Buffer.from(process.env.ADMIN_USERNAME.trim().toLowerCase());
    const expectedPass = Buffer.from(process.env.ADMIN_PASSWORD.trim());
    const givenUser = Buffer.from(username.trim().toLowerCase());
    const givenPass = Buffer.from(password);
    if (givenUser.length !== expectedUser.length || givenPass.length !== expectedPass.length) {
      return res.status(401).json({ error: 'Invalid administrator credentials' });
    }
    const userOk = crypto.timingSafeEqual(givenUser, expectedUser);
    const passOk = crypto.timingSafeEqual(givenPass, expectedPass);
    if (!(userOk && passOk)) {
      return res.status(401).json({ error: 'Invalid administrator credentials' });
    }
    res.json({ ok: true, token: createAdminToken(username) });
  } catch (err) {
    console.error('Admin login failed:', err.message);
    res.status(500).json({ error: 'Administrator login failed' });
  }
});

const STORE_DIR = path.join(__dirname, 'data');
const MEMBERS_FILE = path.join(STORE_DIR, 'members.json');

function ensureStoreDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

async function loadMembers() {
  if (!process.env.DATABASE_URL) return [];
  let client;
  try {
    client = await pool.connect();
    const res = await client.query('SELECT * FROM members ORDER BY created_at');
    const members = res.rows.map((row) => ({
      name: row.name,
      email: row.email,
      password: row.password,
      accountNumber: row.account_number,
      balance: parseFloat(row.balance),
      isDemo: row.is_demo,
      frozen: row.frozen,
      createdAt: row.created_at,
      phone: row.phone,
      emailNotifications: row.email_notifications,
      smsNotifications: row.sms_notifications,
      transactions: [],
    }));
    for (const m of members) {
      const txRes = await client.query(
        'SELECT type, amount, description, created_at FROM member_transactions WHERE member_email = $1 ORDER BY created_at',
        [m.email]
      );
      m.transactions = txRes.rows.map((tx) => ({
        type: tx.type,
        amount: parseFloat(tx.amount),
        description: tx.description,
        date: tx.created_at,
      }));
    }
    return members;
  } catch (err) {
    console.error('loadMembers failed:', err.message);
    return [];
  } finally {
    if (client) client.release();
  }
}

async function persistMembers(members) {
  if (!process.env.DATABASE_URL) return;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    for (const m of members) {
      await client.query(
        `INSERT INTO members (email, name, password, account_number, balance, is_demo, frozen, created_at, phone, email_notifications, sms_notifications)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (email) DO UPDATE SET
           name = EXCLUDED.name,
           password = EXCLUDED.password,
           account_number = EXCLUDED.account_number,
           balance = EXCLUDED.balance,
           is_demo = EXCLUDED.is_demo,
           frozen = EXCLUDED.frozen,
           phone = EXCLUDED.phone,
           email_notifications = EXCLUDED.email_notifications,
           sms_notifications = EXCLUDED.sms_notifications`,
        [
          m.email, m.name, m.password, m.accountNumber, m.balance, m.isDemo || false,
          m.frozen || false, m.createdAt || new Date().toISOString(), m.phone || '',
          m.emailNotifications !== false, m.smsNotifications === true,
        ]
      );
      await client.query('DELETE FROM member_transactions WHERE member_email = $1', [m.email]);
      if (Array.isArray(m.transactions)) {
        for (const tx of m.transactions) {
          await client.query(
            'INSERT INTO member_transactions (member_email, type, amount, description, created_at) VALUES ($1,$2,$3,$4,$5)',
            [m.email, tx.type, tx.amount, tx.description, tx.date || new Date().toISOString()]
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('persistMembers failed:', err.message);
  } finally {
    if (client) client.release();
  }
}

async function deleteMemberFromDb(email) {
  if (!process.env.DATABASE_URL) return;
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM members WHERE email = $1', [email]);
  } finally {
    client.release();
  }
}

function roundMoney(value) {
  const num = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
}

const ACCOUNT_NUMBER_RE = /^[0-9]{10}$/;

function isAccountNumber(value) {
  return typeof value === 'string' && ACCOUNT_NUMBER_RE.test(value);
}

function createAccountNumber(taken) {
  const takenSet = new Set(Array.from(taken || []).map((n) => String(n)));
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const num = String(1000000000 + Math.floor(Math.random() * 9000000000));
    if (!takenSet.has(num)) return num;
  }
  return `${Date.now()}`.slice(-10).padStart(10, '1');
}

function decodeEmailParam(value) {
  try {
    return decodeURIComponent(String(value));
  } catch (err) {
    return String(value);
  }
}

function createAdminToken(username) {
  const exp = Date.now() + 30 * 60 * 1000;
  const data = JSON.stringify({ u: username, exp });
  const payload = Buffer.from(data).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update(payload).digest('base64url');
  return `Bearer ${payload}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token) return null;
  try {
    const raw = typeof token === 'string' ? token : token.auth;
    const part = raw.replace(/^Bearer\s+/i, '');
    const pieces = part.split('.');
    if (pieces.length !== 2) return null;
    const [payload, sig] = pieces;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const { u: username, exp } = decoded;
    const expected = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update(payload).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    if (!username || !exp || Date.now() > exp) return null;
    return { username };
  } catch (err) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const user = verifyAdminToken(req.headers.authorization || '');
  if (!user) {
    return res.status(401).json({ error: 'Administrator authentication is required for this action.' });
  }
  req.adminUser = user.username;
  next();
}

app.get('/api/admin/members', requireAdmin, async (req, res) => {
  res.json({ members: await loadMembers() });
});

app.post('/api/admin/members', requireAdmin, async (req, res) => {
  const { name, email, password, accountNumber, balance, phone } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields: name, email, password' });
  }
  const emailLower = String(email).trim().toLowerCase();
  const members = await loadMembers();
  if (members.some((u) => u.email.toLowerCase() === emailLower)) {
    return res.status(409).json({ error: 'A member with this email already exists.' });
  }
  const takenNumbers = new Set((members || []).map((u) => u.accountNumber).filter(isAccountNumber));
  const created = {
    name: String(name).trim(),
    email: emailLower,
    password: String(password),
    accountNumber: createAccountNumber(takenNumbers),
    balance: roundMoney(balance || 0),
    isDemo: false,
    frozen: false,
    createdAt: new Date().toISOString(),
    transactions: [],
    phone: String(phone || '').trim(),
    emailNotifications: true,
    smsNotifications: false,
  };
  members.push(created);
  await persistMembers(members);
  res.status(201).json({ member: created });
});

app.post('/api/admin/members/:email/freeze', requireAdmin, async (req, res) => {
  const email = decodeEmailParam(req.params.email);
  const members = await loadMembers();
  const user = members.find((u) => u.email.toLowerCase() === email);
  if (!user) return res.status(404).json({ error: 'Member not found.' });
  user.frozen = !user.frozen;
  await persistMembers(members);
  res.json({ member: user, frozen: user.frozen });
});

app.post('/api/admin/members/:email/debit', requireAdmin, async (req, res) => {
  const email = decodeEmailParam(req.params.email);
  const members = await loadMembers();
  const user = members.find((u) => u.email.toLowerCase() === email);
  if (!user) return res.status(404).json({ error: 'Member not found.' });
  if (req.body == null || typeof req.body.amount !== 'number') {
    return res.status(400).json({ error: 'Missing required field: amount' });
  }
  const amount = Math.abs(roundMoney(req.body.amount));
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });
  if (amount > user.balance) return res.status(400).json({ error: 'Insufficient balance.' });
  user.balance = roundMoney(user.balance - amount);
  if (!Array.isArray(user.transactions)) user.transactions = [];
  user.transactions.push({
    type: 'withdraw',
    amount,
    description: 'Administrative debit',
    date: new Date().toISOString(),
  });
  await persistMembers(members);
  res.json({ member: user, balance: user.balance });
});

app.post('/api/admin/members/:email/credit', requireAdmin, async (req, res) => {
  const email = decodeEmailParam(req.params.email);
  const members = await loadMembers();
  const user = members.find((u) => u.email.toLowerCase() === email);
  if (!user) return res.status(404).json({ error: 'Member not found.' });
  if (req.body == null || typeof req.body.amount !== 'number') {
    return res.status(400).json({ error: 'Missing required field: amount' });
  }
  const amount = Math.abs(roundMoney(req.body.amount));
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });
  user.balance = roundMoney(user.balance + amount);
  if (!Array.isArray(user.transactions)) user.transactions = [];
  user.transactions.push({
    type: 'deposit',
    amount,
    description: 'Administrative credit',
    date: new Date().toISOString(),
  });
  await persistMembers(members);
  res.json({ member: user, balance: user.balance });
});

app.post('/api/admin/members/:email/reset', requireAdmin, async (req, res) => {
  const email = decodeEmailParam(req.params.email);
  const members = await loadMembers();
  const user = members.find((u) => u.email.toLowerCase() === email);
  if (!user) return res.status(404).json({ error: 'Member not found.' });
  user.transactions = [];
  user.balance = 0;
  await persistMembers(members);
  res.json({ member: user, balance: 0 });
});

app.post('/api/admin/members/:email/delete', requireAdmin, async (req, res) => {
  const email = decodeEmailParam(req.params.email);
  const members = await loadMembers();
  const idx = members.findIndex((u) => u.email.toLowerCase() === email);
  if (idx === -1) return res.status(404).json({ error: 'Member not found.' });
  members.splice(idx, 1);
  await persistMembers(members);
  res.json({ ok: true });
});

// ---- Public member endpoints (registration + login) ----------------------

// Register a new member account (public). The client sends the full member
// record (including seeded transaction history) so the server can persist it.
app.post('/api/members/register', async (req, res) => {
  const { name, email, password, accountNumber, balance, transactions, phone } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields: name, email, password' });
  }
  const emailLower = String(email).trim().toLowerCase();
  const members = await loadMembers();
  if (members.some((u) => u.email.toLowerCase() === emailLower)) {
    return res.status(409).json({ error: 'A member with this email already exists.' });
  }
  const takenNumbers = new Set((members || []).map((u) => u.accountNumber).filter(isAccountNumber));
  const created = {
    name: String(name).trim(),
    email: emailLower,
    password: String(password),
    accountNumber: accountNumber && isAccountNumber(accountNumber) ? accountNumber : createAccountNumber(takenNumbers),
    balance: roundMoney(balance || 0),
    isDemo: false,
    frozen: false,
    createdAt: new Date().toISOString(),
    transactions: Array.isArray(transactions) ? transactions : [],
    phone: String(phone || '').trim(),
    emailNotifications: true,
    smsNotifications: false,
  };
  members.push(created);
  await persistMembers(members);
  res.status(201).json({ member: created });
});

// Login a member (public). Verifies credentials and returns the member.
app.post('/api/members/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const emailLower = String(email).trim().toLowerCase();
  const members = await loadMembers();
  const user = members.find((u) => u.email.toLowerCase() === emailLower);
  if (!user || user.password !== String(password)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (user.frozen) {
    return res.status(403).json({ error: 'This account is frozen. Please contact customer care.' });
  }
  res.json({ ok: true, member: user });
});

// ---- Member banking endpoints (deposit/withdraw/settings) ----------------

// GET /api/members/:email — fetch a member's record (used by the member dashboard).
app.get('/api/members/:email', async (req, res) => {
  const email = decodeEmailParam(req.params.email);
  const members = await loadMembers();
  const user = members.find((u) => u.email.toLowerCase() === email);
  if (!user) return res.status(404).json({ error: 'Member not found.' });
  res.json({ member: user });
});

// POST /api/members/:email/deposit — credit the member's account.
app.post('/api/members/:email/deposit', async (req, res) => {
  const email = decodeEmailParam(req.params.email);
  const members = await loadMembers();
  const user = members.find((u) => u.email.toLowerCase() === email);
  if (!user) return res.status(404).json({ error: 'Member not found.' });
  if (user.frozen) return res.status(403).json({ error: 'This account is frozen.' });
  if (req.body == null || typeof req.body.amount !== 'number') {
    return res.status(400).json({ error: 'Missing required field: amount' });
  }
  const amount = Math.abs(roundMoney(req.body.amount));
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });
  const min = 1000;
  if (amount < min) return res.status(400).json({ error: `Minimum deposit is $${min}.` });
  const feeRate = 0.05;
  const fee = roundMoney(amount * feeRate);
  const credit = roundMoney(amount - fee);
  user.balance = roundMoney(user.balance + credit);
  if (!Array.isArray(user.transactions)) user.transactions = [];
  user.transactions.push({
    type: 'deposit',
    amount: credit,
    fee,
    description: req.body.description || 'International transfer',
    date: new Date().toISOString(),
  });
  await persistMembers(members);
  res.json({ member: user, balance: user.balance, fee, credited: credit });
});

// POST /api/members/:email/withdraw — debit the member's account.
app.post('/api/members/:email/withdraw', async (req, res) => {
  const email = decodeEmailParam(req.params.email);
  const members = await loadMembers();
  const user = members.find((u) => u.email.toLowerCase() === email);
  if (!user) return res.status(404).json({ error: 'Member not found.' });
  if (user.frozen) return res.status(403).json({ error: 'This account is frozen.' });
  if (req.body == null || typeof req.body.amount !== 'number') {
    return res.status(400).json({ error: 'Missing required field: amount' });
  }
  const amount = Math.abs(roundMoney(req.body.amount));
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });
  if (amount > user.balance) return res.status(400).json({ error: 'Insufficient balance.' });
  user.balance = roundMoney(user.balance - amount);
  if (!Array.isArray(user.transactions)) user.transactions = [];
  user.transactions.push({
    type: 'withdraw',
    amount,
    description: req.body.description || 'Transfer to bank',
    date: new Date().toISOString(),
  });
  await persistMembers(members);
  res.json({ member: user, balance: user.balance });
});

// PUT /api/members/:email/settings — update member notification settings.
app.put('/api/members/:email/settings', async (req, res) => {
  const email = decodeEmailParam(req.params.email);
  const members = await loadMembers();
  const user = members.find((u) => u.email.toLowerCase() === email);
  if (!user) return res.status(404).json({ error: 'Member not found.' });
  const { emailNotifications, smsNotifications, phone } = req.body || {};
  if (typeof emailNotifications === 'boolean') user.emailNotifications = emailNotifications;
  if (typeof smsNotifications === 'boolean') user.smsNotifications = smsNotifications;
  if (typeof phone === 'string') user.phone = phone.trim();
  await persistMembers(members);
  res.json({ member: user });
});

// Expose non-secret configuration to the frontend (notification recipient, etc.).
app.get('/api/config', (req, res) => {
  res.json({
    notificationEmail: (process.env.APPLICATION_EMAIL || 'capitalassetscreditunions@gmail.com').trim(),
    senderName: (process.env.SENDER_NAME || 'Capital Asset Credit Union').trim(),
  });
});
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, 'body')) {
    return res.status(400).json({ error: 'Invalid JSON request body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  next(err);
});

(async () => {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Capital Asset notification server running on http://localhost:${PORT}`);
  });
})();
