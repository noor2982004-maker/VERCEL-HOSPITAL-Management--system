import { Router } from "express";
import { getacceptedDoctors, getDoctorById } from "../controllers/doctorController.js";
import{getAllSpecialities
} from"../controllers/specialtyController.js";



const router = Router();

router.get("/", getacceptedDoctors);
router.get("/:id", getDoctorById);
router.get("allspec", getAllSpecialities);

export default router;