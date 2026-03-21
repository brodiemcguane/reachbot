/**
 * ai.js — AI-powered SMS reply engine
 * Uses Anthropic Claude to answer inbound customer questions.
 * Falls back to human handoff when not confident.
 */

const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Generate an AI reply to a customer's inbound text.
 * Returns { text, confident }
 */
async function getAIReply(customerMessage, config, lead) {
  const systemPrompt = buildSystemPrompt(config);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: customerMessage,
        },
      ],
    });

    const rawText = response.content[0]?.text || "";

    // Parse confidence signal
    // We ask the model to prefix with [CONFIDENT] or [UNSURE]
    if (rawText.startsWith("[UNSURE]")) {
      return {
        text: rawText.replace("[UNSURE]", "").trim(),
        confident: false,
      };
    }

    const cleanText = rawText.replace("[CONFIDENT]", "").trim();
    return { text: cleanText, confident: true };
  } catch (err) {
    console.error("AI reply error:", err);
    return {
      text: "Thanks for reaching out! We'll get back to you shortly.",
      confident: false,
    };
  }
}

/**
 * Build the system prompt from the business config.
 * This is what makes the bot "know" about a specific business.
 */
function buildSystemPrompt(config) {
  const qaSection =
    config.qaKnowledge && config.qaKnowledge.length > 0
      ? `\n\nKnown Q&A:\n${config.qaKnowledge
          .map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`)
          .join("\n\n")}`
      : "";

  return `You are a friendly, helpful SMS assistant for ${config.businessName || "a local business"}.

Your job is to answer customer questions via text message. Keep replies SHORT — under 160 characters when possible. Never use bullet points or markdown. Write like a real person texting, not a formal email.

BUSINESS INFO:
- Name: ${config.businessName || "N/A"}
- Services: ${config.services || "N/A"}
- Hours: ${config.hours || "N/A"}
- Pricing: ${config.pricing || "N/A"}
- Booking: ${config.bookingUrl || "N/A"}${qaSection}

INSTRUCTIONS:
1. If you can answer confidently based on the info above, start your reply with [CONFIDENT]
2. If the question is outside your knowledge or needs human judgment, start your reply with [UNSURE]
3. Always be warm and helpful — represent the business well
4. If they want to book, schedule, or get a quote, point them to the booking link or ask them to call
5. Never make up prices or availability — say you'll check and someone will follow up
6. If they seem angry or have a complaint, say [UNSURE] so a human handles it

Example confident reply: [CONFIDENT] Yes, we're open Mon–Sat 7am–6pm! Need to schedule something?
Example unsure reply: [UNSURE] Great question — let me have someone from the team reach out to you with the exact details!`;
}

/**
 * Batch-generate a full follow-up sequence for a given business config.
 * Useful for onboarding — generates customized message copy.
 */
async function generateFollowUpSequence(config) {
  const prompt = `Generate a 4-step SMS follow-up sequence for ${config.businessName}, a ${config.services || "local service business"}.

Requirements:
- Step 1: Sent immediately after lead comes in
- Step 2: Sent 24 hours later
- Step 3: Sent 3 days later (create urgency / value)
- Step 4: Sent 7 days later (final, graceful exit)

Each message must:
- Be under 160 characters
- Feel human and warm, not salesy
- Use {first_name} for personalization
- Use {business_name} for the business name
- Include {booking_line} where natural (a booking link placeholder)

Respond with valid JSON only, no markdown:
{
  "steps": [
    { "delay": 0, "message": "..." },
    { "delay": 1440, "message": "..." },
    { "delay": 4320, "message": "..." },
    { "delay": 10080, "message": "..." }
  ]
}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

module.exports = { getAIReply, generateFollowUpSequence, buildSystemPrompt };
