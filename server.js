const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("path");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 10000;

app.set("trust proxy", 1);

if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log("[AXON-AI] Firebase Admin initialized via FIREBASE_SERVICE_ACCOUNT_JSON.");
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault()
      });
      console.log("[AXON-AI] Firebase Admin initialized via applicationDefault.");
    }
  } catch (err) {
    console.warn("[AXON-AI] Firebase Admin init skipped/warning:", err.message);
  }
}

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(cors());

app.use((req, res, next) => {
  if (
    req.path === "/api/vision" ||
    req.path === "/api/video" ||
    req.path === "/api/photo-edit" ||
    req.path === "/api/photo-studio-edit"
  ) {
    return next();
  }
  express.json({ limit: "2mb" })(req, res, next);
});


function sanitizeModel(val, fallback) {
  if (typeof val !== "string") return fallback;
  const cleaned = val.trim().replace(/^["']+|["']+$/g, "");
  if (!cleaned) return fallback;
  return cleaned;
}

const CHAT_MODEL = sanitizeModel(
  process.env.GROQ_MODEL,
  "openai/gpt-oss-120b"
);

const VISION_MODEL = sanitizeModel(
  process.env.GROQ_VISION_MODEL,
  "qwen/qwen3.8-27b"
);

const IMAGE_EDIT_MODEL = sanitizeModel(
  process.env.GEMINI_IMAGE_MODEL,
  "gemini-2.5-flash-image"
);


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
  if (typeof imageData !== "string") {
    return { ok: false, error: "Image is required." };
  }
  const match = imageData.match(
    /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i
  );
  if (!match) {
    return { ok: false, error: "Unsupported image format. Only JPEG, PNG, and WebP are supported." };
  }
  const base64Clean = match[2];
  const imageBytes = Buffer.from(base64Clean, "base64");
  if (!imageBytes.length || imageBytes.length > 5 * 1024 * 1024) {
    return { ok: false, error: "Image must be smaller than 5 MB." };
  }
  const ext = match[1].toLowerCase();
  const mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
  return {
    ok: true,
    bytes: imageBytes,
    base64: base64Clean,
    mimeType
  };
}

function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  const safeMessages = [];
  for (const item of rawHistory.slice(-12)) {
    if (!item || typeof item !== "object") continue;
    const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
    const content = typeof item.content === "string" ? item.content.trim().slice(0, 4000) : "";
    if (role && content) {
      safeMessages.push({ role, content });
    }
  }
  return safeMessages;
}

async function callGroqChat(apiKey, messages, { model = CHAT_MODEL, maxTokens = 950, temperature = 0.88, timeoutMs = 30000 } = {}) {
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
        model,
        messages,
        max_tokens: maxTokens,
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
      return {
        ok: false,
        status: response.status >= 400 && response.status < 500 ? response.status : 502,
        error: data?.error?.message || `Groq API request failed (HTTP ${response.status}).`
      };
    }

    const content = data?.choices?.[0]?.message?.content;
    return {
      ok: true,
      reply: typeof content === "string" && content.trim() ? content : ""
    };
  } catch (error) {
    return {
      ok: false,
      status: error?.name === "AbortError" ? 504 : 500,
      error: error?.name === "AbortError" ? "Groq API request timed out." : error?.message || "Groq server error."
    };
  } finally {
    clearTimeout(timeout);
  }
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

    const replyText = data?.choices?.[0]?.message?.content;
    return {
      ok: true,
      reply: replyText || "Analysis nahi ho paya."
    };
  } catch (error) {
    return {
      ok: false,
      status: error?.name === "AbortError" ? 504 : 500,
      error: error?.name === "AbortError" ? "Analysis timed out." : "Vision server error."
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

  const check = await callGroqChat(
    apiKey,
    [{ role: "user", content: "Reply with OK." }],
    { model: CHAT_MODEL, maxTokens: 10, temperature: 0, timeoutMs: 15000 }
  );

  if (!check.ok) {
    return res.status(502).json({
      status: "failed",
      server: "online",
      ai_api: check.error.includes("timed out") ? "unavailable" : "failed",
      message: check.error
    });
  }

  return res.json({
    status: "ok",
    server: "online",
    ai_api: "connected",
    model: CHAT_MODEL,
    message: "AXON-AI Groq connection successful."
  });
});

