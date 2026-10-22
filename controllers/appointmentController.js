import mongoose from "mongoose";
import crypto from "node:crypto";
import "../models/user.js";
import "../models/speciality.js";
import Doctor from "../models/doctor.js";
import Appointment from "../models/appointment.js";
import {
  listAppointmentsSchema,
  bookAppointmentSchema,
} from "../validators/appointmentValidator.js";
import { parseDate, isFuture, generateSlots } from "../utils/slots.js";

const BOOKING_PREFIX = "MI3";

const generateReference = () =>
  `${BOOKING_PREFIX}-${crypto.randomInt(10000000, 100000000)}`;

const doctorPopulate = {
  path: "doctor_id",
  select:
    "user_id speciality_id title image clinic_name clinic_address area governorate consultation_fee",
  populate: [
    { path: "user_id", select: "full_name" },
    { path: "speciality_id", select: "name" },
  ],
};

const doctorSummary = (d) =>
  d
    ? {
        id: d._id,
        full_name: d.user_id?.full_name ?? null,
        title: d.title ?? null,
        speciality: d.speciality_id?.name ?? null,
        image: d.image ?? null,
        clinic_name: d.clinic_name ?? null,
        clinic_address: d.clinic_address ?? null,
        area: d.area ?? null,
        governorate: d.governorate ?? null,
        consultation_fee: d.consultation_fee ?? null,
      }
    : null;

const toDto = (a, doctor) => ({
  id: a._id,
  booking_reference: a.booking_reference,
  appointment_date: new Date(a.appointment_date).toISOString().slice(0, 10), // "2026-10-11"
  appointment_time: a.appointment_time,                                      // "17:30"
  status: a.status,
  notes: a.notes ?? null,
  doctor: doctorSummary(doctor),
});

// ---------------- POST /api/appointments/book ----------------

const normalizeAppointmentTime = (time) => {
  if (typeof time !== "string") return time;

  const trimmedTime = time.trim();

  // Keep existing 24-hour format, e.g. 09:00 or 21:00
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmedTime)) {
    return trimmedTime;
  }

  // Convert 12-hour format, e.g. 9:00 AM or 9:00 PM
  const match = trimmedTime.match(
    /^(1[0-2]|0?[1-9]):([0-5]\d)\s*(AM|PM)$/i
  );

  if (!match) return time;

  let hours = Number(match[1]);
  const minutes = match[2];
  const period = match[3].toUpperCase();

  if (period === "AM" && hours === 12) {
    hours = 0;
  } else if (period === "PM" && hours !== 12) {
    hours += 12;
  }

  return `${String(hours).padStart(2, "0")}:${minutes}`;
};




export const bookAppointment = async (req, res, next) => {
  try {
    
const requestBody = {
  ...req.body,
  appointment_time: normalizeAppointmentTime(
    req.body?.appointment_time
  ),
};

const { error, value } = bookAppointmentSchema.validate(requestBody, {
  abortEarly: false,
  stripUnknown: true,
});

    if (error) {
      return next({
        message: error.details.map((d) => d.message).join(", "),
        statusCode: 400,
      });
    }

    const { doctor_id, appointment_date, appointment_time, notes } = value;

    const dateObj = parseDate(appointment_date);
    if (!dateObj) return next({ message: "Invalid appointment date", statusCode: 400 });

    if (!isFuture(appointment_date, appointment_time)) {
      return next({ message: "Appointment must be in the future", statusCode: 400 });
    }

    const doctor = await Doctor.findById(doctor_id)
      .populate("user_id", "full_name")
      .populate("speciality_id", "name")
      .lean();
    if (!doctor || !doctor.is_active) {
      return next({ message: "Doctor not found", statusCode: 404 });
    }

    if (!generateSlots(doctor, appointment_date).includes(appointment_time)) {
      return next({ message: "This time is not available for the doctor", statusCode: 400 });
    }

    const clash = await Appointment.exists({
      patient_id: req.user.id,
      appointment_date: dateObj,
      appointment_time,
      status: "upcoming",
    });
    if (clash) {
      return next({ message: "You already have an appointment at this time", statusCode: 409 });
    }

    let appointment;
    for (let i = 0; i < 5 && !appointment; i++) {
      try {
        appointment = await Appointment.create({
          patient_id: req.user.id,
          doctor_id: doctor._id,
          appointment_date: dateObj,
          appointment_time,
          notes: notes || null,
          booking_reference: generateReference(),
        });
      } catch (err) {
        if (err.code === 11000 && err.keyPattern?.booking_reference) continue; // رقم حجز مكرر، نجرب تاني
        if (err.code === 11000) {
          return next({
            message: "This time slot has just been booked, please choose another one",
            statusCode: 409,
          });
        }
        throw err;
      }
    }
    if (!appointment) {
      return next({ message: "Could not generate a booking reference, try again", statusCode: 500 });
    }

    res.status(201).json({
      success: true,
      message: "Appointment booked successfully",
      data: toDto(appointment, doctor),
    });
  } catch (err) {
    next(err);
  }
};

// ---------------- GET /api/user/appointments?tab= ----------------
export const getMyAppointments = async (req, res, next) => {
  try {
    const { error, value } = listAppointmentsSchema.validate(req.query, { stripUnknown: true });
    if (error) return next({ message: error.details[0].message, statusCode: 400 });

    const { tab, page, limit } = value;

    const filter = {
      patient_id: req.user.id,
      status: tab === "upcoming" ? "upcoming" : { $in: ["completed","missed", "cancelled"] },
    };

    const sort =
      tab === "upcoming"
        ? { appointment_date: 1, appointment_time: 1 }
        : { appointment_date: -1, appointment_time: -1 };

    const [items, total] = await Promise.all([
      Appointment.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate(doctorPopulate)
        .lean(),
      Appointment.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: items.map((a) => toDto(a, a.doctor_id)),
      meta: { page, limit, total, total_pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ---------------- GET /api/appointments/:id ----------------
export const getAppointmentById = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return next({ message: "Invalid appointment id", statusCode: 400 });
    }

    const appointment = await Appointment.findOne({ _id: id, patient_id: req.user.id })
      .populate(doctorPopulate)
      .lean();
    if (!appointment) return next({ message: "Appointment not found", statusCode: 404 });

    res.status(200).json({ success: true, data: toDto(appointment, appointment.doctor_id) });
  } catch (err) {
    next(err);
  }
};

// ---------------- PATCH /api/appointments/:id/cancel ----------------
export const cancelAppointment = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return next({ message: "Invalid appointment id", statusCode: 400 });
    }

    const appointment = await Appointment.findOne({ _id: id, patient_id: req.user.id });
    if (!appointment) return next({ message: "Appointment not found", statusCode: 404 });

    if (appointment.status !== "upcoming") {
      return next({ message: "Only upcoming appointments can be cancelled", statusCode: 400 });
    }

    const dateStr = appointment.appointment_date.toISOString().slice(0, 10);
    if (!isFuture(dateStr, appointment.appointment_time)) {
      return next({ message: "This appointment has already started or passed", statusCode: 400 });
    }

    appointment.status = "cancelled"; 
    await appointment.save();

    res.status(200).json({
      success: true,
      message: "Appointment cancelled successfully",
      data: { id: appointment._id, status: appointment.status },
    });
  } catch (err) {
    next(err);
  }
};