
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "32kb" }));

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Basic Server Health Check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "AXON-AI"
  });
});

// Groq API Health Check
app.get("/api/health", async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({
      status: "failed",
      server: "online",
      ai_api: "not_configured",
      message: "hi"
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

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
          model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
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

    clearTimeout(timeout);

    if (!response.ok) {
      console.error("GROQ HEALTH ERROR:", {
        status: response.status,
        details: responseText.slice(0, 1000)
      });

      return res.status(502).json({
        status: "failed",
        server: "online",
        ai_api: "failed",
        http_status: response.status,
        message:
          response.status === 401 || response.status === 403
            ? "API authentication failed. Check your API key."
            : response.status === 404
            ? "Model or API endpoint not found. Check GROQ_MODEL."
            : response.status === 429
            ? "API rate limit reached."
            : "Groq API request failed."
      });
    }

    if (!data.choices?.[0]?.message?.content) {
      return res.status(502).json({
        status: "failed",
        server: "online",
        ai_api: "failed",
        message: "No AI response received."
      });
    }

    return res.json({
      status: "ok",
      server: "online",
      ai_api: "connected",
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      message: "AXON-AI Groq connection successful."
    });

  } catch (error) {
    clearTimeout(timeout);

    console.error("Groq health check error:", error.message);

    return res.status(502).json({
      status: "failed",
      server: "online",
      ai_api: "unavailable",
      message:
        error.name === "AbortError"
          ? "Groq API request timed out."
          : "Unable to connect to Groq API."
    });
  }
});

// AI Chat
app.post("/api/chat", async (req, res) => {
  const message = req.body?.message;

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      reply: "Please enter a message."
    });
  }

  if (message.length > 4000) {
    return res.status(400).json({
      reply: "Message is too long."
    });
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({
      reply: "AI service is not configured."
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

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
          model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
          messages: [
            {
              role: "system",
              content:
                "You are AXON-AI, a helpful AI assistant. Reply in the language the user uses. Be clear, accurate and helpful."
            },
            {
              role: "user",
              content: message.trim()
            }
          ],
          max_tokens: 800
        })
      }
    );

    const responseText = await response.text();
    clearTimeout(timeout);

    let data = {};
    try {
      data = JSON.parse(responseText);
    } catch {
      data = {};
    }

    if (!response.ok) {
      console.error("GROQ API ERROR:", {
        status: response.status,
        details: responseText.slice(0, 1000)
      });

      return res.status(502).json({
        reply: "AI service is temporarily unavailable."
      });
    }

    const aiReply = data.choices?.[0]?.message?.content;

    return res.json({
      reply: aiReply || "No response received."
    });

  } catch (error) {
    clearTimeout(timeout);

    console.error("Server error:", error.message);

    return res.status(
      error.name === "AbortError" ? 504 : 500
    ).json({
      reply:
        error.name === "AbortError"
          ? "AI response timed out. Please try again."
          : "Something went wrong."
    });
  }
});

// Start Server
app.listen(PORT, "0.0.0.0", () => {
  console.log("AXON-AI server running on port " + PORT);
});
