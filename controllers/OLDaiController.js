import axios from 'axios';
import Patient from '../models/user.js';
const aiUrl = process.env.AI_SERVICE_URL 


import { Client } from "@gradio/client";

export const chatWithAI = async (req, res, next) => {
  try {
    const { message } = req.body;
   

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: "Please enter a message",
      });
    }

   

    const aiUrl = process.env.AI_SERVICE_URL || "https://noor8noor-health-care-services-mlbiobert-aimodel-nlp.hf.space";

    const client = await Client.connect(aiUrl);
    
    const result = await client.predict("/predict", [
      message.trim()
    ]);
    const rawReply = result.data;
// If result.data is an array, grab the first element
const textReply = Array.isArray(rawReply) ? rawReply[0] : rawReply;

return res.status(200).json({
  success: true,
  reply: textReply 
});

    //return res.status(200).json({
      //success: true,
      //reply: result.data, // النتيجة الراجعة من النموذج});

  } catch (error) {
    console.error("AI error:", error.message);

    return res.status(503).json({
      success: false,
      message: "AI service is temporarily unavailable",
      error: error.message,
    });
  }
};