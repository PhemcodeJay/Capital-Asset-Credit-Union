require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types } = require('pg');
const express = require('express');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const APPLICATION_EMAIL = (process.env.APPLICATION_EMAIL || 'capitalassetscreditunions@gmail.com').trim();
const PASSWORD_MIN_LENGTH = 12;
const ADMIN_PASSWORD_MIN_LENGTH = 14;
const SESSION_COOKIE = IS_PRODUCTION ? '__Host-capital_asset_session' : 'capital_asset_session';
const SESSION_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;
const SHORT_SESSION_LENGTH_MS = 12 * 60 * 60 * 1000;
const DEPOSIT_MIN_CENTS = 100000;
const DEPOSIT_FEE_BPS = 500;
const INVESTMENT_FEE_BPS = 75;
const MAX_AMOUNT_CENTS = 10000000000;
const scrypt = promisify(crypto.scrypt);
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || IS_PRODUCTION;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must contain the PostgreSQL connection string.');
}
if (TRUST_PROXY) app.set('trust proxy', 1);

types.setTypeParser(20, value => Number(value));
const transactionContext = new AsyncLocalStorage();
function configurePool(poolInstance) {
  poolInstance.on('error', () => console.error('Unexpected PostgreSQL pool error.'));
  return poolInstance;
}
let pool = configurePool(new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 10000
}));

