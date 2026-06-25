require('dotenv').config()
const express = require('express')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const { Resend } = require('resend')
const helmet = require('helmet')

const app = express()
const PORT = process.env.PORT || 3001

// Trust Render/proxy headers for rate limiting
app.set('trust proxy', 1)

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(helmet())
app.use(express.json({ limit: '10kb' }))
app.use(
  cors({
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
  })
)

// Rate limiting: max 10 requests per 15 min per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please try again later.' },
})

// ── Email (Resend) ────────────────────────────────────────────────────────────
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const MAIL_FROM = process.env.MAIL_FROM || '3 Steps Cleaning <onboarding@resend.dev>'

async function sendEmail({ to, subject, html, replyTo }) {
  if (!resend) {
    console.log('📧 Email not configured (set RESEND_API_KEY) — would have sent:', subject)
    return
  }
  if (!to) {
    console.warn('📧 sendEmail called with no recipient — skipping:', subject)
    return
  }
  const { error } = await resend.emails.send({
    from: MAIL_FROM,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  })
  if (error) throw new Error(error.message || 'Resend send failed')
}

// ── Bot protection (Cloudflare Turnstile) ─────────────────────────────────────
async function verifyTurnstile(token, ip) {
  // No secret configured (e.g. local dev) → skip the check so the form still works.
  if (!process.env.TURNSTILE_SECRET) return true
  if (!token) return false
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
    })
    const data = await resp.json()
    return data.success === true
  } catch (err) {
    console.error('Turnstile verify error:', err.message)
    return false
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function formatBookingEmail(data) {
  const {
    cleaningType, rooms, bathrooms, date, time, recurring,
    details, specialRequests, street, unit, buzzer, city, postalCode,
    firstName, lastName, email, phone, estimatedTotal,
  } = data

  const address = [street, unit, buzzer && `Buzzer: ${buzzer}`, city, postalCode]
    .filter(Boolean)
    .join(', ')

  const totalLine =
    estimatedTotal != null
      ? `<strong>Estimated Total: $${estimatedTotal}</strong>`
      : '<strong>Pricing: Custom Quote Required</strong>'

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; color: #1e293b;">
      <div style="background: #1e40af; padding: 32px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 22px;">New Booking Request 🧹</h1>
        <p style="color: #93c5fd; margin: 8px 0 0;">3 Steps Cleaning Service</p>
      </div>
      <div style="padding: 32px; background: #f8fafc; border-radius: 0 0 12px 12px;">

        <h2 style="color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px;">Contact</h2>
        <p><strong>Name:</strong> ${firstName} ${lastName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Phone:</strong> ${phone}</p>

        <h2 style="color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-top: 24px;">Service Details</h2>
        <p><strong>Cleaning Type:</strong> ${cleaningType}</p>
        ${details ? `<p><strong>Details:</strong> ${details}</p>` : ''}
        <p><strong>Rooms:</strong> ${rooms}</p>
        <p><strong>Bathrooms:</strong> ${bathrooms}</p>
        <p><strong>Date:</strong> ${date}</p>
        <p><strong>Time:</strong> ${time}</p>
        <p><strong>Recurring:</strong> ${recurring}</p>
        ${specialRequests ? `<p><strong>Special Requests:</strong> ${specialRequests}</p>` : ''}

        <h2 style="color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-top: 24px;">Address</h2>
        <p>${address}</p>

        <div style="background: #0d9488; color: white; padding: 16px; border-radius: 8px; margin-top: 24px; font-size: 18px;">
          ${totalLine}
        </div>

        <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">
          Submitted via 3stepscleaning.ca booking form
        </p>
      </div>
    </div>
  `
}

function sanitize(str) {
  if (typeof str !== 'string') return ''
  return str.replace(/[<>]/g, '').slice(0, 1000)
}

function validatePhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return false
  // Supports: 902-789-6801, (902) 111-1111, 9027896801, +1-902-789-6801, +1 (902) 111-1111
  const phoneRegex = /^(\+1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})$/
  return phoneRegex.test(phone.trim())
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: '3 Steps Cleaning API' })
})

app.post('/api/booking', limiter, async (req, res) => {
  try {
    // Bot protection — reject if the Turnstile challenge wasn't passed
    const humanVerified = await verifyTurnstile(req.body.turnstileToken, req.ip)
    if (!humanVerified) {
      return res.status(400).json({ error: 'Verification failed. Please complete the challenge and try again.' })
    }

    const {
      cleaningType, rooms, bathrooms, details, date, time, recurring,
      specialRequests, street, unit, buzzer, city, postalCode,
      firstName, lastName, email, phone, estimatedTotal,
    } = req.body

    // Basic validation
    const required = { firstName, lastName, email, phone, date, street, city, postalCode }
    for (const [key, val] of Object.entries(required)) {
      if (!val || String(val).trim() === '') {
        return res.status(400).json({ error: `Missing required field: ${key}` })
      }
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' })
    }

    if (!validatePhoneNumber(phone)) {
      return res.status(400).json({ error: 'Invalid phone number. Please use format like 902-789-6801 or (902) 111-1111' })
    }

    const data = {
      cleaningType: sanitize(cleaningType),
      rooms: Math.min(10, Math.max(0, parseInt(rooms) || 0)),
      bathrooms: Math.min(10, Math.max(0, parseInt(bathrooms) || 0)),
      date: sanitize(date),
      time: sanitize(time),
      recurring: sanitize(recurring),
      details: sanitize(details || '').slice(0, 1000),
      specialRequests: sanitize(specialRequests).slice(0, 400),
      street: sanitize(street),
      unit: sanitize(unit),
      buzzer: sanitize(buzzer),
      city: sanitize(city),
      postalCode: sanitize(postalCode),
      firstName: sanitize(firstName),
      lastName: sanitize(lastName),
      email: sanitize(email),
      phone: sanitize(phone),
      estimatedTotal: estimatedTotal != null ? Number(estimatedTotal) : null,
    }

    // Log to console (always)
    console.log('\n📅 NEW BOOKING REQUEST:', JSON.stringify(data, null, 2))

    // Send emails (non-blocking — booking succeeds even if email fails)
    // Owner notification: reply-to is the customer so the owner can reply directly.
    sendEmail({
      to: process.env.BOOKING_RECIPIENT,
      replyTo: data.email,
      subject: `New Booking: ${data.firstName} ${data.lastName} — ${data.cleaningType} on ${data.date}`,
      html: formatBookingEmail(data),
    }).catch((err) => console.error('Owner email failed:', err.message))

    // Customer confirmation: reply-to routes back to the business inbox (via Cloudflare Email Routing).
    sendEmail({
      to: data.email,
      replyTo: process.env.REPLY_TO || process.env.BOOKING_RECIPIENT,
      subject: 'Your Booking Request Has Been Received — 3 Steps Cleaning',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; color: #1e293b;">
          <div style="background: #1e40af; padding: 32px; border-radius: 12px 12px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 22px;">Booking Received! ✅</h1>
          </div>
          <div style="padding: 32px; background: #f8fafc; border-radius: 0 0 12px 12px;">
            <p>Hi <strong>${data.firstName}</strong>,</p>
            <p>Thank you for choosing 3 Steps Cleaning Service! We've received your booking request and will confirm your appointment within <strong>24 hours</strong>.</p>
            <p><strong>Service:</strong> ${data.cleaningType}</p>
            <p><strong>Date:</strong> ${data.date} at ${data.time}</p>
            <p><strong>Address:</strong> ${data.street}, ${data.city}</p>
            ${data.estimatedTotal != null ? `<p><strong>Estimated Total:</strong> $${data.estimatedTotal}</p>` : '<p><strong>Pricing:</strong> We\'ll provide a custom quote when we confirm your booking.</p>'}
            <p style="margin-top: 24px;">Questions? Call us anytime at <strong><a href="tel:9027896801" style="color: #0d9488;">902-789-6801</a></strong></p>
            <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">3 Steps Cleaning Service — Halifax, NS</p>
          </div>
        </div>
      `,
    }).catch((err) => console.error('Customer email failed:', err.message))

    res.json({ success: true, message: 'Booking received successfully' })
  } catch (err) {
    console.error('Booking error:', err)
    res.status(500).json({ error: 'Internal server error. Please call 902-789-6801.' })
  }
})

