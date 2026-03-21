/**
 * db.js — Database layer
 * Uses SQLite (via better-sqlite3) for local dev.
 * To use Postgres in production, swap the queries to pg — the interface stays identical.
 */

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "reachbot.db");
const db = new Database(DB_PATH);

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT,
    email TEXT,
    source TEXT DEFAULT 'manual',
    status TEXT DEFAULT 'new',
    optOut INTEGER DEFAULT 0,
    lastReply TEXT,
    lastReplyAt TEXT,
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS follow_up_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    step INTEGER NOT NULL,
    scheduledAt TEXT NOT NULL,
    sentAt TEXT,
    status TEXT DEFAULT 'pending',
    message TEXT
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    phone TEXT,
    message TEXT,
    status TEXT,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    type TEXT NOT NULL,
    sentAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ─── Leads ────────────────────────────────────────────────────────────────────
function upsertLead(data) {
  const existing = db
    .prepare("SELECT * FROM leads WHERE phone = ?")
    .get(data.phone);

  if (existing) {
    db.prepare(`
      UPDATE leads SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        source = COALESCE(?, source),
        status = COALESCE(?, status),
        updatedAt = datetime('now')
      WHERE phone = ?
    `).run(data.name, data.email, data.source, data.status, data.phone);
    return db.prepare("SELECT * FROM leads WHERE phone = ?").get(data.phone);
  } else {
    db.prepare(`
      INSERT INTO leads (phone, name, email, source, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      data.phone,
      data.name || null,
      data.email || null,
      data.source || "manual",
      data.status || "new"
    );
    return db.prepare("SELECT * FROM leads WHERE phone = ?").get(data.phone);
  }
}

function getLead(phone) {
  return db.prepare("SELECT * FROM leads WHERE phone = ?").get(phone) || null;
}

function getAllLeads() {
  return db.prepare("SELECT * FROM leads ORDER BY createdAt DESC").all();
}

function updateLead(phone, updates) {
  const fields = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(", ");
  const values = [...Object.values(updates), phone];
  db.prepare(`UPDATE leads SET ${fields}, updatedAt = datetime('now') WHERE phone = ?`).run(
    ...values
  );
}

// ─── Follow-up Queue ──────────────────────────────────────────────────────────
function queueFollowUp(phone, step, scheduledAt, message) {
  db.prepare(`
    INSERT INTO follow_up_queue (phone, step, scheduledAt, message)
    VALUES (?, ?, ?, ?)
  `).run(phone, step, scheduledAt.toISOString(), message);
}

function getPendingFollowUps() {
  return db
    .prepare(`
      SELECT * FROM follow_up_queue
      WHERE status = 'pending'
      AND scheduledAt <= datetime('now')
    `)
    .all();
}

function markFollowUpSent(id) {
  db.prepare(`
    UPDATE follow_up_queue
    SET status = 'sent', sentAt = datetime('now')
    WHERE id = ?
  `).run(id);
}

function cancelFollowUps(phone) {
  db.prepare(`
    UPDATE follow_up_queue
    SET status = 'cancelled'
    WHERE phone = ? AND status = 'pending'
  `).run(phone);
}

function getFollowUpStepCount(phone) {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM follow_up_queue WHERE phone = ? AND status = 'sent'`)
    .get(phone);
  return row?.cnt || 0;
}

// ─── Activity Log ─────────────────────────────────────────────────────────────
function logActivity({ type, phone, message, status }) {
  db.prepare(`
    INSERT INTO activity_log (type, phone, message, status)
    VALUES (?, ?, ?, ?)
  `).run(type, phone || null, message || null, status || null);
}

function getRecentActivity(limit = 50) {
  return db
    .prepare("SELECT * FROM activity_log ORDER BY createdAt DESC LIMIT ?")
    .all(limit);
}

// ─── Sent Log (dedup) ─────────────────────────────────────────────────────────
function wasRecentlySent(phone, type, withinHours = 24) {
  const row = db
    .prepare(`
      SELECT * FROM sent_log
      WHERE phone = ? AND type = ?
      AND sentAt >= datetime('now', '-${withinHours} hours')
    `)
    .get(phone, type);
  return !!row;
}

function recordSent(phone, type) {
  db.prepare("INSERT INTO sent_log (phone, type) VALUES (?, ?)").run(phone, type);
}

// ─── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  businessName: "My Business",
  ownerPhone: "",
  bookingUrl: "",
  services: "",
  pricing: "",
  hours: "Mon–Sat 7am–6pm",
  openHour: 7,
  closeHour: 18,
  workDays: [1, 2, 3, 4, 5, 6],
  afterHoursOnly: false,
  skipRepeatCallers: true,
  followUpEnabled: true,
  aiEnabled: true,
  missedCallTemplate:
    "Hey! Sorry we missed your call at {business_name}. We'll get back to you ASAP — or reply here to chat now.{booking_line}",
  followUpSteps: [
    {
      delay: 0,
      message:
        "Hey {first_name}, this is {business_name}! You recently reached out — still interested? Reply YES or call us back.",
    },
    {
      delay: 24 * 60,
      message:
        "Just checking in, {first_name} — we'd love to help. Any questions? Reply anytime.{booking_line}",
    },
    {
      delay: 3 * 24 * 60,
      message:
        "Hi {first_name} — we're running a special this week. Want me to hold a spot for you? Just reply and we'll take care of everything.",
    },
    {
      delay: 7 * 24 * 60,
      message:
        "Last message from us, {first_name}. If now's not the right time, no worries! Just save our number — we're here when you need us.",
    },
  ],
  qaKnowledge: [],
};

function getConfig() {
  const rows = db.prepare("SELECT key, value FROM config").all();
  const stored = {};
  rows.forEach((r) => {
    try {
      stored[r.key] = JSON.parse(r.value);
    } catch {
      stored[r.key] = r.value;
    }
  });
  return { ...DEFAULT_CONFIG, ...stored };
}

function saveConfig(updates) {
  const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
  const saveMany = db.transaction((obj) => {
    for (const [key, value] of Object.entries(obj)) {
      stmt.run(key, JSON.stringify(value));
    }
  });
  saveMany(updates);
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function getStats() {
  const missedCallsSent = db
    .prepare("SELECT COUNT(*) as cnt FROM activity_log WHERE type = 'missed-call'")
    .get().cnt;
  const followUpsSent = db
    .prepare("SELECT COUNT(*) as cnt FROM follow_up_queue WHERE status = 'sent'")
    .get().cnt;
  const aiReplies = db
    .prepare("SELECT COUNT(*) as cnt FROM activity_log WHERE type = 'ai-reply'")
    .get().cnt;
  const converted = db
    .prepare("SELECT COUNT(*) as cnt FROM leads WHERE status = 'converted'")
    .get().cnt;
  const totalLeads = db.prepare("SELECT COUNT(*) as cnt FROM leads").get().cnt;

  return { missedCallsSent, followUpsSent, aiReplies, converted, totalLeads };
}

module.exports = {
  upsertLead,
  getLead,
  getAllLeads,
  updateLead,
  queueFollowUp,
  getPendingFollowUps,
  markFollowUpSent,
  cancelFollowUps,
  getFollowUpStepCount,
  logActivity,
  getRecentActivity,
  wasRecentlySent,
  recordSent,
  getConfig,
  saveConfig,
  getStats,
};
