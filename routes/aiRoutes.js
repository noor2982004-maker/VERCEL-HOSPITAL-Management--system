import { Router } from "express";
import rateLimit from "express-rate-limit";
import { chatWithAI, getChatResult } from "../controllers/aiController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = Router();

// Each non-emergency message can start a GPU job, so limit per logged-in user.
// Counters live in memory per serverless instance: a guard, not a hard quota.
const limitPerUser = (limit) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    keyGenerator: (req) => String(req.user.id),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { success: false, status: "error", message: "Too many AI requests. Please wait a minute." },
  });

// protect runs first: the same user id must own the job on submit and on poll.
router.post("/chat", protect, limitPerUser(20), chatWithAI);
router.get("/chat/:jobId", protect, limitPerUser(60), getChatResult);

export default router;
