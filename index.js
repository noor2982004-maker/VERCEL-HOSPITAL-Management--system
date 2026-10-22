import "dotenv/config";
import cors from "cors";
import morgan from "morgan";
import mongoose from "mongoose";
import express from "express";

import connectDB from "./config/db.js";

import authRouter from "./routes/authRouter.js";
import adminRouter from "./routes/adminRouter.js";
import patientRouter from "./routes/patientRouter.js";
import appointmentRouter from "./routes/appointmentRoute.js";
import userRouter from "./routes/userRouter.js";
import AIRouter from "./routes/aiRoutes.js";
import insuranceRouter from "./routes/insuranceRoutes.js";
import scheduleRouter from "./routes/scheduleRouter.js";
import reviewRouter from "./routes/reviewRouter.js";
import doctorRouter from "./routes/doctorRouter.js";
import upRouter from "./routes/uploadRouter.js";

import { ErrorHandler } from "./utils/ErrorHandler.js";
import {
  startAppointmentJobs,
  markNoShows,
} from "./jobs/appointmentJobs.js";

const app = express();

// ---------- Middlewares ----------
app.use(cors());
app.use(express.json());

// Handle invalid JSON
app.use((err, req, res, next) => {
  if (
    err instanceof SyntaxError &&
    err.status === 400 &&
    "body" in err
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON format",
    });
  }

  next(err);
});

app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

// Log incoming requests
app.use((req, res, next) => {
  console.log("Incoming request:", req.method, req.originalUrl);
  next();
});

// Ensure req.body is defined
app.use((req, res, next) => {
  if (req.body === undefined) {
    req.body = {};
  }

  next();
});

// ---------- Database connection ----------
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("Database connection error:", err);

    return res.status(503).json({
      success: false,
      message: "Database is temporarily unavailable",
    });
  }
});

// ---------- Health check ----------
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    db:
      mongoose.connection.readyState === 1
        ? "connected"
        : "disconnected",
  });
});

// ---------- Routes ----------
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/appointments", appointmentRouter);
app.use("/api/user", userRouter);
app.use("/api/ai", AIRouter);
app.use("/api/patient", patientRouter);
app.use("/api/insurance", insuranceRouter);

app.use("/api/doctors", reviewRouter);
app.use("/api/doctors", scheduleRouter);
app.use("/api/doctors", doctorRouter);

app.use("/api/up", upRouter);

// ---------- Test route ----------
app.get("/test", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Index works",
  });
});

// ---------- Cron: mark missed appointments ----------
app.get("/api/cron/mark-no-shows", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return res.status(500).json({
      success: false,
      message: "Cron secret is not configured",
    });
  }

  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  try {
    const modifiedCount = await markNoShows();

    return res.status(200).json({
      success: true,
      message: "No-show job completed",
      modifiedCount,
    });
  } catch (error) {
    console.error("No-show cron failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to update missed appointments",
    });
  }
});

// ---------- 404 handler ----------
app.use((req, res, next) => {
  next({
    message: `Route not found: ${req.originalUrl}`,
    statusCode: 404,
  });
});

// ---------- Error handler ----------
app.use(ErrorHandler);

// ---------- Local server only ----------
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;

  connectDB()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Server running on port: ${PORT}`);

        // Run the recurring job locally only.
        startAppointmentJobs();
      });
    })
    .catch((err) => {
      console.error("Failed to start server:", err.message);
    });
}

export default app;
