/**
 * ReachBot Server — AI SMS Automation for Small Businesses
 * Stack: Node.js + Express + Twilio + Anthropic AI
 *
 * Routes:
 *   POST /webhook/missed-call     — Twilio calls this when a call is missed
 *   POST /webhook/inbound-sms     — Twilio calls this on every inbound text
 *   POST /api/leads               — Add a new lead manually or via form
 *   GET  /api/leads               — List all leads
 *   GET  /api/activity            — Recent automation log
 *   POST /api/config              — Save business config
 *   GET  /api/config              — Load business config
 *   GET  /api/stats               — Dashboard stats
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");
const { sendSMS, buildMissedCallMessage, buildFollowUpMessage } = require("./sms");
const { getAIReply } = require("./ai");
const { scheduleFollowUps } = require("./scheduler");
const registerAiTest = require("./routes/ai-test");

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  "http://localhost:3000",
  "http://localhost:5173",
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    if (process.env.NODE_ENV !== "production") return callback(null, true);
    callback(new Error("CORS blocked: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ─── Twilio Webhook: Missed Call ───────────────────────────────────────────────
// Add this URL in Twilio → Phone Numbers → Voice → "A call comes in" → Webhook
app.post("/webhook/missed-call", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const callerNumber = req.body.From;
    const callStatus = req.body.CallStatus; // "no-answer" | "busy" | "failed"

    // Only fire for missed/unanswered calls
    if (!["no-answer", "busy", "failed"].includes(callStatus)) {
      return res.type("text/xml").send(twiml.toString());
    }

    const config = await db.getConfig();

    // Don't re-text the same number within 24 hours
    const recentlySent = await db.wasRecentlySent(callerNumber, "missed-call", 24);
    if (recentlySent) {
      console.log(`Skipping ${callerNumber} — already texted within 24h`);
      return res.type("text/xml").send(twiml.toString());
    }

    // Check if within business hours (if after-hours-only is on)
    if (config.afterHoursOnly && isWithinBusinessHours(config)) {
      console.log(`Skipping — within business hours and after-hours-only is enabled`);
      return res.type("text/xml").send(twiml.toString());
    }

    const message = buildMissedCallMessage(config, callerNumber);
    await sendSMS(callerNumber, message);

    // Log it
    await db.logActivity({
      type: "missed-call",
      phone: callerNumber,
      message,
      status: "sent",
    });

    // Add to leads if not already there
    await db.upsertLead({
      phone: callerNumber,
      source: "missed-call",
      status: "new",
    });

    console.log(`✓ Missed call text sent to ${callerNumber}`);
  } catch (err) {
    console.error("Missed call webhook error:", err);
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── Twilio Webhook: Inbound SMS ──────────────────────────────────────────────
// Add this URL in Twilio → Phone Numbers → Messaging → "A message comes in" → Webhook
app.post("/webhook/inbound-sms", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const from = req.body.From;
    const body = req.body.Body?.trim();
    const lowerBody = body?.toLowerCase() || "";

    console.log(`Inbound SMS from ${from}: "${body}"`);

    // Handle STOP / unsubscribe
    if (["stop", "unsubscribe", "cancel", "quit"].includes(lowerBody)) {
      await db.updateLead(from, { optOut: true, status: "opted-out" });
      await db.cancelFollowUps(from);
      await db.logActivity({ type: "opt-out", phone: from, message: body, status: "handled" });
      twiml.message("You've been unsubscribed. Reply START to re-subscribe anytime.");
      return res.type("text/xml").send(twiml.toString());
    }

    // Mark lead as replied — stop follow-up sequence
    const lead = await db.getLead(from);
    if (lead) {
      await db.updateLead(from, { status: "replied", lastReply: body, lastReplyAt: new Date() });
      await db.cancelFollowUps(from);
    }

    const config = await db.getConfig();

    // Get AI reply
    const aiReply = await getAIReply(body, config, lead);

    if (aiReply.confident) {
      twiml.message(aiReply.text);
      await db.logActivity({
        type: "ai-reply",
        phone: from,
        message: `Q: "${body}" → A: "${aiReply.text}"`,
        status: "replied",
      });
    } else {
      // Human handoff — notify the business owner
      const handoffMsg = `New message from ${from}: "${body}"\nAI wasn't confident — please reply manually.`;
      if (config.ownerPhone) {
        await sendSMS(config.ownerPhone, handoffMsg);
      }
      twiml.message(
        `Thanks for reaching out! We've passed your message along and someone will get back to you shortly.`
      );
      await db.logActivity({
        type: "human-handoff",
        phone: from,
        message: body,
        status: "escalated",
      });
    }
  } catch (err) {
    console.error("Inbound SMS webhook error:", err);
    twiml.message("Thanks for your message! We'll get back to you shortly.");
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── API: Leads ───────────────────────────────────────────────────────────────
app.post("/api/leads", async (req, res) => {
  try {
    const lead = await db.upsertLead({ ...req.body, source: req.body.source || "manual" });
    const config = await db.getConfig();

    // Kick off follow-up sequence immediately
    if (config.followUpEnabled && !lead.optOut) {
      scheduleFollowUps(lead, config);
    }

    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/leads", async (req, res) => {
  try {
    const leads = await db.getAllLeads();
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Activity Log ────────────────────────────────────────────────────────
app.get("/api/activity", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const activity = await db.getRecentActivity(limit);
    res.json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Config ──────────────────────────────────────────────────────────────
app.post("/api/config", async (req, res) => {
  try {
    await db.saveConfig(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/config", async (req, res) => {
  try {
    const config = await db.getConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Stats ───────────────────────────────────────────────────────────────
app.get("/api/stats", async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isWithinBusinessHours(config) {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0=Sun, 6=Sat

  const openHour = parseInt(config.openHour || 7);
  const closeHour = parseInt(config.closeHour || 18);
  const workDays = config.workDays || [1, 2, 3, 4, 5, 6];

  return workDays.includes(day) && hour >= openHour && hour < closeHour;
}

// ─── AI Test Route ────────────────────────────────────────────────────────────
registerAiTest(app);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    webhooks: {
      missedCall: (process.env.PUBLIC_URL || "") + "/webhook/missed-call",
      inboundSms: (process.env.PUBLIC_URL || "") + "/webhook/inbound-sms",
    },
  });
});

// ─── Onboard new client ───────────────────────────────────────────────────────
// Called by the onboarding form when a new client completes setup
app.post("/api/onboard", async (req, res) => {
  try {
    const {
      plan, businessName, email, ownerPhone, industry,
      services, pricing, bookingUrl, hours,
      missedCallTemplate, afterHoursOnly, skipRepeatCallers,
      openHour, closeHour, workDays,
      followUpSteps, qaKnowledge,
    } = req.body;

    if (!businessName) return res.status(400).json({ error: "businessName is required" });

    // Save client record
    const stmt = db.upsertLead({
      phone: ownerPhone || "unknown",
      name: businessName,
      email: email || null,
      source: "onboarding",
      status: "active",
    });

    // Save their full config
    await db.saveConfig({
      businessName, ownerPhone, services, pricing,
      bookingUrl, hours, missedCallTemplate,
      afterHoursOnly: afterHoursOnly || false,
      skipRepeatCallers: skipRepeatCallers !== false,
      openHour: openHour || 7,
      closeHour: closeHour || 18,
      workDays: workDays || [1,2,3,4,5,6],
      followUpSteps: followUpSteps || [],
      qaKnowledge: qaKnowledge || [],
    });

    // Text the business owner welcoming them
    if (ownerPhone) {
      await sendSMS(
        ownerPhone,
        `Welcome to ReachBot! Your ${plan || "Growth"} plan is now active for ${businessName}. Your AI automation is live — we'll text you when your first lead comes in!`
      );
    }

    // Text you so you know a new client signed up
    if (process.env.OWNER_PHONE && process.env.OWNER_PHONE !== ownerPhone) {
      await sendSMS(
        process.env.OWNER_PHONE,
        `New ReachBot signup: ${businessName} (${plan} plan). Phone: ${ownerPhone}. Industry: ${industry || "unknown"}.`
      );
    }

    const publicUrl = process.env.PUBLIC_URL || "https://your-server.up.railway.app";
    res.json({
      success: true,
      message: "Client configured and activated",
      webhookVoice: `${publicUrl}/webhook/missed-call",
      webhookSms: `${publicUrl}/webhook/inbound-sms`,
      nextStep: "Paste the webhook URLs into your Twilio phone number settings",
    });

  } catch (err) {
    console.error("Onboard error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── List clients (agency dashboard) ─────────────────────────────────────────
app.get("/api/clients", async (req, res) => {
  try {
    const leads = await db.getAllLeads();
    const clients = leads.filter(l => l.source === "onboarding" || l.source === "manual");
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🤖 ReachBot server running on port ${PORT}`);
  console.log(`   Missed call webhook: POST /webhook/missed-call`);
  console.log(`   Inbound SMS webhook: POST /webhook/inbound-sms`);
  console.log(`   Dashboard API:       GET  /api/stats\n`);
});

module.exports = app;
