import { Router } from "express";
import {
  bookAppointment,
  getAppointmentById,
  cancelAppointment,
  getMyAppointments
} from "../controllers/appointmentController.js";
import { protect, authorize } from "../middleware/authMiddleware.js";

const router = Router();

router.use(protect, authorize("patient"));

router.post("/book", bookAppointment);
router.get("/:id", getAppointmentById);
router.patch("/:id/cancel", cancelAppointment);
router.get("/",getMyAppointments);
export default router;