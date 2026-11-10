
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "32kb" }));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "AXON-AI"
  });
});

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

  if (!apiKey) {
    return res.status(500).json({
      reply: "AI service is not configured."
    });
  }

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content: "You are AXON-AI, a helpful AI assistant. Reply in the language the user uses."
            },
            {
              role: "user",
              content: message
            }
          ],
          max_tokens: 800
        })
      }
    );

    if (!response.ok) {
      console.error("Groq error:", response.status);
      return res.status(502).json({
        reply: "AI service is temporarily unavailable."
      });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content;

    return res.json({
      reply: reply || "No response received."
    });

  } catch (error) {
    console.error("Server error:", error.message);
    return res.status(500).json({
      reply: "Something went wrong."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("AXON-AI server running on port " + PORT);
});
      