app.post('/api/feedback', limiter, async (req, res) => {
  try {
    const { name, email, message, rating } = req.body

    if (!name || !message) {
      return res.status(400).json({ error: 'Name and message are required' })
    }

    const data = {
      name: sanitize(name),
      email: sanitize(email || ''),
      message: sanitize(message).slice(0, 1000),
      rating: Math.min(5, Math.max(1, parseInt(rating) || 5)),
    }

    console.log('\n⭐ NEW FEEDBACK:', JSON.stringify(data, null, 2))

    await sendEmail({
      to: process.env.BOOKING_RECIPIENT,
      replyTo: data.email || undefined,
      subject: `New Feedback (${data.rating}★) from ${data.name}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto;">
          <h2>New Customer Feedback ${'⭐'.repeat(data.rating)}</h2>
          <p><strong>From:</strong> ${data.name} ${data.email ? `(${data.email})` : ''}</p>
          <p><strong>Rating:</strong> ${data.rating}/5</p>
          <p><strong>Message:</strong></p>
          <blockquote style="border-left: 4px solid #0d9488; padding-left: 16px; color: #475569;">${data.message}</blockquote>
        </div>
      `,
    })

    res.json({ success: true })
  } catch (err) {
    console.error('Feedback error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🧹 3 Steps API running on http://localhost:${PORT}`)
  console.log(`   Email (Resend): ${resend ? 'configured' : 'NOT configured'}`)
  console.log(`   Turnstile: ${process.env.TURNSTILE_SECRET ? 'enabled' : 'disabled (no secret)'}\n`)
})
