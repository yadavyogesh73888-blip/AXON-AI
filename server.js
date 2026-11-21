const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(cors());

app.use((req, res, next) => {
  if (req.path === "/api/vision" || req.path === "/api/video" || req.path === "/api/photo-edit") {
    return next();
  }
  express.json({ limit: "2mb" })(req, res, next);
});

function sanitizeModel(val, fallback) {
  if (typeof val !== "string") return fallback;
  const cleaned = val.trim().replace(/^["']+|["']+$/g, "");
  return cleaned || fallback;
}

const CHAT_MODEL = "openai/gpt-oss-120b";
const VISION_MODEL = sanitizeModel(process.env.GROQ_VISION_MODEL, "qwen/qwen3.8-27b");

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 25,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    reply: "Too many requests. Please wait a minute and try again."
  }
});

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

const visionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many image requests. Please wait a minute."
  }
});

function isValidBase64Image(imageData) {
  if (typeof imageData !== "string") return { ok: false, error: "Image is required." };
  const match = imageData.match(
    /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i
  );
  if (!match) {
    return { ok: false, error: "Only JPEG, PNG, and WebP images are supported." };
  }
  const imageBytes = Buffer.from(match[2], "base64");
  if (!imageBytes.length || imageBytes.length > 5 * 1024 * 1024) {
    return { ok: false, error: "Image must be smaller than 5 MB." };
  }
  return { ok: true, bytes: imageBytes };
}

async function analyzeWithVisionModel(apiKey, contentParts, maxTokens = 800, temperature = 0.5, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: "user",
            content: contentParts
          }
        ],
        max_completion_tokens: maxTokens,
        temperature
      })
    });

    const rawText = await response.text();
    let data = {};
    try {
      data = JSON.parse(rawText);
    } catch {
      data = {};
    }

    if (!response.ok) {
      const apiErrMsg = data?.error?.message || "Media analysis failed. Please try again.";
      return {
        ok: false,
        status: response.status >= 400 && response.status < 500 ? response.status : 502,
        error: apiErrMsg
      };
    }

    const replyText = data.choices?.[0]?.message?.content;
    return {
      ok: true,
      reply: replyText || "Analysis nahi ho paya."
    };
  } catch (error) {
    return {
      ok: false,
      status: error.name === "AbortError" ? 504 : 500,
      error: error.name === "AbortError" ? "Analysis timed out." : "Vision server error."
    };
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/IMG_20261114_073941.png", (req, res) => {
  res.sendFile(path.join(__dirname, "IMG_20261114_073941.png"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "AXON-AI"
  });
});

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
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 10
      })
    });

    const responseText = await response.text();
    clearTimeout(timeout);

    let data = {};
    try {
      data = JSON.parse(responseText);
    } catch {
      data = {};
    }

    if (!response.ok) {
      return res.status(502).json({
        status: "failed",
        server: "online",
        ai_api: "failed",
        http_status: response.status,
        message: data?.error?.message || "Groq API request failed."
      });
    }

    return res.json({
      status: "ok",
      server: "online",
      ai_api: "connected",
      model: CHAT_MODEL,
      message: "AXON-AI Groq connection successful."
    });
  } catch (error) {
    clearTimeout(timeout);
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

// Photo & Live Camera Vision Route (What's inside + Photo Editing Guidance)
app.post("/api/vision", visionLimiter, express.json({ limit: "8mb" }), async (req, res) => {
  const { imageData, prompt, editMode } = req.body || {};
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({
      error: "AI service is not configured (GROQ_API_KEY missing)."
    });
  }

  const imgCheck = isValidBase64Image(imageData);
  if (!imgCheck.ok) {
    return res.status(400).json({ error: imgCheck.error });
  }

  const userNote = typeof prompt === "string" && prompt.trim() ? prompt.trim().slice(0, 2000) : "";
  const question = editMode
    ? `Look closely at this photo and reply in the user's language (Hinglish/Hindi/English):
1. **Is photo mein kya-kya hai:** List all key objects, people/expressions, background, lighting, and any visible text.
2. **Photo edit kaise karein:** Give clear, practical editing steps (exposure/brightness, contrast, color grading/tone, sharpness, cropping/framing, and VFX/filter ideas).
${userNote ? `User request: ${userNote}` : ""}`
    : userNote ||
      "Analyze this image clearly in short, helpful points. Tell what is inside the photo (visible details, objects, text) and give practical photo editing/VFX ideas.";

  const result = await analyzeWithVisionModel(
    apiKey,
    [
      { type: "text", text: question },
      { type: "image_url", image_url: { url: imageData } }
    ],
    800,
    0.5,
    30000
  );

  if (!result.ok) {
    console.error("VISION API ERROR:", {
      status: result.status,
      message: result.error,
      model: VISION_MODEL
    });
    return res.status(result.status).json({ error: result.error });
  }

  return res.json({ reply: result.reply });
});

