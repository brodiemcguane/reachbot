/**
 * routes/ai-test.js — Test endpoint for the AI Q&A bot
 * POST /api/ai-test { message } → { reply, confident }
 */

const { getAIReply } = require("../ai");
const db = require("../db");

module.exports = function registerAiTest(app) {
  app.post("/api/ai-test", async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: "message required" });
      const config = await db.getConfig();
      const result = await getAIReply(message, config, null);
      res.json({ reply: result.text, confident: result.confident });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