// Photo Studio AI Image Generation & Editing Route (GEMINI API ONLY)
app.post("/api/photo-studio-edit", visionLimiter, express.json({ limit: "12mb" }), async (req, res) => {
  const { imageBase64, prompt, mode } = req.body || {};
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!geminiKey || !geminiKey.trim()) {
    return res.status(503).json({
      error: "GEMINI_API_KEY set nahi hai ya empty hai."
    });
  }

  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt zaroori hai." });
  }

  const hasImage = typeof imageBase64 === "string" && imageBase64.trim().length > 0;
  let imgCheck = null;

  if (hasImage) {
    imgCheck = isValidBase64Image(imageBase64);
    if (!imgCheck.ok) {
      return res.status(400).json({ error: imgCheck.error });
    }
  } else if (mode && mode !== "generate" && mode !== "text-to-image") {
    return res.status(400).json({ error: "Image is required for this editing mode." });
  }

  const cleanPrompt = prompt.trim().slice(0, 1500);
  let finalPrompt = cleanPrompt;

  if (imgCheck) {
    const prefix =
      mode === "cgi"
        ? "Transform into a high-detail 3D CGI / Unreal Engine cinematic render with dramatic lighting and depth while keeping the main subject recognizable. "
        : mode === "background"
        ? "Replace and transform the background environment naturally while keeping the foreground subject sharp and consistent. "
        : "Apply AI style and scene transformation while keeping the core subject consistent. ";
    finalPrompt = `${prefix}${cleanPrompt}`;
  } else {
    finalPrompt = `Generate a high-quality, detailed visual image for: ${cleanPrompt}`;
  }

  const parts = [];
  if (imgCheck) {
    parts.push({
      inlineData: {
        mimeType: imgCheck.mimeType,
        data: imgCheck.base64
      }
    });
  }
  parts.push({ text: finalPrompt });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(IMAGE_EDIT_MODEL)}:generateContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiKey.trim()
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts
          }
        ],
        generationConfig: {
          responseModalities: ["IMAGE", "TEXT"]
        }
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
      console.error("[AXON-AI] GEMINI IMAGE ERROR:", {
        status: response.status,
        model: IMAGE_EDIT_MODEL,
        message: data?.error?.message || `HTTP ${response.status}`
      });
      return res.status(response.status).json({
        error: data?.error?.message || "Gemini image generation/edit failed."
      });
    }

    const resParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = resParts.find((p) => p?.inlineData?.data);

    if (imagePart?.inlineData?.data) {
      const outMime = imagePart.inlineData.mimeType || "image/png";
      return res.json({
        editedImage: `data:${outMime};base64,${imagePart.inlineData.data}`,
        model: IMAGE_EDIT_MODEL
      });
    }

    const textPart = resParts.find((p) => typeof p?.text === "string")?.text;
    return res.status(502).json({
      error: textPart || "Gemini se image data nahi mila."
    });
  } catch (err) {
    console.error("[AXON-AI] PHOTO STUDIO ERROR:", err?.message || err);
    return res.status(err?.name === "AbortError" ? 504 : 500).json({
      error: err?.name === "AbortError" ? "Gemini image request timed out." : err?.message || "Photo Studio error."
    });
  } finally {
    clearTimeout(timeout);
  }
});

// Photo & Live Camera Vision Route (GROQ API)
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
    ? `Look closely at this photo and reply in the exact same language and script as the user's request (defaulting to helpful Hinglish if none specified):
1. **Is photo mein kya-kya hai:** List all key objects, people/expressions, background, lighting, and any visible text.
2. **Photo edit kaise karein:** Give clear, practical editing steps (exposure/brightness, contrast, color grading/tone, sharpness, cropping/framing, and VFX/filter ideas).
${userNote ? `User request: ${userNote}` : ""}`
    : userNote ||
      "Analyze this image clearly in short, helpful points in the user's language (defaulting to Hinglish). Tell what is inside the photo (visible details, objects, text) and give practical photo editing/VFX ideas.";

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
    console.error("[AXON-AI] VISION API ERROR:", {
      status: result.status,
      message: result.error,
      model: VISION_MODEL
    });
    return res.status(result.status).json({ error: result.error });
  }

  return res.json({ reply: result.reply });
});