function parameterize(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function query(sql, params = []) {
  const client = transactionContext.getStore();
  return (client || pool).query(parameterize(sql), params);
}

const db = {
  exec(sql) {
    return query(sql);
  },
  prepare(sql) {
    return {
      async get(...params) {
        const result = await query(sql, params);
        return result.rows[0];
      },
      async all(...params) {
        const result = await query(sql, params);
        return result.rows;
      },
      async run(...params) {
        const result = await query(sql, params);
        return { changes: result.rowCount };
      }
    };
  },
  async close() {
    await pool.end();
  }
};

async function initializeDatabase() {
  await db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    account_number TEXT NOT NULL UNIQUE,
    balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    frozen SMALLINT NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1)),
    created_at TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    email_notifications SMALLINT NOT NULL DEFAULT 1 CHECK (email_notifications IN (0, 1)),
    sms_notifications SMALLINT NOT NULL DEFAULT 0 CHECK (sms_notifications IN (0, 1)),
    holdings_json TEXT NOT NULL DEFAULT '[]',
    accepted_policies_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('deposit', 'withdraw')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    description TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transactions_user_date ON transactions(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'investment_buy', 'investment_sell')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS requests_status_date ON requests(status, created_at);
  CREATE INDEX IF NOT EXISTS requests_user_date ON requests(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS admins (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('member', 'admin')),
    actor_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS admin_audit (
    id TEXT PRIMARY KEY,
    admin_username TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
`);
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  if (req.path === '/' || req.path === '/index.html') {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.json({ limit: '12kb', strict: true }));

function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().replace(/[\r\n\0]/g, ' ').slice(0, maxLength) : '';
}

function parseCents(value, { allowZero = false } = {}) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount > MAX_AMOUNT_CENTS / 100 || (!allowZero && amount <= 0)) return null;
  return Math.round(amount * 100);
}

function money(cents) {
  return cents / 100;
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function accountNumber() {
  return String(1000000000 + crypto.randomInt(0, 9000000000));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string') return false;
  const [algorithm, saltHex, keyHex] = encoded.split('$');
  if (algorithm !== 'scrypt' || !/^[\da-f]{32}$/.test(saltHex || '') || !/^[\da-f]{128}$/.test(keyHex || '')) {
    return false;
  }
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  return crypto.timingSafeEqual(expected, actual);
}

async function runTransaction(action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await transactionContext.run(client, action);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function userRow(id) {
  return await db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

async function serializeUser(row) {
  if (!row) return null;
  const transactions = (await db.prepare(`
    SELECT id, type, amount_cents, description, created_at
    FROM transactions WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 500
  `).all(row.id)).map(item => ({
    id: item.id,
    type: item.type,
    amount: money(item.amount_cents),
    description: item.description,
    date: item.created_at
  }));
  const pendingRequests = (await db.prepare(`
    SELECT id, type, amount_cents, description, created_at
    FROM requests WHERE user_id = ? AND status = 'pending'
    ORDER BY created_at DESC
  `).all(row.id)).map(item => ({
    id: item.id,
    type: item.type,
    amount: money(item.amount_cents),
    description: item.description,
    createdAt: item.created_at
  }));
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    accountNumber: row.account_number,
    balance: money(row.balance_cents),
    frozen: row.frozen === 1,
    createdAt: row.created_at,
    phone: row.phone,
    emailNotifications: row.email_notifications === 1,
    smsNotifications: row.sms_notifications === 1,
    holdings: safeJson(row.holdings_json, []),
    acceptedPolicies: safeJson(row.accepted_policies_json, []),
    transactions,
    pendingRequests
  };
}

function serializeAdminCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    accountNumber: row.account_number,
    balance: money(row.balance_cents),
    frozen: row.frozen === 1,
    createdAt: row.created_at,
    transactionCount: row.transaction_count,
    pendingRequestCount: row.pending_request_count
  };
}

function getCookie(req, name) {
  const cookieHeader = req.get('cookie') || '';
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(item.slice(separator + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

function setSessionCookie(res, token, durationMs) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict'
  ];
  if (IS_PRODUCTION) parts.push('Secure');
  if (durationMs) parts.push(`Max-Age=${Math.floor(durationMs / 1000)}`);
  res.set('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (IS_PRODUCTION) parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

async function getActor(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token || token.length > 256) return null;
  const session = await db.prepare(`
    SELECT actor_type, actor_id, expires_at FROM sessions
    WHERE token_hash = ? AND expires_at > ?
  `).get(hashToken(token), Date.now());
  if (!session) return null;
  if (session.actor_type === 'member') {
    const user = await userRow(session.actor_id);
    return user ? { type: 'member', id: user.id, user } : null;
  }
  const admin = await db.prepare('SELECT username FROM admins WHERE username = ?').get(session.actor_id);
  return admin ? { type: 'admin', id: admin.username, admin } : null;
}

function requireMember(req, res, next) {
  getActor(req).then(actor => {
    if (!actor || actor.type !== 'member') return res.status(401).json({ error: 'Sign in required.' });
    if (actor.user.frozen) return res.status(403).json({ error: 'This account is frozen.' });
    req.actor = actor;
    next();
  }).catch(next);
}

function requireAdmin(req, res, next) {
  getActor(req).then(actor => {
    if (!actor || actor.type !== 'admin') return res.status(401).json({ error: 'Administrator sign-in required.' });
    req.actor = actor;
    next();
  }).catch(next);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const rateLimits = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const now = Date.now();
    const mapKey = `${key}:${req.ip}`;
    let state = rateLimits.get(mapKey);
    if (!state || state.expiresAt <= now) {
      state = { count: 0, expiresAt: now + windowMs };
      rateLimits.set(mapKey, state);
    }
    state.count += 1;
    if (rateLimits.size > 10000) {
      for (const [entry, value] of rateLimits) {
        if (value.expiresAt <= now) rateLimits.delete(entry);
      }
    }
    if (state.count > max) {
      res.set('Retry-After', String(Math.ceil((state.expiresAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
    }
    next();
  };
}

app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  const expectedOrigin = `${req.protocol}://${req.get('host')}`;
  if (!origin || origin !== expectedOrigin) {
    return res.status(403).json({ error: 'Request origin could not be verified.' });
  }
  next();
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => res.type('text/css').sendFile(path.join(__dirname, 'style.css')));

app.get('/api/health', asyncRoute(async (req, res) => {
  await query('SELECT 1');
  res.json({
    ok: true,
    databaseConfigured: true,
    mailConfigured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && isEmail(APPLICATION_EMAIL))
  });
}));

