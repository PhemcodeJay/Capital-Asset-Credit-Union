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

// Gmail SMTP transporter using your Google App Password
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, body } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, body' });
    }

    const info = await transporter.sendMail({
      from: `"Capital Asset Credit Union" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>'),
    });

    console.log(`Email sent: ${info.messageId} to ${to}`);
    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    console.error('Email send failed:', err.message);
    res.status(500).json({ error: 'Failed to send email', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Capital Asset notification server running on http://localhost:${PORT}`);
});