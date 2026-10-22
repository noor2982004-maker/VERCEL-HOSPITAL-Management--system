import { Router } from "express";
import { getSchedule, getAvailability, updateSchedule, newgetDoctorScheduleForPatient } from "../controllers/scheduleController.js";
import { protect, authorize } from "../middleware/authMiddleware.js";

const router = Router();

//router.get("/:id/schedule", getSchedule);
router.get("/:id/availability", getAvailability);
router.put("/:id/schedule", protect, authorize("admin"), updateSchedule);
router.get("/:id/schedule",newgetDoctorScheduleForPatient);

export default router;