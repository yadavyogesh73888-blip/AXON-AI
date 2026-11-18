import Groq from "groq-sdk";

// Groq client initialize karein (environment variable se key uthayega)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function getAiResponse(userMessage) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile", // Ya jo model aap use kar rahe hain
      messages: [
        {
          role: "system",
          content: `You are AXON AI, an intelligent, helpful, and natural conversational assistant developed by Ms Devleoors. 

Guidelines:
- Match the user's language (English, Hindi, or Hinglish).
- Keep responses natural, conversational, and direct. Avoid robotic or overly scripted replies.
- Provide short answers for simple questions and clear, easy-to-understand explanations for complex topics.
- Maintain context from the ongoing conversation. Be honest if you do not know something.`
        },
        {
          role: "user",
          content: userMessage.trim()
        }
      ],
      temperature: 0.7,
      max_tokens: 1024,
    });

    return chatCompletion.choices[0]?.message?.content || "Mujhe samajh nahi aaya, kripya dobara kahein.";
  } catch (error) {
    console.error("AI Response Error:", error);
    return "Maaf kijiye, abhi system mein kuch technical dikkat aa rahi hai. Kripya thodi der baad koshish karein.";
  }
}

export { getAiResponse };