// Dedicated Photo Editing & Inspection Route (GROQ API)
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

  const instruction = `You are AXON-AI's Photo Inspector & Editor. Automatically detect the language and script of the user's request and reply in that exact same language/script (defaulting to helpful Hinglish if unspecified). Do not translate unless asked.
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
    console.error("[AXON-AI] PHOTO-EDIT API ERROR:", {
      status: result.status,
      message: result.error,
      model: VISION_MODEL
    });
    return res.status(result.status).json({ error: result.error });
  }

  return res.json({ reply: result.reply });
});

// Video Inspection Route (GROQ API ONLY — Multi-Frame Analysis)
app.post("/api/video", visionLimiter, express.json({ limit: "15mb" }), async (req, res) => {
  const { frames, prompt, videoName } = req.body || {};
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({
      error: "AI service is not configured (GROQ_API_KEY missing)."
    });
  }

  if (!Array.isArray(frames) || !frames.length) {
    return res.status(400).json({
      error: "Please send at least one valid video frame to inspect."
    });
  }

  const frameList = frames.slice(0, 8);
  const validParts = [];
  let invalidCount = 0;

  for (let i = 0; i < frameList.length; i++) {
    const check = isValidBase64Image(frameList[i]);
    if (check.ok) {
      validParts.push({ type: "text", text: `Frame ${i + 1}:` });
      validParts.push({ type: "image_url", image_url: { url: frameList[i] } });
    } else {
      invalidCount++;
    }
  }

  if (!validParts.length) {
    return res.status(400).json({
      error: "Unsupported or invalid video frame format. Only JPEG, PNG, and WebP frames under 5 MB each are supported."
    });
  }

  const titleNote = typeof videoName === "string" && videoName.trim() ? `Video file: ${videoName.trim()}. ` : "";
  const userAsk = typeof prompt === "string" && prompt.trim() ? prompt.trim().slice(0, 2000) : "";
  const formatNote = invalidCount > 0 ? `(${invalidCount} unsupported frame(s) were skipped.) ` : "";

  const headerText = `${titleNote}${formatNote}Inspect all provided video frames carefully (do not treat them as a single static thumbnail). Detect the user's language/script and reply in that exact same language/script (casual, clear, and helpful):
