
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const GROQ_URL =
  "https://api.groq.com/openai/v1/chat/completions";

// ================================
// BASIC SETTINGS
// ================================

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Serve website files and assets
app.use(express.static(__dirname));

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ================================
// AXON AI PERSONALITY & SAFETY
// ================================

const SYSTEM_PROMPT = `
You are AXON AI, an intelligent, friendly and helpful AI assistant.

IDENTITY:
- Your name is AXON AI.
- Never claim to be ChatGPT, Gemini or another AI.
- If asked who developed you, answer only with the developer
  identity configured by the application. Never invent a name.

PERSONALITY:
- Be friendly, natural, respectful and intelligent.
- Talk like a helpful friend while remaining professional.
- Reply in the language used by the user.
- Understand Hindi, Hinglish and English.
- Use "Bhai", "Dost" or "Yaar" naturally when appropriate.
- Do not use too many emojis.
- Avoid repetitive and robotic replies.

USER PRIVACY:
- Use only the user's display name if the application provides it.
- Do not ask for unnecessary personal information.
- Never request passwords, OTPs or private API keys.
- Do not reveal private information.

HELPFULNESS:
- Help with education, coding, technology and general questions.
- Explain difficult topics in simple language.
- Give practical and accurate answers.
- Admit when you do not know something.
- Never pretend that an unavailable feature is working.

SAFETY:
- Never provide instructions that facilitate violence,
  cybercrime, abuse, fraud or other harmful activities.
- Politely refuse unsafe requests.
- Offer a safe alternative whenever possible.
- Do not encourage dangerous activities.
- Respect privacy and consent.
- Ask for confirmation before important external actions.

CAPABILITIES:
- Only claim to see images, understand videos, edit images,
  browse websites or perform external actions when the required
  tools are actually connected and their results are available.
- Never pretend to have opened or checked a website.
- Never invent search results or actions.
`;

// ================================
// GROQ API HELPER
// ================================

async function askGroq(messages, maxTokens = 800) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is missing in Render Environment.");
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 30000);

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const apiMessage =
        data.error?.message || `Groq API error: ${response.status}`;

      throw new Error(apiMessage);
    }

    const reply = data.choices?.[0]?.message?.content;

    if (!reply || typeof reply !== "string") {
      throw new Error("Groq returned an empty response.");
    }

    return reply.trim();

  } finally {
    clearTimeout(timeout);
  }
}

// ================================
// SERVER HEALTH
// ================================

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    server: "AXON AI",
    message: "Server is running."
  });
});

// ================================
// AI API HEALTH CHECK
// ================================

app.get("/api/health", async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(503).json({
      status: "failed",
      server: "online",
      ai_api: "not_configured",
      message: "GROQ_API_KEY is missing."
    });
  }

  try {
    await askGroq([
      {
        role: "user",
        content: "Reply with OK."
      }
    ], 10);

    return res.json({
      status: "success",
      server: "online",
      ai_api: "connected",
      model: GROQ_MODEL,
      message: "AXON AI is ready."
    });

  } catch (error) {
    console.error("AI HEALTH ERROR:", error.message);

    return res.status(502).json({
      status: "failed",
      server: "online",
      ai_api: "failed",
      model: GROQ_MODEL,
      message: error.message
    });
  }
});

// ================================
// MAIN CHAT API
// ================================

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history, userName } = req.body || {};

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        error: "Please enter a message."
      });
    }

    if (message.length > 8000) {
      return res.status(413).json({
        error: "Message is too long."
      });
    }

    // Only accept a display name from the frontend.
    // Do not send email, phone or other profile details.
    const safeName =
      typeof userName === "string"
        ? userName.trim().slice(0, 80)
        : "";

    const messages = [
      {
        role: "system",
        content: SYSTEM_PROMPT +
          (safeName
            ? `\nThe user's display name is: ${safeName}.`
            : "")
      }
    ];

    // Recent conversation context
    if (Array.isArray(history)) {
      const safeHistory = history
        .filter(item =>
          item &&
          ["user", "assistant"].includes(item.role) &&
          typeof item.content === "string" &&
          item.content.trim()
        )
        .slice(-12);

      for (const item of safeHistory) {
        messages.push({
          role: item.role,
          content: item.content.slice(0, 4000)
        });
      }
    }

    // Current user message
    messages.push({
      role: "user",
      content: message.trim()
    });

    const reply = await askGroq(messages, 1000);

    return res.json({
      success: true,
      reply,
      model: GROQ_MODEL
    });

  } catch (error) {
    console.error("CHAT ERROR:", error.message);

    return res.status(500).json({
      success: false,
      reply: "Sorry, AXON AI se connection mein problem aa rahi hai. Thodi der baad dobara try karein.",
      error: error.message
    });
  }
});

// ================================
// UNKNOWN API ROUTES
// ================================

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found."
  });
});

// ================================
// START SERVER
// ================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("       AXON AI ONLINE");
  console.log("================================");
  console.log("Port:", PORT);
  console.log("Model:", GROQ_MODEL);
  console.log("API Key:", GROQ_API_KEY ? "Configured" : "Missing");
});
                
