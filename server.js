require('dotenv').config()
const express = require('express')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const { Resend } = require('resend')

const app = express()
const PORT = process.env.PORT || 3001

// Trust Render/proxy headers for rate limiting
app.set('trust proxy', 1)

// ── Middleware ──────────────────────────────────────────────────────────────
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

// ── Email Transport ─────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY)

async function sendEmail({ from, to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.log('📧 Email not configured — would have sent:', subject)
    return
  }
  await resend.emails.send({ from, to, subject, html })
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
          Submitted via 3stepscleaning.com booking form
        </p>
      </div>
    </div>
  `
}

function sanitize(str) {
  if (typeof str !== 'string') return ''
  return str.replace(/[<>]/g, '').slice(0, 1000)
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: '3 Steps Cleaning API' })
})

app.post('/api/booking', limiter, async (req, res) => {
  try {
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
    sendEmail({
      from: 'onboarding@resend.dev',
      to: process.env.BOOKING_RECIPIENT || process.env.EMAIL_USER,
      subject: `New Booking: ${data.firstName} ${data.lastName} — ${data.cleaningType} on ${data.date}`,
      html: formatBookingEmail(data),
    }).catch((err) => console.error('Owner email failed:', err.message))

    sendEmail({
      from: 'onboarding@resend.dev',
      to: data.email,
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
            <p style="margin-top: 24px;">Questions? Call us anytime at <strong><a href="tel:9021111111" style="color: #0d9488;">902-111-1111</a></strong></p>
            <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">3 Steps Cleaning Service — Halifax, NS</p>
          </div>
        </div>
      `,
    }).catch((err) => console.error('Customer email failed:', err.message))

    res.json({ success: true, message: 'Booking received successfully' })
  } catch (err) {
    console.error('Booking error:', err)
    res.status(500).json({ error: 'Internal server error. Please call 902-111-1111.' })
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
      from: 'onboarding@resend.dev',
      to: process.env.BOOKING_RECIPIENT || process.env.EMAIL_USER,
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
  console.log(`   Email configured: ${!!(process.env.EMAIL_USER && process.env.EMAIL_PASS)}\n`)
})
