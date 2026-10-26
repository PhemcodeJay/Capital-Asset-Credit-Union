require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APPLICATION_EMAIL = (process.env.APPLICATION_EMAIL || 'capitalassetscreditunions@gmail.com').trim();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.use(express.json({ limit: '12kb' }));

// Serve only the application assets; this folder also contains private files.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => {
  res.type('text/css').sendFile(path.join(__dirname, 'style.css'));
});

// Health check so Render (and you) can confirm the service is awake
// without triggering an email send.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mailConfigured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && EMAIL_RE.test(APPLICATION_EMAIL))
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
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().replace(/\r/g, '').slice(0, maxLength) : '';
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

app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, body } = req.body || {};

    if (!to || typeof subject !== 'string' || !subject.trim() || /[\r\n]/.test(subject) ||
        typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, body' });
    }
    // Accept a single address or a small list (desk + member inbox).
    const recipients = Array.isArray(to) ? to : String(to).split(',');
    const clean = [...new Set(recipients.map(r => String(r).trim()).filter(isEmail))].slice(0, 5);
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
      from: `"Capital Asset Credit Union" <${process.env.GMAIL_USER.trim()}>`,
      to: clean.join(', '),
      subject: subject.trim(),
      text: body,
      html: escapeHtml(body).replace(/\r?\n/g, '<br>'),
    });

    console.log(`Email sent: ${info.messageId} to ${clean.join(', ')}`);
    res.json({ success: true, messageId: info.messageId, deliveredTo: clean });
  } catch (err) {
    console.error('Email send failed:', err.message);
    res.status(500).json({ error: 'Failed to send email', detail: err.message });
  }
});

app.post('/api/application-requests', async (req, res) => {
  const { type, name, email, loanType, amount, purpose, cardOption } = req.body || {};
  const applicantName = cleanText(name, 100);
  const applicantEmail = typeof email === 'string' ? email.trim() : '';
  const applicationTypes = Object.freeze({
    'loan-application': 'Loan application request',
    'credit-card-application': 'Credit card application request',
    'debit-card-application': 'Debit card application request'
  });
  const requestTitle = Object.prototype.hasOwnProperty.call(applicationTypes, type) ? applicationTypes[type] : null;

  if (!requestTitle || !applicantName || !isEmail(applicantEmail)) {
    return res.status(400).json({ error: 'Enter a valid name, email, and application type.' });
  }

  const details = [`Applicant: ${applicantName}`, `Member email: ${applicantEmail}`];
  if (type === 'loan-application') {
    const loanTypes = ['Personal loan', 'Vehicle loan', 'Home improvement loan', 'Other'];
    const requestedAmount = Number(amount);
    const loanPurpose = cleanText(purpose, 240);
    if (!loanTypes.includes(loanType) || !Number.isFinite(requestedAmount) ||
        requestedAmount <= 0 || requestedAmount > 100000000 || !loanPurpose) {
      return res.status(400).json({ error: 'Enter a valid loan type, amount, and purpose.' });
    }
    details.push(`Loan type: ${loanType}`, `Requested amount (USD): ${requestedAmount.toFixed(2)}`, `Purpose: ${loanPurpose}`);
  } else {
    const cardOptions = type === 'credit-card-application'
      ? ['Standard credit card', 'Rewards credit card']
      : ['New debit card', 'Replacement debit card'];
    if (!cardOptions.includes(cardOption)) {
      return res.status(400).json({ error: 'Select a valid card option.' });
    }
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
      replyTo: applicantEmail,
      subject: `Capital Asset Credit Union - ${requestTitle}`,
      text: body
    });
    res.status(202).json({ success: true, message: 'Application request sent to customer care.' });
  } catch (err) {
    console.error('Application request email failed:', err.message);
    res.status(502).json({ error: 'Could not send the application request. Please try again later.' });
  }
});

app.listen(PORT, () => {
  console.log(`Capital Asset notification server running on http://localhost:${PORT}`);
});
