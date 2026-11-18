JavaScript

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "32kb" }));

// =====================================
// AXON AI - CORE CONFIGURATION
// =====================================

const MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const SYSTEM_PROMPT = `
You are AXON AI, an intelligent, friendly and professional AI assistant.

IDENTITY:
- Your name is AXON AI.
- You are developed by your configured creator.
- Never claim to be ChatGPT, Gemini or another AI.
- Never invent your model identity.
- If you do not know your exact model identity, say so honestly.

PERSONALITY:
- Talk like a close, respectful best friend.
- Be friendly, natural, warm and intelligent.
- Use words like Bhai, Yaar and Dost when appropriate.
- Never force these words into every reply.
- Be professional when the situation requires it.

LANGUAGE:
- Understand Hindi, Hinglish and English.
- Reply in the language used by the user.
- Use natural Hinglish when the user uses Hinglish.
- Avoid unnecessarily difficult words.

CONVERSATION:
- Understand the user's actual question.
- Give relevant and meaningful answers.
- Avoid repetitive and robotic responses.
- Keep simple answers short.
- Explain difficult topics step by step.
- Ask a clarification when necessary.
- Use emojis naturally and moderately.

GREETING EXAMPLES:

User: Aur bhai kya haal hai?
Assistant: Sab badhiya bhai! 😎 Tum sunao, kya chal raha hai?

User: Namaste
Assistant: Namaste! 🙏🏻 AXON AI mein aapka swagat hai. Bataiye, main aapki kya sahayata kar sakta hoon?

User: How are you?
Assistant: I'm doing great! How can I help you today?

MEMORY:
- Use the conversation history provided to understand context.
- Remember details within the available conversation context.
- Never pretend to remember unavailable conversations.
- Never invent a user's name.

ACCURACY:
- Never invent facts, sources or capabilities.
- Be honest when you are uncertain.
- Never claim to have browsed the internet, viewed an image,
  or performed an action unless that capability was actually used.

SAFETY:
- Respect user privacy.
- Never request passwords or secret API keys.
- For medical, legal and financial topics, provide general
  information responsibly and recommend qualified professionals
  for important decisions.

FINAL BEHAVIOUR:
Be friendly like a best friend,
intelligent like a professional assistant,
and honest in every response.
`;

// =====================================
// HOMEPAGE
// =====================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Splash Screen Image

app.get("/IMG_20261114_073941.png", (req, res) => {
  res.sendFile(
    path.join(__dirname, "IMG_20261114_073941.png")
  );
});

// =====================================
// SERVER HEALTH
// =====================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "AXON-AI",
    core: "AXON CORE PRO 2.0"
  });
});

// =====================================
// GROQ API HEALTH CHECK
// =====================================

app.get("/api/health", async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({
      status: "failed",
      server: "online",
      ai_api: "not_configured"
    });
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    15000
  );

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey.trim()}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: "user",
              content: "Reply with OK."
            }
          ],
          max_tokens: 5
        })
      }
    );

    const responseText = await response.text();

    let data = {};

    try {
      data = JSON.parse(responseText);
    } catch {
      data = {};
    }

    if (!response.ok) {
      console.error(
        "GROQ HEALTH ERROR:",
        response.status,
        responseText.slice(0, 500)
      );

      return res.status(502).json({
        status: "failed",
        server: "online",
        ai_api: "failed",
        http_status: response.status
      });
    }

    if (!data.choices?.[0]?.message?.content) {
      return res.status(502).json({
        status: "failed",
        server: "online",
        ai_api: "failed"
      });
    }

    return res.json({
      status: "ok",
      server: "online",
      ai_api: "connected",
      model: MODEL,
      core: "AXON CORE PRO 2.0"
    });

  } catch (error) {
    console.error("HEALTH ERROR:", error.message);

    return res.status(502).json({
      status: "failed",
      server: "online",
      ai_api: "unavailable"
    });

  } finally {
    clearTimeout(timeout);
  }
});

// =====================================
// AXON AI CHAT ENGINE
// =====================================

app.post("/api/chat", async (req, res) => {

  const message = req.body?.message;

  if (
    typeof message !== "string" ||
    !message.trim()
  ) {
    return res.status(400).json({
      reply: "Bhai, pehle apna message toh bhejo! 😊"
    });
  }

  if (message.length > 4000) {
    return res.status(400).json({
      reply: "Bhai, message thoda chhota karke bhejo."
    });
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({
      reply: "AXON AI server ki API configuration pending hai."
    });
  }

  // Recent conversation context
  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .filter(item =>
          item &&
          ["user", "assistant"].includes(item.role) &&
          typeof item.content === "string"
        )
        .slice(-12)
        .map(item => ({
          role: item.role,
          content: item.content.slice(0, 4000)
        }))
    : [];

  // Current message ko history mein duplicate na karein
  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT
    },
    ...history,
    {
      role: "user",
      content: message.trim()
    }
  ];

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    30000
  );

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey.trim()}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL,
          messages,
          max_tokens: 800,
          temperature: 0.7
        })
      }
    );

    const responseText = await response.text();

    let data = {};

    try {
      data = JSON.parse(responseText);
    } catch {
      data = {};
    }

    if (!response.ok) {
      console.error(
        "GROQ CHAT ERROR:",
        response.status,
        responseText.slice(0, 500)
      );

      return res.status(502).json({
        reply: "Bhai, AI service abhi busy hai. Thodi der baad try karo."
      });
    }

    const aiReply =
      data.choices?.[0]?.message?.content;

    if (!aiReply) {
      return res.status(502).json({
        reply: "Bhai, is baar mujhe response nahi mila. Dobara try karo."
      });
    }

    return res.json({
      reply: aiReply,
      model: MODEL
    });

  } catch (error) {

    console.error("CHAT ERROR:", error.message);

    return res.status(
      error.name === "AbortError" ? 504 : 500
    ).json({
      reply:
        error.name === "AbortError"
          ? "Bhai, response aane mein time lag raha hai. Dobara try karo."
          : "Connection mein problem aa gayi. Please try again."
    });

  } finally {
    clearTimeout(timeout);
  }
});

// =====================================
// START SERVER
// =====================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    "AXON CORE PRO 2.0 running on port " + PORT
  );
});
