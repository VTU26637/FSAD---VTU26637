// ─────────────────────────────────────────────────────────────
//  TechSpark 2025 – Ticket Booking Backend
//  Stack: Node.js + Express + MySQL2
//
//  Setup:
//    1. npm install express mysql2 cors
//    2. Create your MySQL database (see SQL below)
//    3. Fill in your DB credentials in the config section
//    4. node server.js
// ─────────────────────────────────────────────────────────────

const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');

const app  = express();
const PORT = 5000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── DB Config — fill these in ─────────────────────────────────
const DB_CONFIG = {
  host:     'localhost',
  user:     'root',         // your MySQL username
  password: '12345',             // your MySQL password
  database: 'techspark_db',    // your database name
  waitForConnections: true,
  connectionLimit: 10
};

// ── DB Pool ───────────────────────────────────────────────────
let pool;
(async () => {
  try {
    pool = mysql.createPool(DB_CONFIG);
    // Quick connectivity test
    const conn = await pool.getConnection();
    console.log('✅ MySQL connected successfully');
    conn.release();
    await ensureSchema();
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    console.error('   Make sure MySQL is running and credentials are correct.');
    process.exit(1);
  }
})();

// ── Auto-create tables if they don't exist ────────────────────
async function ensureSchema() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      name             VARCHAR(255)  NOT NULL,
      department       VARCHAR(255)  NOT NULL,
      date             DATE          NOT NULL,
      time             VARCHAR(100)  NOT NULL,
      venue            VARCHAR(255)  NOT NULL,
      price            INT           NOT NULL DEFAULT 199,
      total_tickets    INT           NOT NULL DEFAULT 200,
      available_tickets INT          NOT NULL DEFAULT 200,
      created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS bookings (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      name         VARCHAR(255)  NOT NULL,
      email        VARCHAR(255)  NOT NULL,
      department   VARCHAR(100)  NOT NULL,
      tickets      INT           NOT NULL,
      total_amount DECIMAL(10,2) NOT NULL,
      event_id     INT           NOT NULL,
      booked_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  // Seed a default event if none exists
  const [rows] = await pool.execute('SELECT id FROM events LIMIT 1');
  if (rows.length === 0) {
    await pool.execute(`
      INSERT INTO events (name, department, date, time, venue, price, total_tickets, available_tickets)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'TechSpark 2025 – National Technical Festival',
      'Department of Computer Science & Engineering',
      '2025-04-25',
      '09:00 AM – 06:00 PM',
      'Main Auditorium, Block A, Ground Floor',
      199,
      200,
      200
    ]);
    console.log('🌱 Default event seeded into database');
  }

  console.log('📋 Schema ready');
}

// ─────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────

// GET /api/event  — fetch event details
app.get('/api/event', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM events ORDER BY id LIMIT 1'
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No event found.' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/event error:', err.message);
    res.status(500).json({ error: 'Failed to fetch event details.' });
  }
});

// POST /api/book  — create a booking
app.post('/api/book', async (req, res) => {
  const { name, email, department, tickets } = req.body;

  // ── Server-side validation ──
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Full name is required.' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (!department) {
    return res.status(400).json({ error: 'Department is required.' });
  }
  const ticketCount = parseInt(tickets);
  if (isNaN(ticketCount) || ticketCount < 1) {
    return res.status(400).json({ error: 'At least 1 ticket is required.' });
  }
  if (ticketCount > 10) {
    return res.status(400).json({ error: 'Maximum 10 tickets per booking.' });
  }

  // ── DB transaction (atomic seat deduction) ──
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the event row while we check availability
    const [events] = await conn.execute(
      'SELECT * FROM events ORDER BY id LIMIT 1 FOR UPDATE'
    );
    if (events.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Event not found.' });
    }

    const event = events[0];

    if (event.available_tickets < ticketCount) {
      await conn.rollback();
      return res.status(409).json({
        error: `Only ${event.available_tickets} ticket(s) remaining.`
      });
    }

    const totalAmount = ticketCount * event.price;

    // Deduct tickets
    await conn.execute(
      'UPDATE events SET available_tickets = available_tickets - ? WHERE id = ?',
      [ticketCount, event.id]
    );

    // Insert booking record
    const [result] = await conn.execute(
      `INSERT INTO bookings (name, email, department, tickets, total_amount, event_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name.trim(), email.trim(), department, ticketCount, totalAmount, event.id]
    );

    await conn.commit();

    console.log(`📌 Booking #${result.insertId}: ${name.trim()} | ${ticketCount} ticket(s) | ₹${totalAmount}`);

    res.status(201).json({
      message: 'Booking confirmed!',
      booking: {
        id:          result.insertId,
        name:        name.trim(),
        email:       email.trim(),
        department,
        tickets:     ticketCount,
        eventName:   event.name,
        totalAmount
      }
    });

  } catch (err) {
    await conn.rollback();
    console.error('POST /api/book error:', err.message);
    res.status(500).json({ error: 'Booking failed. Please try again.' });
  } finally {
    conn.release();
  }
});

// GET /api/bookings  — view all bookings (admin use)
app.get('/api/bookings', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT b.id, b.name, b.email, b.department, b.tickets, b.total_amount, b.booked_at, e.name AS event_name
       FROM bookings b
       JOIN events e ON b.event_id = e.id
       ORDER BY b.booked_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/bookings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch bookings.' });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 TechSpark server running at http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/event`);
  console.log(`   API: http://localhost:${PORT}/api/book  (POST)`);
  console.log(`   API: http://localhost:${PORT}/api/bookings\n`);
});
