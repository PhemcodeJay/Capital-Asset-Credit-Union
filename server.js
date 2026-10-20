require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve the frontend (index.html, style.css) from this directory
app.use(express.static(__dirname, { cacheControl: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); } }));

// Health check so Render (and you) can confirm the service is awake
// without triggering an email send.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mailConfigured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) });
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
    const { to, subject, body } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, body' });
    }
    // Accept a single address or a small list (desk + member inbox).
    const recipients = Array.isArray(to) ? to : String(to).split(',');
    const clean = [...new Set(recipients.map(r => String(r).trim()).filter(isEmail))].slice(0, 5);
    if (!clean.length) {
      return res.status(400).json({ error: 'No valid recipient email address' });
    }
    if (String(subject).length > 200 || String(body).length > 10000) {
      return res.status(400).json({ error: 'Subject or body too long' });
    }

    const transporter = getTransporter();
    if (!transporter) {
      return res.status(503).json({ error: 'Email service not configured (missing GMAIL_USER / GMAIL_APP_PASSWORD)' });
    }

    const info = await transporter.sendMail({
      from: `"Capital Asset Credit Union" <${process.env.GMAIL_USER.trim()}>`,
      to: clean.join(', '),
      subject: String(subject),
      text: String(body),
      html: String(body).replace(/\n/g, '<br>'),
    });

    console.log(`Email sent: ${info.messageId} to ${clean.join(', ')}`);
    res.json({ success: true, messageId: info.messageId, deliveredTo: clean });
  } catch (err) {
    console.error('Email send failed:', err.message);
    res.status(500).json({ error: 'Failed to send email', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Capital Asset notification server running on http://localhost:${PORT}`);
});