// Dedicated Photo Editing & Inspection Route
app.post("/api/photo-edit", visionLimiter, express.json({ limit: "8mb" }), async (req, res) => {
  const { imageData, prompt, style } = req.body || {};
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({
      error: "AI service is not configured (GROQ_API_KEY missing)."
    });
  }

  const imgCheck = isValidBase64Image(imageData);
  if (!imgCheck.ok) {
    return res.status(400).json({ error: imgCheck.error });
  }

  const styleHint = typeof style === "string" && style.trim() ? `Desired style: ${style.trim()}.` : "";
  const customAsk = typeof prompt === "string" && prompt.trim() ? `User instruction: ${prompt.trim().slice(0, 2000)}` : "";

  const instruction = `You are AXON-AI's Photo Inspector & Editor. Reply in the same language/script as the user's request (defaulting to helpful Hinglish).
1. **Photo mein kya-kya hai:** Clearly describe every main subject, object, setting, lighting condition, and any text/details present.
2. **Kaise edit karein (Step-by-Step Editing Guide):** Give exact adjustments for Brightness/Exposure, Contrast, Highlights/Shadows, Saturation/Color Grading, Sharpening, and Framing/Cleanup.
${styleHint}
${customAsk}`;

  const result = await analyzeWithVisionModel(
    apiKey,
    [
      { type: "text", text: instruction },
      { type: "image_url", image_url: { url: imageData } }
    ],
    900,
    0.55,
    30000
  );

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  return res.json({ reply: result.reply });
});

// Video Inspection Route (Watches extracted frames & tells what's inside the video)
app.post("/api/video", visionLimiter, express.json({ limit: "15mb" }), async (req, res) => {
  const { frames, prompt, videoName } = req.body || {};
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({
      error: "AI service is not configured (GROQ_API_KEY missing)."
    });
  }

  const frameList = Array.isArray(frames) ? frames.slice(0, 8) : [];
  if (!frameList.length) {
    return res.status(400).json({
      error: "Please send at least one video frame to inspect."
    });
  }

  const validParts = [];
  for (let i = 0; i < frameList.length; i++) {
    const check = isValidBase64Image(frameList[i]);
    if (check.ok) {
      validParts.push({ type: "text", text: `Frame ${i + 1}:` });
      validParts.push({ type: "image_url", image_url: { url: frameList[i] } });
    }
  }

  if (!validParts.length) {
    return res.status(400).json({
      error: "Invalid video frame format. Only JPEG, PNG, and WebP frames are supported."
    });
  }

  const titleNote = typeof videoName === "string" && videoName.trim() ? `Video file: ${videoName.trim()}. ` : "";
  const userAsk = typeof prompt === "string" && prompt.trim() ? prompt.trim().slice(0, 2000) : "";

  const headerText = `${titleNote}Watch these frames from the video and tell the user clearly (in the user's language, casual & helpful):
1. **Is video mein kya-kya hai:** Explain all people, objects, places, actions, and any visible text/graphics across the frames.
2. **Scene & Flow:** Briefly describe what is happening from start to end in these frames.
3. **Editing / VFX Tips:** Suggest quick ways to make this video look even better if they want to edit it.
${userAsk ? `Specific question from user: ${userAsk}` : ""}`;

  const result = await analyzeWithVisionModel(
    apiKey,
    [{ type: "text", text: headerText }, ...validParts],
    950,
    0.5,
    35000
  );

  if (!result.ok) {
    console.error("VIDEO API ERROR:", {
      status: result.status,
      message: result.error,
      model: VISION_MODEL
    });
    return res.status(result.status).json({ error: result.error });
  }

  return res.json({ reply: result.reply });
});

