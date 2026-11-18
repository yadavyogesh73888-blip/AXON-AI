const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json({ limit: "32kb" }));

// Homepage Route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Splash Screen Image Route
app.get("/IMG_20261114_073941.png", (req, res) => {
  res.sendFile(path.join(__dirname, "IMG_20261114_073941.png"));
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
      message: "GROQ_API_KEY is missing in environment variables."
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

// AI Chat Route
app.post("/api/chat", async (req, res) => {
  const message = req.body?.message;

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      reply: "Arre bhai, kuch likho toh sahi! Khali message kaise samjhunga?"
    });
  }

  if (message.length > 4000) {
    return res.status(400).json({
      reply: "Bhai, message thoda zyada lamba ho gaya hai. Thoda chhota karke bhejo na!"
    });
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({
      reply: "AI service abhi configure nahi hui hai."
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  // Best Friend Personality & Exact Creator Instruction
  const systemPrompt = `
You are AXON-AI, an intelligent AI assistant that talks just like a warm, supportive, and fun best friend (ek sacche best friend ki tarah). 
- Always reply in the exact same language and script the user uses (if Hinglish, reply in natural friendly Hinglish; if Hindi, reply in Hindi; if English, reply in friendly English).
- Keep your tone casual, caring, encouraging, and relatable—never sound robotic or like a boring textbook.
- IMPORTANT RULE: Whenever anyone asks who made you, who created you, who developed you, or "tumhe kisne banaya hai" (in any language or phrasing), you MUST reply with this exact text and nothing else:
"Mujhe Maharaj Singh yani ( Ms ) ne ban yahai
Kya aap kuch aur jaanna Chate hain ?"
`;

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
              content: systemPrompt.trim()
            },
            {
              role: "user",
              content: message.trim()
            }
          ],
          max_tokens: 1000,
          temperature: 0.7
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
        reply: "Yaar, abhi server pe thoda load hai. Ek minute baad phir se try karna!"
      });
    }

    const aiReply = data.choices?.[0]?.message?.content;

    return res.json({
      reply: aiReply || "Kuch response nahi aaya yaar, ek baar phir se puchna."
    });

  } catch (error) {
    clearTimeout(timeout);
    console.error("Server error:", error.message);

    return res.status(
      error.name === "AbortError" ? 504 : 500
    ).json({
      reply:
        error.name === "AbortError"
          ? "Yaar, network thoda slow lag raha hai, timeout ho gaya. Phir se bhejo!"
          : "Kuch technical dikkat aa gayi hai bhai, thodi der mein try karte hain."
    });
  }
});

// Start Server
app.listen(PORT, "0.0.0.0", () => {
  console.log("AXON-AI server running smoothly on port " + PORT);
});
