require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const Stripe = require('stripe');
const { Pool } = require('pg');

const app = express();

// ---------- CONFIG ----------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// For normal JSON
app.use(cors());
app.use(bodyParser.json());

// For Stripe webhook (raw body)
app.use('/stripe/webhook', bodyParser.raw({ type: 'application/json' }));

// ---------- DATABASE ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      expires_at TIMESTAMPTZ,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
initDb();

// ---------- HELPERS ----------
async function upsertLicense({ email, stripeCustomerId, stripeSubscriptionId, expiresAt, active = true }) {
  const res = await pool.query(
    `
    INSERT INTO licenses (email, active, expires_at, stripe_customer_id, stripe_subscription_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (email)
    DO UPDATE SET
      active = EXCLUDED.active,
      expires_at = EXCLUDED.expires_at,
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      updated_at = NOW()
    RETURNING *;
    `,
    [email.toLowerCase(), active, expiresAt, stripeCustomerId, stripeSubscriptionId]
  );
  return res.rows[0];
}

async function findLicenseByEmail(email) {
  const res = await pool.query(
    'SELECT * FROM licenses WHERE email = $1',
    [email.toLowerCase()]
  );
  return res.rows[0];
}

// ---------- ROUTES ----------
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'blastit-license-server' });
});

// ---------- CHECK LICENSE ----------
app.post('/check-license', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.json({ valid: false, message: 'Missing email.' });
    }

    const lic = await findLicenseByEmail(email);
    if (!lic) return res.json({ valid: false, message: 'Not licensed.' });

    if (!lic.active) return res.json({ valid: false, message: 'Subscription inactive.' });

    if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
      return res.json({ valid: false, message: 'Subscription expired.' });
    }

    return res.json({
      valid: true,
      message: 'Valid license.',
      expiresAt: lic.expires_at
    });

  } catch (err) {
    console.log(err);
    return res.json({ valid: false, message: 'Server error.' });
  }
});

// ---------- ADMIN: ADD LICENSE ----------
app.post('/admin/add-license', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ ok: false, message: 'Forbidden' });
  }

  const { email, months = 1 } = req.body;
  if (!email) return res.json({ ok: false, message: 'Email required.' });

  const now = new Date();
  const expiresAt = new Date(now.setMonth(now.getMonth() + months));

  const lic = await upsertLicense({
    email,
    expiresAt,
    active: true,
    stripeCustomerId: null,
    stripeSubscriptionId: null
  });

  res.json({ ok: true, license: lic });
});

// ---------- STRIPE WEBHOOK ----------
app.post('/stripe/webhook', async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook signature failed.');
    return res.status(400).send('Invalid signature.');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_details.email;
        const customer = session.customer;
        const subscription = session.subscription;

        const now = new Date();
        const expiresAt = new Date(now.setMonth(now.getMonth() + 1));

        await upsertLicense({
          email,
          stripeCustomerId: customer,
          stripeSubscriptionId: subscription,
          expiresAt,
          active: true
        });

        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        const customerId = invoice.customer;

        const customer = await stripe.customers.retrieve(customerId);
        const email = customer.email;

        const now = new Date();
        const expiresAt = new Date(now.setMonth(now.getMonth() + 1));

        await upsertLicense({
          email,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          expiresAt,
          active: true
        });

        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customer = await stripe.customers.retrieve(subscription.customer);
        const email = customer.email;

        await upsertLicense({
          email,
          expiresAt: new Date(),
          active: false
        });

        break;
      }
    }
  } catch (err) {
    console.log('Webhook error:', err);
  }

  res.json({ received: true });
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Blast It License Server running on ${PORT}`));