async function createSession(res, actorType, actorId, remember) {
  const token = crypto.randomBytes(32).toString('base64url');
  const duration = remember ? SESSION_LENGTH_MS : SHORT_SESSION_LENGTH_MS;
  await db.prepare(`
    INSERT INTO sessions (token_hash, actor_type, actor_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hashToken(token), actorType, actorId, Date.now() + duration, new Date().toISOString());
  setSessionCookie(res, token, remember ? duration : null);
  return duration;
}

app.get('/api/auth/session', asyncRoute(async (req, res) => {
  const actor = await getActor(req);
  if (!actor) return res.json({ authenticated: false });
  if (actor.type === 'member') {
    return res.json({ authenticated: true, role: 'member', user: await serializeUser(actor.user) });
  }
  res.json({ authenticated: true, role: 'admin', username: actor.id });
}));

app.post('/api/auth/register', rateLimit({ windowMs: 60 * 60 * 1000, max: 8, key: 'register' }), asyncRoute(async (req, res) => {
  const name = cleanText(req.body?.name, 60);
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body?.password;
  const phone = cleanText(req.body?.phone, 20);
  if (name.length < 2 || !isEmail(email) || typeof password !== 'string' ||
      password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
    return res.status(400).json({ error: `Enter a valid name and email, and a password of at least ${PASSWORD_MIN_LENGTH} characters.` });
  }
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  let account;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      account = accountNumber();
      try {
        await db.prepare(`
          INSERT INTO users (id, name, email, password_hash, account_number, created_at, phone)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, name, email, hash, account, new Date().toISOString(), phone);
        break;
      } catch (error) {
        if (error.code === '23505' && error.constraint === 'users_account_number_key') continue;
        throw error;
      }
    }
    if (!await userRow(id)) throw new Error('Could not allocate an account number.');
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'users_email_key') {
      return res.status(409).json({ error: 'Email already registered. Try logging in.' });
    }
    throw error;
  }
  await createSession(res, 'member', id, true);
  res.status(201).json({ user: await serializeUser(await userRow(id)) });
}));

const dummyPasswordHash = hashPassword('not-a-real-account-password');

app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: 'member-login' }), asyncRoute(async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body?.password;
  if (!isEmail(email) || typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'Enter a valid email and password.' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const encoded = user ? user.password_hash : await dummyPasswordHash;
  const valid = await verifyPassword(password, encoded);
  if (!user || !valid) return res.status(401).json({ error: 'Invalid email or password.' });
  if (user.frozen) return res.status(403).json({ error: 'This account is frozen. Please contact customer care.' });
  await db.prepare('DELETE FROM sessions WHERE actor_type = ? AND actor_id = ?').run('member', user.id);
  await createSession(res, 'member', user.id, req.body?.remember === true);
  res.json({ user: await serializeUser(user) });
}));

app.post('/api/auth/admin/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: 'admin-login' }), asyncRoute(async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = req.body?.password;
  if (!username || username.length > 80 || typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'Enter the administrator username and password.' });
  }
  const admin = await db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  const valid = await verifyPassword(password, admin ? admin.password_hash : await dummyPasswordHash);
  if (!admin || !valid) return res.status(401).json({ error: 'Invalid administrator credentials.' });
  await db.prepare('DELETE FROM sessions WHERE actor_type = ? AND actor_id = ?').run('admin', admin.username);
  await createSession(res, 'admin', admin.username, true);
  res.json({ username: admin.username });
}));

app.delete('/api/auth/session', asyncRoute(async (req, res) => {
  const token = getCookie(req, SESSION_COOKIE);
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  clearSessionCookie(res);
  res.status(204).end();
}));

app.get('/api/member', requireMember, asyncRoute(async (req, res) => {
  res.json({ user: await serializeUser(await userRow(req.actor.id)) });
}));

