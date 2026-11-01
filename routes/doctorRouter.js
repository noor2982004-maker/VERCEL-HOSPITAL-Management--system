import { Router } from "express";
import { getacceptedDoctors, getDoctorById } from "../controllers/doctorController.js";
import{getAllSpecialities} from"../controllers/specialtyController.js";
import {globalSearch} from "../controllers/adminController.js";

const router = Router();
router.get("/mainsearch",globalSearch)
router.get("/allspecialities", getAllSpecialities);
router.get("/", getacceptedDoctors);//all,governorate,today?,specialty
router.get("/:id", getDoctorById);

export default router;