/**
 * scheduler.js — Follow-up sequence scheduler
 *
 * scheduleFollowUps(lead, config) — queues all steps for a new lead
 * runPendingFollowUps()           — fires any due messages (called by cron)
 */

const db = require("./db");
const { sendSMS, buildFollowUpMessage } = require("./sms");

/**
 * Queue all follow-up steps for a lead based on the config sequence.
 * Each step is stored in follow_up_queue with a future scheduledAt timestamp.
 */
function scheduleFollowUps(lead, config) {
  const steps = config.followUpSteps || [];
  const now = new Date();

  for (const step of steps) {
    const delayMs = (step.delay || 0) * 60 * 1000; // delay is in minutes
    const scheduledAt = new Date(now.getTime() + delayMs);
    const message = buildFollowUpMessage(step.message, config, lead);

    db.queueFollowUp(lead.phone, steps.indexOf(step) + 1, scheduledAt, message);
  }

  console.log(`Scheduled ${steps.length} follow-ups for ${lead.phone}`);
}

/**
 * Run all pending follow-ups that are due.
 * Call this on a cron: every 1 minute is ideal.
 *
 * Example with node-cron:
 *   const cron = require('node-cron');
 *   cron.schedule('* * * * *', runPendingFollowUps);
 */
async function runPendingFollowUps() {
  const pending = db.getPendingFollowUps();
  if (pending.length === 0) return;

  console.log(`Running ${pending.length} pending follow-ups...`);

  for (const item of pending) {
    try {
      // Check opt-out
      const lead = db.getLead(item.phone);
      if (lead?.optOut) {
        db.markFollowUpSent(item.id); // mark so we don't retry
        continue;
      }

      // Check if lead already replied (status = replied / converted)
      if (lead?.status === "replied" || lead?.status === "converted") {
        db.cancelFollowUps(item.phone);
        continue;
      }

      await sendSMS(item.phone, item.message);
      db.markFollowUpSent(item.id);

      db.logActivity({
        type: "follow-up",
        phone: item.phone,
        message: `Step ${item.step}: "${item.message}"`,
        status: "sent",
      });

      console.log(`✓ Follow-up step ${item.step} sent to ${item.phone}`);
    } catch (err) {
      console.error(`Follow-up failed for ${item.phone}:`, err.message);
    }
  }
}

// ─── Start the cron internally if this module is loaded ─────────────────────
// Uses setInterval as a lightweight alternative (fires every 60s)
let cronStarted = false;
function startCron() {
  if (cronStarted) return;
  cronStarted = true;
  setInterval(runPendingFollowUps, 60 * 1000);
  console.log("Follow-up cron started (every 60s)");
}

startCron();

module.exports = { scheduleFollowUps, runPendingFollowUps };
