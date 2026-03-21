/**
 * sms.js — All SMS sending logic
 * Uses Twilio. Swap client.messages.create() for another provider if needed.
 */

const twilio = require("twilio");

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// ─── Core Send Function ───────────────────────────────────────────────────────
async function sendSMS(to, body) {
  if (!FROM_NUMBER) throw new Error("TWILIO_PHONE_NUMBER not set in .env");

  const msg = await client.messages.create({ body, from: FROM_NUMBER, to });
  console.log(`SMS sent to ${to} [SID: ${msg.sid}]`);
  return msg;
}

// ─── Message Builders ─────────────────────────────────────────────────────────
function buildMissedCallMessage(config, callerPhone) {
  const bookingLine = config.bookingUrl
    ? ` Book online: ${config.bookingUrl}`
    : "";

  return config.missedCallTemplate
    .replace("{business_name}", config.businessName || "us")
    .replace("{caller_name}", "there")
    .replace("{booking_url}", config.bookingUrl || "")
    .replace("{booking_line}", bookingLine)
    .trim();
}

function buildFollowUpMessage(template, config, lead) {
  const firstName = getFirstName(lead?.name) || "there";
  const bookingLine = config.bookingUrl
    ? ` Book here: ${config.bookingUrl}`
    : "";

  return template
    .replace("{first_name}", firstName)
    .replace("{business_name}", config.businessName || "us")
    .replace("{booking_url}", config.bookingUrl || "")
    .replace("{booking_line}", bookingLine)
    .trim();
}

function getFirstName(fullName) {
  if (!fullName) return null;
  return fullName.split(" ")[0];
}

module.exports = { sendSMS, buildMissedCallMessage, buildFollowUpMessage };
