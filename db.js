/**
 * db.js — Simple JSON file database
 * No compilation needed, works everywhere
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readFile(name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
}

function writeFile(name, data) {
  const file = path.join(DATA_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readConfig() {
  const file = path.join(DATA_DIR, "config.json");
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function writeConfig(data) {
  const file = path.join(DATA_DIR, "config.json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Leads ──────────────────────────────────────────────────────────────────────
function upsertLead(data) {
  const leads = readFile("leads");
  const idx = leads.findIndex(l => l.phone === data.phone);
  const now = new Date().toISOString();
  if (idx >= 0) {
    leads[idx] = { ...leads[idx], ...data, updatedAt: now };
    writeFile("leads", leads);
    return leads[idx];
  }
  const lead = { id: Date.now(), ...data, createdAt: now, updatedAt: now };
  leads.push(lead);
  writeFile("leads", leads);
  return lead;
}

function getLead(phone) {
  return readFile("leads").find(l => l.phone === phone) || null;
}

function getAllLeads() {
  return readFile("leads").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function updateLead(phone, updates) {
  const leads = readFile("leads");
  const idx = leads.findIndex(l => l.phone === phone);
  if (idx >= 0) {
    leads[idx] = { ...leads[idx], ...updates, updatedAt: new Date().toISOString() };
    writeFile("leads", leads);
  }
}

// ── Follow-up Queue ────────────────────────────────────────────────────────────
function queueFollowUp(phone, step, scheduledAt, message) {
  const queue = readFile("followup_queue");
  queue.push({ id: Date.now() + Math.random(), phone, step, scheduledAt: scheduledAt.toISOString(), message, status: "pending" });
  writeFile("followup_queue", queue);
}

function getPendingFollowUps() {
  const now = new Date().toISOString();
  return readFile("followup_queue").filter(i => i.status === "pending" && i.scheduledAt <= now);
}

function markFollowUpSent(id) {
  const queue = readFile("followup_queue");
  const idx = queue.findIndex(i => i.id === id);
  if (idx >= 0) { queue[idx].status = "sent"; queue[idx].sentAt = new Date().toISOString(); writeFile("followup_queue", queue); }
}

function cancelFollowUps(phone) {
  const queue = readFile("followup_queue");
  queue.forEach(i => { if (i.phone === phone && i.status === "pending") i.status = "cancelled"; });
  writeFile("followup_queue", queue);
}

// ── Activity Log ───────────────────────────────────────────────────────────────
function logActivity({ type, phone, message, status }) {
  const log = readFile("activity_log");
  log.unshift({ id: Date.now(), type, phone, message, status, createdAt: new Date().toISOString() });
  if (log.length > 500) log.splice(500);
  writeFile("activity_log", log);
}

function getRecentActivity(limit = 50) {
  return readFile("activity_log").slice(0, limit);
}

// ── Sent Log ───────────────────────────────────────────────────────────────────
function wasRecentlySent(phone, type, withinHours = 24) {
  const log = readFile("sent_log");
  const cutoff = new Date(Date.now() - withinHours * 3600 * 1000).toISOString();
  return log.some(i => i.phone === phone && i.type === type && i.sentAt >= cutoff);
}

function recordSent(phone, type) {
  const log = readFile("sent_log");
  log.push({ phone, type, sentAt: new Date().toISOString() });
  if (log.length > 1000) log.splice(0, log.length - 1000);
  writeFile("sent_log", log);
}

// ── Config ─────────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  businessName: "My Business",
  ownerPhone: "",
  bookingUrl: "",
  services: "",
  pricing: "",
  hours: "Mon-Sat 7am-6pm",
  openHour: 7,
  closeHour: 18,
  workDays: [1,2,3,4,5,6],
  afterHoursOnly: false,
  skipRepeatCallers: true,
  followUpEnabled: true,
  aiEnabled: true,
  missedCallTemplate: "Hey! Sorry we missed your call at {business_name}. We'll get back to you ASAP - or reply here to chat now.{booking_line}",
  followUpSteps: [
    { delay: 0, message: "Hey {first_name}, this is {business_name}! You recently reached out - still interested? Reply YES or call us back." },
    { delay: 1440, message: "Just checking in, {first_name} - we'd love to help. Any questions? Reply anytime.{booking_line}" },
    { delay: 4320, message: "Hi {first_name} - we're running a special this week. Want me to hold a spot for you? Just reply!" },
    { delay: 10080, message: "Last message from us, {first_name}. No worries if now's not the right time - just save our number for when you need us." }
  ],
  qaKnowledge: []
};

function getConfig() {
  return { ...DEFAULT_CONFIG, ...readConfig() };
}

function saveConfig(updates) {
  const current = readConfig();
  writeConfig({ ...current, ...updates });
}

// ── Stats ──────────────────────────────────────────────────────────────────────
function getStats() {
  const log = readFile("activity_log");
  const leads = readFile("leads");
  const queue = readFile("followup_queue");
  return {
    missedCallsSent: log.filter(i => i.type === "missed-call").length,
    followUpsSent: queue.filter(i => i.status === "sent").length,
    aiReplies: log.filter(i => i.type === "ai-reply").length,
    converted: leads.filter(l => l.status === "converted").length,
    totalLeads: leads.length
  };
}

module.exports = {
  upsertLead, getLead, getAllLeads, updateLead,
  queueFollowUp, getPendingFollowUps, markFollowUpSent, cancelFollowUps,
  logActivity, getRecentActivity,
  wasRecentlySent, recordSent,
  getConfig, saveConfig, getStats
};