app.patch('/api/member/profile', requireMember, asyncRoute(async (req, res) => {
  const emailNotifications = req.body?.emailNotifications;
  const smsNotifications = req.body?.smsNotifications;
  const phone = req.body?.phone;
  if (typeof emailNotifications !== 'boolean' || smsNotifications !== false ||
      typeof phone !== 'string' || phone.length > 20 || /[\r\n\0]/.test(phone)) {
    return res.status(400).json({ error: 'Invalid notification settings.' });
  }
  await db.prepare(`
    UPDATE users SET email_notifications = ?, sms_notifications = ?, phone = ?
    WHERE id = ?
  `).run(Number(emailNotifications), Number(smsNotifications), phone.trim(), req.actor.id);
  res.json({ user: await serializeUser(await userRow(req.actor.id)) });
}));

app.patch('/api/member/policies', requireMember, asyncRoute(async (req, res) => {
  const policyId = req.body?.policyId;
  const accepted = req.body?.accepted;
  if (typeof policyId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(policyId) || typeof accepted !== 'boolean') {
    return res.status(400).json({ error: 'Invalid policy acceptance.' });
  }
  const user = await userRow(req.actor.id);
  const policies = new Set(safeJson(user.accepted_policies_json, []));
  if (accepted) policies.add(policyId);
  else policies.delete(policyId);
  await db.prepare('UPDATE users SET accepted_policies_json = ? WHERE id = ?')
    .run(JSON.stringify([...policies]), req.actor.id);
  res.json({ user: await serializeUser(await userRow(req.actor.id)) });
}));

