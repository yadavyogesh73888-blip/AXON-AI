
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// Render Proxy Configuration
app.set("trust proxy", 1);

// Security Headers
// CSP is disabled temporarily to avoid breaking existing frontend scripts.
app.use(helmet({
  contentSecurityPolicy: false
}));

// Middleware
app.use(cors());
app.use((req, res, next) => {
  if (req.path === "/api/vision") {
    return next();
  }

  express.json({ limit: "32kb" })(req, res, next);
});

// Chat Rate Limiter
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    reply: "Too many requests. Please wait a minute and try again."
  }
});

// Groq Health Check Rate Limiter
const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    status: "failed",
    message: "Too many health checks. Please try again later."
  }
});
  // Photo Vision Rate Limiter
const visionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many image requests. Please wait a minute."
  }
});

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Splash Screen Image
app.get("/IMG_20261114_073941.png", (req, res) => {
  res.sendFile(path.join(__dirname, "IMG_20261114_073941.png"));
});

// Server Health Check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "AXON-AI"
  });
});

// Groq API Health Check
app.get("/api/health", healthLimiter, async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({
      status: "failed",
      server: "online",
      ai_api: "not_configured",
      message: "GROQ_API_KEY is missing."
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
    clearTimeout(timeout);

    let data = {};
    try {
      data = JSON.parse(responseText);
    } catch {
      data = {};
    }

    if (!response.ok) {
      console.error("GROQ HEALTH ERROR:", {
        status: response.status
      });

      return res.status(502).json({
        status: "failed",
        server: "online",
        ai_api: "failed",
        http_status: response.status,
        message:
          response.status === 401 || response.status === 403
            ? "API authentication failed."
            : response.status === 404
            ? "Model or API endpoint not found."
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
app.post("/api/chat", chatLimiter, async (req, res) => {
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

// AXON AI - PHOTO VISION API
app.post(
  "/api/vision",
  visionLimiter,
  express.json({ limit: "7mb" }),
  async (req, res) => {
    const { imageData, prompt } = req.body || {};

    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({
        error: "AI service is not configured."
      });
    }

    if (typeof imageData !== "string") {
      return res.status(400).json({
        error: "Image is required."
      });
    }

    const match = imageData.match(
      /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i
    );

    if (!match) {
      return res.status(400).json({
        error: "Only JPEG, PNG and WebP images are supported."
      });
    }

    const imageBytes = Buffer.from(match[2], "base64");

    if (
      imageBytes.length === 0 ||
      imageBytes.length > 4 * 1024 * 1024
    ) {
      return res.status(413).json({
        error: "Image must be smaller than 4 MB."
      });
    }

    const question =
      typeof prompt === "string" && prompt.trim()
        ? prompt.trim().slice(0, 2000)
        : "Describe this image and explain what you can see.";

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
            "Authorization":
              `Bearer ${process.env.GROQ_API_KEY.trim()}`
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: "qwen/qwen3.8-27b",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: question
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: imageData
                    }
                  }
                ]
              }
            ],
            max_completion_tokens: 1024
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        console.error("VISION API ERROR:", {
          status: response.status,
          error: data.error?.message
        });

        return res.status(502).json({
          error: "Photo analysis failed. Please try again."
        });
      }

      return res.json({
        reply:
          data.choices?.[0]?.message?.content ||
          "Photo ka analysis nahi ho paya."
      });

    } catch (error) {
      console.error("VISION SERVER ERROR:", error.message);

      return res.status(
        error.name === "AbortError" ? 504 : 500
      ).json({
        error:
          error.name === "AbortError"
            ? "Photo analysis timed out."
            : "Vision server error."
      });

    } finally {
      clearTimeout(timeout);
    }
  }
);
  
  // Original Creator Rules - Preserved
  const systemPrompt = `
You are AXON-AI, an intelligent, respectful, and fun best friend (ek sacche aur izzat dene wale best friend ki tarah). 
- Always reply in the exact same language and script the user uses (Hinglish/Hindi/English).
- Keep your tone casual, caring, respectful, and relatable.
- CRITICAL CREATOR RULES:
  1. If anyone asks who made you, who created you, or "tumhe kisne banaya hai", you MUST reply with this exact information and style:
     "Mujhe Maharaj Singh yani ( Ms ) ne banaya hai. 
     Kya aap kuch aur jaanna chahte hain?"
  2. If the user follows up by asking "Ms?" or "Ms matlab?", you must explain respectfully and warmly:
     "Ms matlab Maharaj Singh."
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
        status: response.status
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
  console.log("AXON-AI Secure Server running on port " + PORT);
});