1. **Is video mein kya-kya hai:** Explain all people, objects, places, actions, and any visible text/graphics across the frames.
2. **Scene & Flow:** Describe what changes or happens across the sequence of frames.
3. **Editing / VFX Tips:** Suggest practical improvements for color, pacing, framing, or VFX.
${userAsk ? `Specific question from user: ${userAsk}` : ""}`;

  const result = await analyzeWithVisionModel(
    apiKey,
    [{ type: "text", text: headerText }, ...validParts],
    950,
    0.5,
    35000
  );

  if (!result.ok) {
    console.error("[AXON-AI] VIDEO API ERROR:", {
      status: result.status,
      message: result.error,
      model: VISION_MODEL
    });
    return res.status(result.status).json({ error: result.error });
  }

  return res.json({ reply: result.reply });
});

// Main Chat Route (GROQ API ONLY — Text, History, Multilingual & Video Context)
app.post("/api/chat", chatLimiter, async (req, res) => {
  const message = req.body?.message;
  const deepThink = Boolean(req.body?.deepThink);
  const history = sanitizeHistory(req.body?.history);
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

  let videoContext = "";
  if (videoFrames.length > 0) {
    const parts = [
      {
        type: "text",
        text: `User sent a video and asked: "${message.trim()}". Examine all provided frames carefully and describe everything visible (objects, actions, scene changes, text) clearly and concisely in the user's language.`
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
      const vidRes = await analyzeWithVisionModel(apiKey, parts, 750, 0.5, 30000);
      if (vidRes.ok && vidRes.reply) {
        videoContext = `\n\n[Video Frame Analysis]:\n${vidRes.reply}`;
      } else {
        console.warn("[AXON-AI] VIDEO CONTEXT WARNING:", vidRes.error);
      }
    }
  }

  const systemPrompt = `
You are AXON-AI, an intelligent, respectful, natural, and relatable conversational AI best friend.
- MULTILINGUAL SUPPORT: Automatically detect the language and script used by the user in their latest message (including English, Hindi, Hinglish, Urdu, Arabic, French, Spanish, German, Portuguese, Japanese, Korean, Chinese, Russian, Bengali, Marathi, Tamil, Telugu, Gujarati, Punjabi, and other languages).
- Always reply in the EXACT same language and script the user uses.
- Handle mixed-language messages naturally and support seamless language switching across turns while preserving conversation context.
- Never force English replies and do not translate unless the user explicitly asks for a translation.
- Preserve Unicode characters and write naturally like a real, helpful human companion.
- VARIETY RULE: Always give a fresh, varied, natural reply on every message—never repeat the exact same canned phrase even if the user sends a similar or repeated prompt.
- CODE & CONVERSATION SEPARATION: When providing code, keep the conversational explanation outside and put complete runnable code inside a fenced code block (\`\`\`html, \`\`\`javascript, \`\`\`css, \`\`\`python, etc.) so the UI renders a dedicated code workspace with live preview.
- You can help with coding, image editing/generation workflows, video frame analysis/VFX, song/rap lyrics & beat concepts, math, maps, and general problem-solving.
- ${deepThink ? "Deep Think mode is ON: provide clear, structured, step-by-step reasoning." : "Keep responses clear, practical, engaging, and easy to read."}
- CRITICAL CREATOR RULES:
  1. If anyone asks who made you, who created you, or "tumhe kisne banaya hai", you MUST reply with this exact information and style:
     "Mujhe Maharaj Singh yani ( Ms ) ne banaya hai. 
     Kya aap kuch aur jaanna chahte hain?"
  2. If the user follows up by asking "Ms?" or "Ms matlab?", you must explain respectfully and warmly:
     "Ms matlab Maharaj Singh."
`;

  const finalUserMessage = videoContext ? `${message.trim()}${videoContext}` : message.trim();

  const messagesPayload = [
    { role: "system", content: systemPrompt.trim() },
    ...history,
    { role: "user", content: finalUserMessage }
  ];

  const chatResult = await callGroqChat(apiKey, messagesPayload, {
    model: CHAT_MODEL,
    maxTokens: deepThink ? 1500 : 950,
    temperature: 0.88,
    timeoutMs: 30000
  });

  if (!chatResult.ok) {
    console.error("[AXON-AI] GROQ CHAT ERROR:", {
      status: chatResult.status,
      message: chatResult.error,
      model: CHAT_MODEL
    });
    return res.status(502).json({
      reply: `Yaar, abhi AI API mein dikkat aayi (${chatResult.error}). Thodi der baad try karna!`
    });
  }

  return res.json({
    reply: chatResult.reply || "Kuch response nahi aaya yaar, ek baar phir se puchna."
  });
});

// Firebase Auth Helpers
async function verifyUser(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.split(" ")[1];

  if (!token) return null;
  if (!admin.apps.length) {
    throw new Error("Firebase Admin is not initialized on the server.");
  }

  const decoded = await admin.auth().verifyIdToken(token);

  return {
    uid: decoded.uid,
    name: decoded.name || "",
    email: decoded.email || ""
  };
}

async function requireAuth(req, res, next) {
  try {
    const user = await verifyUser(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized: missing or invalid token." });
    }
    req.user = user;
    return next();
  } catch (err) {
    console.error("[AXON-AI] AUTH VERIFY ERROR:", err?.message || err);
    return res.status(401).json({ error: "Unauthorized: token verification failed." });
  }
}

app.use((err, req, res, next) => {
  console.error("[AXON-AI] UNHANDLED ERROR:", err?.message || err);
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Uploaded payload is too large." });
  }
  return res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("AXON-AI Secure Server running on port " + PORT);
  console.log(`[AXON-AI] Models -> Chat: ${CHAT_MODEL} | Vision: ${VISION_MODEL} | Gemini Image: ${IMAGE_EDIT_MODEL}`);
});