// Main Chat Route (Text chat + optional videoFrames inspection)
app.post("/api/chat", chatLimiter, async (req, res) => {
  const message = req.body?.message;
  const deepThink = Boolean(req.body?.deepThink);
  const videoFrames = Array.isArray(req.body?.videoFrames) ? req.body.videoFrames.slice(0, 8) : [];

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      reply: "Arre bhai, kuch likho toh sahi! Khali message kaise samjhunga?"
    });
  }

  if (message.length > 12000) {
    return res.status(400).json({
      reply: "Bhai, message thoda zyada lamba ho gaya hai. Thoda chhota karke bhejo na!"
    });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({
      reply: "AI service abhi configure nahi hui hai (GROQ_API_KEY missing)."
    });
  }

  // If video frames are attached with a chat message, inspect the video first and include details
  let videoContext = "";
  if (videoFrames.length > 0) {
    const parts = [
      {
        type: "text",
        text: `User sent a video and asked: "${message.trim()}". Describe everything visible in these video frames (objects, actions, scene, text) clearly and concisely.`
      }
    ];
    for (let i = 0; i < videoFrames.length; i++) {
      const check = isValidBase64Image(videoFrames[i]);
      if (check.ok) {
        parts.push({ type: "text", text: `Frame ${i + 1}:` });
        parts.push({ type: "image_url", image_url: { url: videoFrames[i] } });
      }
    }
    if (parts.length > 1) {
      const vidRes = await analyzeWithVisionModel(apiKey, parts, 700, 0.5, 30000);
      if (vidRes.ok && vidRes.reply) {
        videoContext = `\n\n[Video Frame Analysis]:\n${vidRes.reply}`;
      }
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const systemPrompt = `
You are AXON-AI, an intelligent, respectful, and fun best friend (ek sacche aur izzat dene wale best friend ki tarah).
- Always reply in the exact same language and script the user uses (Hinglish/Hindi/English).
- Keep your tone casual, caring, respectful, and relatable.
- You can help with photo editing/analysis, video editing/VFX workflows, song/rap lyrics & beat concepts, coding, and file analysis.
- ${deepThink ? "Deep Think mode is ON: give structured, step-by-step reasoning." : "Keep responses clear, practical, and easy to read."}
- CRITICAL CREATOR RULES:
  1. If anyone asks who made you, who created you, or "tumhe kisne banaya hai", you MUST reply with this exact information and style:
     "Mujhe Maharaj Singh yani ( Ms ) ne banaya hai. 
     Kya aap kuch aur jaanna chahte hain?"
  2. If the user follows up by asking "Ms?" or "Ms matlab?", you must explain respectfully and warmly:
     "Ms matlab Maharaj Singh."
`;

  const finalUserMessage = videoContext ? `${message.trim()}${videoContext}` : message.trim();

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt.trim() },
          { role: "user", content: finalUserMessage }
        ],
        max_tokens: deepThink ? 1400 : 800,
        temperature: 0.7
      })
    });

    const responseText = await response.text();
    clearTimeout(timeout);

    let data = {};
    try {
      data = JSON.parse(responseText);
    } catch {
      data = {};
    }

    if (!response.ok) {
      const errDetail = data?.error?.message || `HTTP ${response.status}`;
      console.error("GROQ API ERROR:", {
        status: response.status,
        message: errDetail,
        model: CHAT_MODEL
      });
      return res.status(502).json({
        reply: `Yaar, abhi AI API mein dikkat aayi (${errDetail}). Thodi der baad try karna!`
      });
    }

    const aiReply = data.choices?.[0]?.message?.content;
    return res.json({
      reply: aiReply || "Kuch response nahi aaya yaar, ek baar phir se puchna."
    });
  } catch (error) {
    clearTimeout(timeout);
    console.error("Server error:", error.message);

    return res.status(error.name === "AbortError" ? 504 : 500).json({
      reply:
        error.name === "AbortError"
          ? "Yaar, network thoda slow lag raha hai, timeout ho gaya. Phir se bhejo!"
          : "Kuch technical dikkat aa gayi hai bhai, thodi der mein try karte hain."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("AXON-AI Secure Server running on port " + PORT);
});