app.post('/api/member/requests', requireMember, rateLimit({
  windowMs: 60 * 60 * 1000, max: 15, key: 'member-money-request'
}), asyncRoute(async (req, res) => {
  const type = req.body?.type;
  const amountCents = parseCents(req.body?.amount);
  const allowedTypes = ['deposit', 'withdrawal', 'investment_buy', 'investment_sell'];
  if (!allowedTypes.includes(type) || amountCents === null) {
    return res.status(400).json({ error: 'Enter a valid request type and amount.' });
  }
  if (type === 'deposit' && amountCents < DEPOSIT_MIN_CENTS) {
    return res.status(400).json({ error: 'The minimum deposit request is $1,000.00.' });
  }
  const assetId = typeof req.body?.assetId === 'string' ? req.body.assetId.trim().slice(0, 60) : '';
  if (type.startsWith('investment_') && !/^[a-zA-Z0-9_-]{1,60}$/.test(assetId)) {
    return res.status(400).json({ error: 'Select a valid investment.' });
  }
  if (type === 'investment_sell') {
    return res.status(409).json({ error: 'Investment sales are unavailable until an investment execution provider is configured.' });
  }
  const reserveCents = type === 'investment_buy'
    ? amountCents + Math.round(amountCents * INVESTMENT_FEE_BPS / 10000)
    : amountCents;
  const id = crypto.randomUUID();
  const description = type.startsWith('investment_') ? `Investment request: ${assetId}` : '';
  try {
    await runTransaction(async () => {
      const user = await db.prepare('SELECT * FROM users WHERE id = ? FOR UPDATE').get(req.actor.id);
      const pendingDebits = await db.prepare(`
        SELECT COALESCE(SUM(amount_cents + CASE
          WHEN type = 'investment_buy' THEN CAST((amount_cents * ? + 5000) / 10000 AS BIGINT)
          ELSE 0
        END), 0) AS amount
        FROM requests WHERE user_id = ? AND status = 'pending'
        AND type IN ('withdrawal', 'investment_buy')
      `).get(INVESTMENT_FEE_BPS, req.actor.id);
      if (type !== 'deposit' && Number(user.balance_cents) - Number(pendingDebits.amount) < reserveCents) {
        const error = new Error('Insufficient available funds after pending requests.');
        error.status = 400;
        throw error;
      }
      await db.prepare(`
        INSERT INTO requests (id, user_id, type, amount_cents, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, req.actor.id, type, amountCents, description, new Date().toISOString());
    });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    throw error;
  }
  res.status(202).json({
    request: {
      id,
      type,
      amount: money(amountCents),
      description,
      status: 'pending'
    },
    user: await serializeUser(await userRow(req.actor.id))
  });
}));

app.get('/api/admin/customers', requireAdmin, asyncRoute(async (req, res) => {
  const customers = (await db.prepare(`
    SELECT u.id, u.name, u.email, u.account_number, u.balance_cents, u.frozen, u.created_at,
      COALESCE(t.transaction_count, 0) AS transaction_count,
      COALESCE(r.pending_request_count, 0) AS pending_request_count
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS transaction_count FROM transactions GROUP BY user_id
    ) t ON t.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS pending_request_count
      FROM requests WHERE status = 'pending' GROUP BY user_id
    ) r ON r.user_id = u.id
    ORDER BY u.created_at DESC
  `).all()).map(serializeAdminCustomer);
  res.json({ customers });
}));

app.post('/api/admin/customers', requireAdmin, asyncRoute(async (req, res) => {
  const name = cleanText(req.body?.name, 60);
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body?.password;
  const balanceCents = parseCents(req.body?.balance, { allowZero: true });
  if (name.length < 2 || !isEmail(email) || typeof password !== 'string' ||
      password.length < PASSWORD_MIN_LENGTH || password.length > 128 || balanceCents === null) {
    return res.status(400).json({ error: 'Enter valid customer details, a password of at least 12 characters, and a non-negative balance.' });
  }
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  let account;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    account = accountNumber();
    try {
      await runTransaction(async () => {
        await db.prepare(`
          INSERT INTO users (id, name, email, password_hash, account_number, balance_cents, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, name, email, hash, account, balanceCents, new Date().toISOString());
        if (balanceCents > 0) {
          await insertTransaction(id, 'deposit', balanceCents, 'Opening balance set by administrator');
        }
        await audit(req.actor.id, 'customer.created', email, { openingBalanceCents: balanceCents });
      });
      return res.status(201).json({ user: await serializeUser(await userRow(id)) });
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'users_account_number_key') continue;
      if (error.code === '23505' && error.constraint === 'users_email_key') {
        return res.status(409).json({ error: 'A customer with this email already exists.' });
      }
      throw error;
    }
  }
  res.status(503).json({ error: 'Could not allocate a unique account number.' });
}));

app.post('/api/admin/customers/:id/adjust', requireAdmin, asyncRoute(async (req, res) => {
  const type = req.body?.type;
  const amountCents = parseCents(req.body?.amount);
  const description = cleanText(req.body?.description, 80) || 'Administrative adjustment';
  if (!['credit', 'debit'].includes(type) || amountCents === null) {
    return res.status(400).json({ error: 'Enter a valid adjustment type and amount.' });
  }
  const user = await userRow(req.params.id);
  if (!user) return res.status(404).json({ error: 'Customer account not found.' });
  try {
    await runTransaction(async () => {
      const current = await db.prepare('SELECT * FROM users WHERE id = ? FOR UPDATE').get(user.id);
      if (type === 'debit' && Number(current.balance_cents) < amountCents) {
        const error = new Error('Insufficient funds.');
        error.status = 409;
        throw error;
      }
      const nextBalance = current.balance_cents + (type === 'credit' ? amountCents : -amountCents);
      await db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(nextBalance, user.id);
      await insertTransaction(user.id, type === 'credit' ? 'deposit' : 'withdraw', amountCents, description);
      await audit(req.actor.id, `customer.${type}`, user.email, { amountCents, description });
    });
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ error: error.message });
    throw error;
  }
  res.json({ user: await serializeUser(await userRow(user.id)) });
}));

