JavaScript

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

// ==================================
// AXON AI CONFIGURATION
// ==================================

app.disable("x-powered-by");

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ==================================
// AXON AI PERSONALITY
// ==================================

const SYSTEM_PROMPT = `
You are AXON AI, a smart, friendly and helpful AI assistant.

IDENTITY:
- Your name is AXON AI.
- You are an independent AI assistant.
- Never claim to be ChatGPT, Gemini or another AI.
- Never invent your developer's identity.

LANGUAGE:
- Understand Hindi, Hinglish and English.
- Always reply in the user's language.
- Use simple, natural and clear language.
- Do not give unnecessarily long answers.

PERSONALITY:
- Be friendly like a helpful friend.
- Be respectful and professional.
- Use Bhai, Dost or Yaar naturally when appropriate.
- Avoid robotic and repetitive replies.
- Use emojis moderately.
- If user greets you, greet them naturally.

HELP:
- Help with coding, education, science and technology.
- Explain difficult topics step by step.
- Give complete code when requested.
- Mention important limitations honestly.

PRIVACY:
- Use only the display name supplied by the application.
- Never request passwords, OTPs or API keys.
- Never expose private user information.
- Do not ask for unnecessary personal details.

SAFETY:
- Never assist violence, cybercrime, fraud,
  abuse or other harmful activities.
- Politely refuse unsafe instructions.
- Offer a safe alternative.
- Respect privacy and consent.
- Do not perform external actions without authorization.

TOOLS:
- Do not claim to browse websites unless browsing results
  are actually provided.
- Do not claim to see images unless image data is provided.
- Do not claim to understand videos unless video analysis
  results are provided.
- Do not claim to edit images unless an image editing
  tool has actually completed the task.
- Never fabricate tool results.

HONESTY:
- If you cannot do something, explain why.
- Never pretend an operation succeeded when it did not.
`;

// ==================================
// GROQ AI REQUEST
// ==================================

async function askGroq(messages, maxTokens = 1000) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is missing in Render.");
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
      throw new Error(
        data.error?.message ||
        `Groq API error: ${response.status}`
      );
    }

    const reply =
      data.choices?.[0]?.message?.content;

    if (!reply || typeof reply !== "string") {
      throw new Error("Empty AI response received.");
    }

    return reply.trim();

  } finally {
    clearTimeout(timeout);
  }
}

// ==================================
// SERVER HEALTH
// ==================================

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    server: "AXON AI",
    message: "AXON AI backend is running."
  });
});

// ==================================
// AI HEALTH
// ==================================

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
        content: "Reply only OK."
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
    console.error("HEALTH ERROR:", error.message);

    return res.status(502).json({
      status: "failed",
      server: "online",
      ai_api: "failed",
      message: error.message
    });
  }
});

// ==================================
// MAIN CHAT API
// ==================================

app.post("/api/chat", async (req, res) => {
  try {
    const body = req.body || {};

    const message = body.message;
    const history = body.history;
    const userName = body.userName;

    if (
      typeof message !== "string" ||
      !message.trim()
    ) {
      return res.status(400).json({
        success: false,
        reply: "Please enter a message."
      });
    }

    if (message.length > 8000) {
      return res.status(413).json({
        success: false,
        reply: "Message is too long."
      });
    }

    // Only use the display name.
    const safeName =
      typeof userName === "string"
        ? userName.trim().replace(/[<>]/g, "").slice(0, 80)
        : "";

    const systemMessage =
      SYSTEM_PROMPT +
      (safeName
        ? `\nThe user's display name is ${safeName}.`
        : "");

    const messages = [
      {
        role: "system",
        content: systemMessage
      }
    ];

    // Conversation context
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

    messages.push({
      role: "user",
      content: message.trim()
    });

    const reply = await askGroq(messages, 1200);

    return res.json({
      success: true,
      reply,
      model: GROQ_MODEL
    });

  } catch (error) {
    console.error("CHAT ERROR:", error.message);

    const timeoutError =
      error.name === "AbortError";

    return res.status(502).json({
      success: false,
      reply: timeoutError
        ? "AXON AI ko response dene mein zyada samay lag raha hai. Dobara try karein."
        : "AXON AI se connection mein problem aa rahi hai. Thodi der baad try karein.",
      error: timeoutError
        ? "Request timeout"
        : error.message
    });
  }
});

// ==================================
// API NOT FOUND
// ==================================

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    error: "API route not found."
  });
});

// ==================================
// GLOBAL ERROR HANDLER
// ==================================

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

// ==================================
// START AXON AI
// ==================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("        AXON AI ONLINE");
  console.log("================================");
  console.log("Port:", PORT);
  console.log("Model:", GROQ_MODEL);
  console.log(
    "Groq API:",
    GROQ_API_KEY ? "Configured" : "Missing"
  );
  console.log("================================");
});