app.patch('/api/admin/customers/:id/frozen', requireAdmin, asyncRoute(async (req, res) => {
  if (typeof req.body?.frozen !== 'boolean') return res.status(400).json({ error: 'Specify whether the account should be frozen.' });
  const user = await userRow(req.params.id);
  if (!user) return res.status(404).json({ error: 'Customer account not found.' });
  await db.prepare('UPDATE users SET frozen = ? WHERE id = ?').run(Number(req.body.frozen), user.id);
  await audit(req.actor.id, req.body.frozen ? 'customer.frozen' : 'customer.unfrozen', user.email);
  res.json({ user: await serializeUser(await userRow(user.id)) });
}));

app.post('/api/admin/customers/:id/reset', requireAdmin, asyncRoute(async (req, res) => {
  const user = await userRow(req.params.id);
  if (!user) return res.status(404).json({ error: 'Customer account not found.' });
  await runTransaction(async () => {
    await db.prepare('UPDATE users SET balance_cents = 0, holdings_json = ? WHERE id = ?').run('[]', user.id);
    await db.prepare('DELETE FROM transactions WHERE user_id = ?').run(user.id);
    await db.prepare("UPDATE requests SET status = 'rejected', resolved_at = ? WHERE user_id = ? AND status = 'pending'")
      .run(new Date().toISOString(), user.id);
    await audit(req.actor.id, 'customer.reset', user.email);
  });
  res.json({ user: await serializeUser(await userRow(user.id)) });
}));

app.delete('/api/admin/customers/:id', requireAdmin, asyncRoute(async (req, res) => {
  const user = await userRow(req.params.id);
  if (!user) return res.status(404).json({ error: 'Customer account not found.' });
  await runTransaction(async () => {
    await audit(req.actor.id, 'customer.deleted', user.email);
    await db.prepare('DELETE FROM sessions WHERE actor_type = ? AND actor_id = ?').run('member', user.id);
    await db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  });
  res.status(204).end();
}));

app.get('/api/admin/requests', requireAdmin, asyncRoute(async (req, res) => {
  const requests = (await db.prepare(`
    SELECT r.id, r.type, r.amount_cents, r.description, r.status, r.created_at,
      u.id AS user_id, u.name AS user_name, u.email AS user_email,
      u.account_number, u.balance_cents
    FROM requests r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'pending' ORDER BY r.created_at ASC
  `).all()).map(row => ({
    id: row.id,
    type: row.type,
    amount: money(row.amount_cents),
    description: row.description,
    createdAt: row.created_at,
    user: {
      id: row.user_id,
      name: row.user_name,
      email: row.user_email,
      accountNumber: row.account_number,
      balance: money(row.balance_cents)
    }
  }));
  res.json({ requests });
}));

app.post('/api/admin/requests/:id/resolve', requireAdmin, asyncRoute(async (req, res) => {
  const decision = req.body?.decision;
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
  const request = await db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request || request.status !== 'pending') return res.status(404).json({ error: 'Pending request not found.' });
  const user = await userRow(request.user_id);
  if (!user) return res.status(404).json({ error: 'Customer account not found.' });
  if (decision === 'approve' && request.type.startsWith('investment_')) {
    return res.status(409).json({ error: 'Investment requests cannot be settled until an investment execution provider is configured.' });
  }
  try {
    await runTransaction(async () => {
      const currentRequest = await db.prepare('SELECT * FROM requests WHERE id = ? FOR UPDATE').get(request.id);
      if (!currentRequest || currentRequest.status !== 'pending') {
        const error = new Error('This request has already been resolved.');
        error.status = 409;
        throw error;
      }
      const currentUser = await db.prepare('SELECT * FROM users WHERE id = ? FOR UPDATE').get(request.user_id);
      if (decision === 'approve') {
        const debit = currentRequest.type === 'withdrawal' || currentRequest.type === 'investment_buy';
        const amountCents = currentRequest.type === 'investment_buy'
          ? currentRequest.amount_cents + Math.round(currentRequest.amount_cents * INVESTMENT_FEE_BPS / 10000)
          : currentRequest.type === 'deposit'
            ? currentRequest.amount_cents - Math.round(currentRequest.amount_cents * DEPOSIT_FEE_BPS / 10000)
            : currentRequest.amount_cents;
        if (debit && Number(currentUser.balance_cents) < amountCents) {
          const error = new Error('The customer balance is no longer sufficient to settle this request.');
          error.status = 409;
          throw error;
        }
        const nextBalance = currentUser.balance_cents + (debit ? -amountCents : amountCents);
        await db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(nextBalance, currentUser.id);
        const kind = debit ? 'withdraw' : 'deposit';
        const label = currentRequest.type === 'deposit'
          ? 'Verified deposit settlement'
          : currentRequest.type === 'withdrawal'
            ? 'Verified withdrawal settlement'
            : `Investment buy settlement${currentRequest.description ? ` - ${currentRequest.description}` : ''}`;
        await insertTransaction(currentUser.id, kind, amountCents, label);
      }
      const resolvedAt = new Date().toISOString();
      await db.prepare("UPDATE requests SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(decision === 'approve' ? 'approved' : 'rejected', resolvedAt, request.id);
      await audit(req.actor.id, `request.${decision}d`, user.email, {
        requestId: request.id,
        type: request.type,
        amountCents: request.amount_cents
      });
    });
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ error: error.message });
    throw error;
  }
  res.json({ user: await serializeUser(await userRow(user.id)) });
}));

async function insertTransaction(userId, type, amountCents, description) {
  await db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount_cents, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), userId, type, amountCents, description, new Date().toISOString());
}

async function audit(admin, action, target, details = {}) {
  await db.prepare(`
    INSERT INTO admin_audit (id, admin_username, action, target, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), admin, action, target, JSON.stringify(details), new Date().toISOString());
}

function getTransporter() {
  const user = (process.env.GMAIL_USER || '').trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) return null;
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

app.post('/api/notifications/email', requireMember, rateLimit({
  windowMs: 60 * 60 * 1000, max: 5, key: 'member-email'
}), asyncRoute(async (req, res) => {
  const subject = req.body?.subject;
  const body = req.body?.body;
  if (typeof subject !== 'string' || !subject.trim() || /[\r\n]/.test(subject) ||
      subject.length > 200 || typeof body !== 'string' || !body.trim() || body.length > 10000) {
    return res.status(400).json({ error: 'Enter a valid email subject and message.' });
  }
  const user = await userRow(req.actor.id);
  if (!user.email_notifications) return res.status(403).json({ error: 'Email notifications are disabled.' });
  const transporter = getTransporter();
  if (!transporter) return res.status(503).json({ error: 'Email service is not configured.' });
  try {
    const info = await transporter.sendMail({
      from: `"Capital Asset Credit Union" <${process.env.GMAIL_USER.trim()}>`,
      to: user.email,
      subject: subject.trim(),
      text: body,
      html: escapeHtml(body).replace(/\r?\n/g, '<br>')
    });
    console.log(`Member email sent: ${info.messageId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Member email send failed:', error.message);
    res.status(502).json({ error: 'Could not send the notification email.' });
  }
}));

app.post('/api/application-requests', requireMember, rateLimit({
  windowMs: 60 * 60 * 1000, max: 5, key: 'member-application'
}), asyncRoute(async (req, res) => {
  const { type, loanType, amount, purpose, cardOption } = req.body || {};
  const user = await userRow(req.actor.id);
  const applicationTypes = Object.freeze({
    'loan-application': 'Loan application request',
    'credit-card-application': 'Credit card application request',
    'debit-card-application': 'Debit card application request'
  });
  const requestTitle = Object.prototype.hasOwnProperty.call(applicationTypes, type) ? applicationTypes[type] : null;
  if (!requestTitle) return res.status(400).json({ error: 'Select a valid application type.' });

  const details = [`Applicant: ${user.name}`, `Member email: ${user.email}`];
  if (type === 'loan-application') {
    const loanTypes = ['Personal loan', 'Vehicle loan', 'Home improvement loan', 'Other'];
    const requestedAmount = parseCents(amount);
    const loanPurpose = cleanText(purpose, 240);
    if (!loanTypes.includes(loanType) || requestedAmount === null ||
        requestedAmount > 10000000000 || !loanPurpose) {
      return res.status(400).json({ error: 'Enter a valid loan type, amount, and purpose.' });
    }
    details.push(`Loan type: ${loanType}`, `Requested amount (USD): ${money(requestedAmount).toFixed(2)}`, `Purpose: ${loanPurpose}`);
  } else {
    const cardOptions = type === 'credit-card-application'
      ? ['Standard credit card', 'Rewards credit card']
      : ['New debit card', 'Replacement debit card'];
    if (!cardOptions.includes(cardOption)) return res.status(400).json({ error: 'Select a valid card option.' });
    details.push(`Request: ${cardOption}`);
  }

  const transporter = getTransporter();
  if (!transporter || !isEmail(APPLICATION_EMAIL)) {
    return res.status(503).json({ error: 'Application email service is not configured.' });
  }
  const body = [
    requestTitle,
    '',
    ...details,
    '',
    'Please contact the applicant to discuss eligibility and next steps.',
    '',
    'This is a request for review only; it is not an approval or order.'
  ].join('\n');
  try {
    await transporter.sendMail({
      from: `"Capital Asset Credit Union" <${process.env.GMAIL_USER.trim()}>`,
      to: APPLICATION_EMAIL,
      replyTo: user.email,
      subject: `Capital Asset Credit Union - ${requestTitle}`,
      text: body
    });
    res.status(202).json({ success: true, message: 'Application request sent to customer care.' });
  } catch (error) {
    console.error('Application request email failed:', error.message);
    res.status(502).json({ error: 'Could not send the application request. Please try again later.' });
  }
}));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, 'body')) {
    return res.status(400).json({ error: 'Invalid JSON request body.' });
  }
  if (error.code === '23505') {
    return res.status(409).json({ error: 'An account with those details already exists.' });
  }
  console.error('Request failed:', error.message);
  res.status(error.status || 500).json({
    error: error.status ? error.message : 'The request could not be completed.'
  });
});

async function bootstrapAdmin() {
  await initializeDatabase();
  const username = typeof process.env.ADMIN_USERNAME === 'string'
    ? process.env.ADMIN_USERNAME.trim().toLowerCase()
    : '';
  const password = process.env.ADMIN_PASSWORD;
  const adminCount = (await db.prepare('SELECT COUNT(*) AS count FROM admins').get()).count;
  if (adminCount > 0) return;
  if (!username && !password && !IS_PRODUCTION) {
    console.warn('No administrator configured. Set ADMIN_USERNAME and ADMIN_PASSWORD to enable admin access.');
    return;
  }
  if (!/^[a-z0-9._-]{3,80}$/.test(username) ||
      typeof password !== 'string' || password.length < ADMIN_PASSWORD_MIN_LENGTH || password.length > 128) {
    throw new Error(`Set ADMIN_USERNAME and an ADMIN_PASSWORD of at least ${ADMIN_PASSWORD_MIN_LENGTH} characters before starting.`);
  }
  await db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, await hashPassword(password), new Date().toISOString());
  console.log(`Bootstrapped administrator "${username}".`);
}

if (require.main === module) {
  bootstrapAdmin().then(() => {
    app.listen(PORT, () => console.log(`Capital Asset server listening on port ${PORT}`));
  }).catch(error => {
    console.error('Server startup failed:', error.message);
    process.exitCode = 1;
  });
}

function setPool(testPool) {
  pool = configurePool(testPool);
}

module.exports = { app, bootstrapAdmin, db, initializeDatabase, setPool };
