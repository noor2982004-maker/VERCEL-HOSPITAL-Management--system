import bcrypt from "bcryptjs";
import User from "../models/user.js";
import {createAdminSchema,} from "../validators/authValidator.js";
import Dr from "../models/doctor.js";
import Speciality from "../models/speciality.js";
import { updateScheduleSchema } from "../validators/scheduleValidator.js";
import { scheduleSummary } from "../utils/slots.js";
import cloudinary from "../config/cloudinary.js";
import DoctorDocument from "../models/documents_dr_images.js";
import { handleDoctorFilesUpload } from "../middleware/upload.js";
import { parseDate, isFuture, generateSlots, cairoNow } from "../utils/slots.js";

import Review from "../models/review.js";
import Appointment from "../models/appointment.js";
import { listReviewsSchema, addReviewSchema } from "../validators/reviewValidator.js";
import MedicalInsurance from "../models/medicalInsurance.js";








import mongoose from "mongoose";

export const completeAppointment = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return next({
        message: "Invalid appointment id",
        statusCode: 400,
      });
    }

    const appointment = await Appointment.findById(id);

    if (!appointment) {
      return next({
        message: "Appointment not found",
        statusCode: 404,
      });
    }

    if (appointment.status !== "upcoming") {
      return next({
        message: "Only upcoming appointments can be completed",
        statusCode: 400,
      });
    }

    appointment.status = "completed";
    await appointment.save();

    return res.status(200).json({
      success: true,
      message: "Appointment marked as completed",
      data: {
        appointment_id: appointment._id,
        status: appointment.status,
      },
    });
  } catch (err) {
    next(err);
  }
};








export const getAppointmentsForAdmin = async (req, res, next) => {
  try {
    const { status, search } = req.query;

    // الحالات المسموح بالفلترة حسبها
    const allowedStatuses = ["upcoming", "completed", "missed"];

    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status. Use upcoming, completed, or missed",
      });
    }

    const filter = status ? { status } : {};

    // إذا تم إرسال كلمة بحث (اسم أو إيميل المريض)
    if (search && search.trim() !== "") {
      // 1. البحث عن المرضى الذين يتطابق الاسم أو الإيميل مع نص البحث
      const matchingPatients = await User.find({
        role: "patient",
        $or: [
          { full_name: { $regex: search.trim(), $options: "i" } },
          { email: { $regex: search.trim(), $options: "i" } }
        ]
      }).select("_id");

      const patientIds = matchingPatients.map((p) => p._id);

      // 2. قصر المواعيد المسترجعة على هؤلاء المرضى فقط
      filter.patient_id = { $in: patientIds };
    }

    const appointments = await Appointment.find(filter)
      .sort({ appointment_date: -1, appointment_time: -1 })
      .populate({
        path: "patient_id",
        select: "full_name email avatar",
      })
      .populate({
        path: "doctor_id",
        populate: [
          {
            path: "user_id",
            select: "full_name",
          },
          {
            path: "speciality_id",
          },
        ],
      })
      .lean();

    const data = appointments.map((appointment) => {
      const doctor = appointment.doctor_id;
      const patient = appointment.patient_id;

      return {
        appointment_id: appointment._id,

        patient_image: patient?.avatar ?? null,

        patient_name: patient?.full_name ?? null,
        //patient_email: patient?.email ?? null,

        doctor_name: doctor?.user_id?.full_name ?? null,

        specialty: doctor?.speciality_id?.name ?? null,

        appointment_date: appointment.appointment_date
          ? new Date(appointment.appointment_date).toISOString().split("T")[0]
          : null,

        appointment_time: appointment.appointment_time,

        appointment_status: appointment.status,
      };
    });

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (err) {
    next(err);
  }
};












const generateTimeSlots = (
  startTime,
  endTime,
  breakStart,
  breakEnd,
  slotDurationMinutes
) => {
  const toMinutes = (time) => {
    if (!time) return null;

    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  };

  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  const breakFrom = toMinutes(breakStart);
  const breakTo = toMinutes(breakEnd);

  if (
    start === null ||
    end === null ||
    end <= start ||
    !Number.isFinite(slotDurationMinutes) ||
    slotDurationMinutes <= 0
  ) {
    return [];
  }

  const slots = [];

  for (
    let time = start;
    time + slotDurationMinutes <= end;
    time += slotDurationMinutes
  ) {
    const slotEnd = time + slotDurationMinutes;

    // Skip slots that overlap the break
    if (
      breakFrom !== null &&
      breakTo !== null &&
      time < breakTo &&
      slotEnd > breakFrom
    ) {
      continue;
    }

    const formatTime = (minutes) => {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;

      return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
    };

    slots.push({
      start_time: formatTime(time),
      end_time: formatTime(slotEnd),
    });
  }

  return slots;
};

















export const acceptDoctor = async (req, res, next) => {
  try {
    const { id } = req.params;

    const dr = await Dr.findById(id).populate({
      path: "user_id",
      select: "full_name",
    });

    if (!dr) {
      return next({
        message: "Doctor not found",
        statusCode: 404,
      });
    }

    if (dr.approval_status === "accepted") {
      return res.status(400).json({
        success: false,
        message: "Doctor is already accepted",
      });
    }

    dr.approval_status = "accepted";
    dr.is_active = true;

    await dr.save();

    return res.status(200).json({
      success: true,
      message: `Dr. ${dr.user_id?.full_name || "Doctor"} has been accepted`,
    });
  } catch (err) {
    next(err);
  }
};






export const cancellDoctor = async (req, res, next) => {
  try {
    const { id } = req.params;

    const dr = await Dr.findById(id).populate({
      path: "user_id",
      select: "full_name",
    });

    if (!dr) {
      return next({
        message: "Doctor not found",
        statusCode: 404,
      });
    }

    if (dr.approval_status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Doctor is already cancelled",
      });
    }

    dr.approval_status = "cancelled";
    dr.is_active = false;

    await dr.save();

    return res.status(200).json({
      success: true,
      message: `Dr. ${dr.user_id?.full_name || "Doctor"} has been cancelled`,
    });
  } catch (err) {
    next(err);
  }
};




















export const activateDoctor = async (req, res, next) => {
  try {
    const { id } = req.params;
    const dr = await Dr.findById(id);

    if (!dr) return next({ message: "Doctor not found", statusCode: 404 });

    if (dr.is_active === true) {
      return res.status(400).json({ success: false, message: "Doctor is already active" });
    }

    dr.is_active = true;
    await dr.save();

    res.status(200).json({ success: true, message: `Dr. ${dr.user_id?.full_name} is now active` });
  } catch (err) {
    next(err);
  }
};


export const deactivateDoctor = async (req, res, next) => {
  try {
    const { id } = req.params;
    const dr = await Dr.findById(id);

    if (!dr) return next({ message: "Doctor not found", statusCode: 404 });


    if (dr.is_active === false) {
      return res.status(400).json({ success: false, message: "Doctor is already deactivated" });
    }

    dr.is_active = false;
    await dr.save();

    res.status(200).json({ success: true, message: `Dr. ${dr.user_id?.full_name} is now deactivated`});
  } catch (err) {
    next(err);
  }
};



export const deleteDr = async (req, res, next) => {
  try {
    const { id } = req.params;
    const dr = await Dr.findByIdAndDelete(id);

    if (!dr) {
      return next({ message: "Doctor not found", statusCode: 404 });
    }

    res.json({
      success: true,
      message: "Doctor deleted successfully"
    });
  } catch (err) {
    next(err);
  }
};



export const createAdmin = async (req, res, next) => {
  try {
    const { error, value } = createAdminSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return next({
        message: error.details.map((d) => d.message).join(", "),
        statusCode: 400,
      });
    }

    const exists = await User.findOne({
      email: value.email.toLowerCase(),
    });

    if (exists) {
      return next({
        message: "Email already registered",
        statusCode: 409,
      });
    }

    const hashed = await bcrypt.hash(value.password, 12);

    const admin = await User.create({
      ...value,
      password: hashed,
      role: "admin",
    });

    res.status(201).json({
      success: true,
      message: "Admin created successfully",
      data: {
        id: admin._id,
        full_name: admin.full_name,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return next({
        message: "Email already registered",
        statusCode: 409,
      });
    }

    next(err);
  }
};








export const admingetDoctors = async (req, res, next) => {
  try {
    const {
      approval_status,
      is_active,
      speciality_id,
      governorate
    } = req.query;

    const filter = {};

if (approval_status) {
  filter.approval_status = approval_status;
}

if (is_active === "true") {
  filter.is_active = true;
}

if (is_active === "false") {
  filter.is_active = false;
}

    
    if (speciality_id) {
      filter.speciality_id = speciality_id;
    }

   
    if (governorate) {
      filter.governorate = governorate;
    }

    const doctors = await Dr.find(filter)
      .populate("user_id", "full_name email")
      .populate("speciality_id", "name")
      .select(
        "user_id speciality_id title image consultation_fee rating_average area governorate is_active approval_status schedule slot_duration_minutes"
      )
      .sort({ rating_average: -1 });

    const result = doctors.map((doctor) => ({
      doctor_id: doctor._id,
      name: doctor.user_id?.full_name,
      email: doctor.user_id?.email,
      speciality: doctor.speciality_id?.name,
      image: doctor.image,
      rating: doctor.rating_average,
      is_active: doctor.is_active,
      approval_status: doctor.approval_status,
      schedule: scheduleSummary(doctor),
      
    }));

    res.status(200).json({
      success: true,
      count: result.length,
      data: result
    });

  } catch (err) {
    next(err);
  }
};















export const createManyDoctors = async (req, res, next) => {
  try {
    const doctors = req.body;

    if (!Array.isArray(doctors) || doctors.length === 0) {
      return next({
        message: "Please send an array of doctors",
        statusCode: 400
      });
    }

    const createdDoctors = [];

    for (const doctorData of doctors) {
      const {
        full_name,
        email,
        password,
        phone,
        speciality_id,
        title,
        bio,
        education_and_qualifications,
        clinic_address,
        consultation_fee,
        years_of_experience,
        clinic_name,
        area,
        governorate,
        //clinic_phone,
        //languages,
        //license_number,
        location,
        schedule,
        slot_duration_minutes
      } = doctorData;

      if (!full_name || !email || !password || !speciality_id) {
        continue;
      }
            let scheduleData;
      if (schedule) {
        const { error, value } = updateScheduleSchema.validate(
          { ...schedule, slot_duration_minutes },
          { stripUnknown: true }
        );
        if (error) continue;

        scheduleData = {
          working_days: [...value.working_days].sort((a, b) => a - b),
          start_time: value.start_time,
          end_time: value.end_time,
          break_start: value.break_start ?? null,
          break_end: value.break_end ?? null,
        };
      }
      const speciality = await Speciality.findById(speciality_id);

      if (!speciality) {
        continue;
      }

      const existingUser = await User.findOne({
        email: email.toLowerCase()
      });

      if (existingUser) {
        continue;
      }

      //if (license_number) {
       // const existingDoctor = await Dr.findOne({
       //   license_number
       // });

       // if (existingDoctor) {
          //continue;
       // }
      //}

      const hashedPassword = await bcrypt.hash(password, 12);

      const user = await User.create({
        full_name,
        email: email.toLowerCase(),
        phone,
        password: hashedPassword,
        role: "doctor"
      });

      const doctor = await Dr.create({
        user_id: user._id,
        speciality_id: speciality._id,
        title,
        bio,
        education_and_qualifications,
        clinic_address,
        consultation_fee,
        years_of_experience,
        clinic_name,
        area,
        governorate,
        //clinic_phone,
       // languages,
       // license_number,
        location,
        schedule: scheduleData,
        slot_duration_minutes,
        approval_status: "pending",
        is_active: false
      });

      createdDoctors.push({
        doctor_id: doctor._id,
        user_id: user._id,
        full_name: user.full_name,
        email: user.email,
        speciality: speciality.name
      });
    }

    res.status(201).json({
      success: true,
      message: "Doctors created successfully",
      count: createdDoctors.length,
      data: createdDoctors
    });

  } catch (err) {
    next(err);
  }
};








const uploadDoctorFile = (file, folder) =>
  new Promise((resolve, reject) => {
    const isPdf = file.mimetype === "application/pdf";
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: isPdf ? "raw" : "image" },
      (error, result) => error ? reject(error) : resolve(result)
    );
    stream.end(file.buffer);
  });









export const createDoctorbyform = async (req, res, next) => {
  const uploadedFiles = [];
  let userId, doctorId;

  try {
    const {
      full_name, email, password, phone,
      //gender,
      speciality_id,
      title, bio, education_and_qualifications, clinic_address,
      consultation_fee, years_of_experience, clinic_name, area,
      governorate, location, schedule, slot_duration_minutes
      //clinic_phone,
      //languages,
      //license_number,
    } = req.body;

    const image = req.files?.image?.[0];
    const certificates = req.files?.certificates || [];

    if (!full_name || !email || !password || !speciality_id) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (!image || certificates.length < 2) {
      return res.status(400).json({
        message: "Profile image and at least two certificates are required"
      });
    }

    const parsedSchedule = typeof schedule === "string"
      ? JSON.parse(schedule) : schedule;
    const parsedLocation = typeof location === "string"
      ? JSON.parse(location) : location;

    let scheduleData;
    if (parsedSchedule) {
      const { error, value } = updateScheduleSchema.validate(
        { ...parsedSchedule, slot_duration_minutes },
        { stripUnknown: true }
      );
      if (error) {
        return res.status(400).json({ message: error.message });
      }

      scheduleData = {
        working_days: [...value.working_days].sort((a, b) => a - b),
        start_time: value.start_time,
        end_time: value.end_time,
        break_start: value.break_start ?? null,
        break_end: value.break_end ?? null,
      };
    }

    const speciality = await Speciality.findById(speciality_id);
    if (!speciality) {
      return res.status(400).json({ message: "Speciality not found" });
    }

    const existingUser = await User.findOne({
      email: email.toLowerCase()
    });
    if (existingUser) {
      return res.status(409).json({ message: "Email already exists" });
    }

    //if (license_number) {
    //  const existingDoctor = await Dr.findOne({ license_number });
    //  if (existingDoctor) {
    //    return res.status(409).json({ message: "License already exists" });
    //  }
    //}

    const profileUpload = await uploadDoctorFile(image, "doctors/profiles");
    uploadedFiles.push({
      public_id: profileUpload.public_id,
      resource_type: "image"
    });

    const uploadedCertificates = [];
    for (const file of certificates) {
      const result = await uploadDoctorFile(file, "doctors/certificates");
      uploadedFiles.push({
        public_id: result.public_id,
        resource_type: file.mimetype === "application/pdf" ? "raw" : "image"
      });
      uploadedCertificates.push({
        file_name: file.originalname,
        file_url: result.secure_url,
        file_public_id: result.public_id,
        uploaded_by_role: "admin"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await User.create({
      full_name,
      email: email.toLowerCase(),
      phone,
      password: hashedPassword,
      //gender,
      //governorate,
      role: "doctor"
    });
    userId = user._id;

    const doctor = await Dr.create({
      user_id: user._id,
      speciality_id: speciality._id,
      title,
      bio,
      education_and_qualifications,
      clinic_address,
      consultation_fee,
      years_of_experience,
      clinic_name,
      area,
      governorate,
      image: profileUpload.secure_url,
      //clinic_phone,
      //languages,
      //license_number,
      location: parsedLocation,
      schedule: scheduleData,
      slot_duration_minutes,
      approval_status: "pending",
      is_active: false
    });
    doctorId = doctor._id;

    const documents = uploadedCertificates.map(doc => ({
      ...doc,
      doctor_id: doctor._id
    }));

    await DoctorDocument.insertMany(documents);

    return res.status(201).json({
      success: true,
      message: "Doctor created successfully",
      data: {
        doctor_id: doctor._id,
        user_id: user._id,
        full_name: user.full_name,
        email: user.email,
        speciality: speciality.name,
        image: doctor.image,
        certificates: documents
      }
    });
  } catch (err) {
    try {
      if (doctorId) {
        await DoctorDocument.deleteMany({ doctor_id: doctorId });
        await Dr.findByIdAndDelete(doctorId);
      }
      if (userId) await User.findByIdAndDelete(userId);

      await Promise.allSettled(
        uploadedFiles.map(file =>
          cloudinary.uploader.destroy(file.public_id, {
            resource_type: file.resource_type
          })
        )
      );
    } catch (cleanupError) {
      console.error("Doctor creation cleanup failed:", cleanupError);
    }

    next(err);
  }
};






const formatDate = (date) => {
  if (!date) return null;

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(date));
};

const formatDateTime = (date) => {
  if (!date) return null;

  const dateObject = new Date(date);

  return {
    date: formatDate(dateObject),
    time: new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Cairo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(dateObject),
  };
};





export const getDrJoinRequests = async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 7 } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const allowedStatuses = ["pending", "require_edits"];

    let statuses = allowedStatuses;

    // Filter by one status if requested
    if (status) {
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid status. Use pending or require_edits.",
        });
      }

      statuses = [status];
    }

    const filter = {
      approval_status: { $in: statuses },
    };

    // البحث المرن: إذا كتب المستخدم 3 أحرف أو أكثر في خانة البحث (الاسم أو الإيميل)
    if (search && search.trim().length >= 3) {
      const searchRegex = new RegExp(search.trim(), "i"); // بحث مرن لا يفرق بين الحروف الكبيرة والصغيرة

      // 1. البحث عن المستخدمين الذين دورهم "doctor" ويتطابق الاسم أو الإيميل مع النص
      const matchingUsers = await User.find({
        role: "doctor",
        $or: [
          { full_name: { $regex: searchRegex } },
          { email: { $regex: searchRegex } }
        ]
      }).select("_id");

      const userIds = matchingUsers.map((u) => u._id);

      // إذا لمطابق أي طبيب، نرجع نتيجة فارغة فوراً لكي تتأكد أن البحث يعمل
      if (userIds.length === 0) {
        return res.status(200).json({
          success: true,
          count: 0,
          meta: {
            page: pageNum,
            limit: limitNum,
            total: 0,
            total_pages: 0,
          },
          data: [],
        });
      }

      filter.user_id = { $in: userIds };
    }

    const [doctors, total] = await Promise.all([
      Dr.find(filter)
        .populate({
          path: "user_id",
          select: "full_name email created_at",
        })
        .populate({
          path: "speciality_id",
          select: "name",
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Dr.countDocuments(filter),
    ]);

    const requests = doctors
      .filter((doctor) => doctor.user_id)
      .map((doctor) => ({
        doctor_id: doctor._id,
        image: doctor.image,
        name: doctor.user_id.full_name,
        speciality: doctor.speciality_id?.name ?? null,
        email: doctor.user_id.email,
        created_at: formatDate(doctor.user_id.created_at),
        account_status: doctor.approval_status,
      }));

    return res.status(200).json({
      success: true,
      count: requests.length,
      meta: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
      },
      data: requests,
    });
  } catch (err) {
    next(err);
  }
};









export const getDrByIdForAdmin = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Search using Doctor ID first, then User ID
    let doctor = await Dr.findById(id)
      .populate({
        path: "user_id",
        select: "full_name email phone created_at",
      })
      .populate({
        path: "speciality_id",
        select: "name",
      })
      .lean();

    // If not found by Doctor ID, search using User ID
    if (!doctor) {
      doctor = await Dr.findOne({ user_id: id })
        .populate({
          path: "user_id",
          select: "full_name email phone created_at",
        })
        .populate({
          path: "speciality_id",
          select: "name",
        })
        .lean();
    }

    if (!doctor || !doctor.user_id) {
      return res.status(404).json({
        success: false,
        message: "Doctor not found",
      });
    }

    const documents = await DoctorDocument.find({
      doctor_id: doctor._id,
    })
      .select(
        "file_name file_url"
      )
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        doctor_id: doctor._id,
        user_id: doctor.user_id._id,

        image: doctor.image,
        name: doctor.user_id.full_name,
        title: doctor.title,
        email: doctor.user_id.email,
        phone: doctor.user_id.phone,

        speciality: doctor.speciality_id?.name ?? null,

        years_of_experience: doctor.years_of_experience,
        clinic_address: doctor.clinic_address,
        clinic_name: doctor.clinic_name,
        education_and_qualifications:
          doctor.education_and_qualifications,
        bio: doctor.bio,
        consultation_fee: doctor.consultation_fee,
        slot_duration_minutes: doctor.slot_duration_minutes,

        approval_status: doctor.approval_status,
        is_active: doctor.is_active,

        account_created_at: formatDateTime(
          doctor.user_id.created_at
        ),


        documents: documents.map((doc) => ({
          document_id: doc._id,
          file_name: doc.file_name,
          file_url: doc.file_url,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};










export const getPendingDoctorUploadedDocuments = async ( req, res,next) => {
  try {
    const allowedStatuses = ["pending", "require_edits"];

    // Find doctors whose accounts still require review
    const doctors = await Dr.find({
      approval_status: { $in: allowedStatuses },
    })
      .select("_id user_id image approval_status")
      .populate({
        path: "user_id",
        select: "full_name",
      })
      .lean();

    const eligibleDoctors = doctors.filter(
      (doctor) => doctor.user_id
    );

    const doctorIds = eligibleDoctors.map(
      (doctor) => doctor._id
    );

    // Only documents uploaded by doctors themselves
    const documents = await DoctorDocument.find({
      doctor_id: { $in: doctorIds },
      uploaded_by_role: "doctor",
    })
      .select(
        "doctor_id file_name file_url createdAt uploaded_by_role"
      )
      .sort({ createdAt: -1 })
      .lean();

    const doctorMap = new Map(
      eligibleDoctors.map((doctor) => [
        String(doctor._id),
        {
          doctor_id: doctor._id,
          doctor_name: doctor.user_id.full_name,
          doctor_image: doctor.image,
          approval_status: doctor.approval_status,
        },
      ])
    );

    const data = documents.map((doc) => {
      const doctor = doctorMap.get(
        String(doc.doctor_id)
      );

      return {
        doctor_id: doctor.doctor_id,
        doctor_name: doctor.doctor_name,
        doctor_image: doctor.doctor_image,
        approval_status: doctor.approval_status,

        document_id: doc._id,
        document_name: doc.file_name,
        document_date: formatDate(doc.createdAt),
        document_link: doc.file_url,
        uploaded_by_role: doc.uploaded_by_role,
      };
    });

    // Count doctors who have at least one matching document
    const doctorsWithDocuments = new Set(
      documents.map((doc) => String(doc.doctor_id))
    );

    const pendingDoctorsWithDocuments = new Set(
      eligibleDoctors
        .filter(
          (doctor) => doctor.approval_status === "pending"
        )
        .filter((doctor) =>
          documents.some(
            (doc) =>
              String(doc.doctor_id) === String(doctor._id)
          )
        )
        .map((doctor) => String(doctor._id))
    );

    const needsEditsDoctorsWithDocuments = new Set(
      eligibleDoctors
        .filter(
          (doctor) =>
            doctor.approval_status === "require_edits"
        )
        .filter((doctor) =>
          documents.some(
            (doc) =>
              String(doc.doctor_id) === String(doctor._id)
          )
        )
        .map((doctor) => String(doctor._id))
    );

    return res.status(200).json({
      success: true,

      counts: {
        total_documents: documents.length,
        //total_doctors_with_documents:doctorsWithDocuments.size,
        //pending_doctors_with_documents:pendingDoctorsWithDocuments.size,
        //needs_edits_doctors_with_documents:needsEditsDoctorsWithDocuments.size,
      },

      count: data.length,
      data,
    });
  } catch (err) {
    next(err);
  }
};




















export const getDoctorScheduleForPatient = async (
  req,
  res,
  next
) => {
  try {
    const { id } = req.params;

    const doctor = await Dr.findById(id)
      .populate({
        path: "user_id",
        select: "full_name",
      })
      .lean();

    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: "Doctor not found",
      });
    }

    if (
      doctor.approval_status !== "accepted" ||
      doctor.is_active !== true
    ) {
      return res.status(404).json({
        success: false,
        message: "Doctor is not available for booking",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        doctor_id: doctor._id,
        doctor_name: doctor.user_id?.full_name ?? null,

        // Return the complete stored schedule for debugging
        schedule: doctor.schedule ?? null,
        slot_duration_minutes:
          doctor.slot_duration_minutes ?? null,
        days_off: doctor.days_off ?? [],

        // Temporary debugging fields
        debug_schedule: doctor.schedule,
      },
    });
  } catch (err) {
    next(err);
  }
};










export const updateDoctorSchedule = async (req, res, next) => {
  try {
    const { id } = req.params;

    const {
      schedule,
      slot_duration_minutes,
    } = req.body;

    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
      return res.status(400).json({
        success: false,
        message: "schedule must be a JSON object",
      });
    }

    const allowedDays = [0, 1, 2, 3, 4, 5, 6];

    if (
      !Array.isArray(schedule.working_days) ||
      schedule.working_days.some(
        (day) => !Number.isInteger(day) || !allowedDays.includes(day)
      ) ||
      new Set(schedule.working_days).size !== schedule.working_days.length
    ) {
      return res.status(400).json({
        success: false,
        message: "working_days must contain unique numbers from 0 to 6",
      });
    }

    const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

    const { start_time, end_time, break_start, break_end } = schedule;

    if (schedule.working_days.length > 0) {
      if (
        !TIME_REGEX.test(start_time || "") ||
        !TIME_REGEX.test(end_time || "")
      ) {
        return res.status(400).json({
          success: false,
          message: "Valid start_time and end_time are required",
        });
      }

      if (start_time >= end_time) {
        return res.status(400).json({
          success: false,
          message: "end_time must be after start_time",
        });
      }

      if (
        (break_start && !break_end) ||
        (!break_start && break_end)
      ) {
        return res.status(400).json({
          success: false,
          message: "break_start and break_end must be provided together",
        });
      }

      if (break_start || break_end) {
        if (
          !TIME_REGEX.test(break_start || "") ||
          !TIME_REGEX.test(break_end || "")
        ) {
          return res.status(400).json({
            success: false,
            message: "Break times must use HH:mm format",
          });
        }

        if (
          break_start >= break_end ||
          break_start < start_time ||
          break_end > end_time
        ) {
          return res.status(400).json({
            success: false,
            message: "Break must be within working hours",
          });
        }
      }
    }

    const duration = slot_duration_minutes ?? 30;

    if (
      !Number.isInteger(duration) ||
      duration < 5 ||
      duration > 240
    ) {
      return res.status(400).json({
        success: false,
        message: "slot_duration_minutes must be an integer from 5 to 240",
      });
    }

    const doctor = await Dr.findByIdAndUpdate(
      id,
      {
        $set: {
          schedule: {
            working_days: schedule.working_days,
            start_time: start_time || undefined,
            end_time: end_time || undefined,
            break_start: break_start || null,
            break_end: break_end || null,
          },
          slot_duration_minutes: duration,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    )
      .select("_id schedule slot_duration_minutes")
      .lean();

    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: "Doctor not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Doctor schedule updated successfully",
      data: doctor,
    });
  } catch (err) {
    next(err);
  }
};









export const hideReview = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return next({
        message: "Invalid review id",
        statusCode: 400,
      });
    }

    const review = await Review.findByIdAndUpdate(
      id,
      { $set: { is_visible: false } },
      { new: true }
    );

    if (!review) {
      return next({
        message: "Review not found",
        statusCode: 404,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Review hidden successfully",
      data: {
        review_id: review._id,
        is_visible: false,
      },
    });
  } catch (err) {
    next(err);
  }
};






export const getAllReviewsForAdmin = async (req, res, next) => {
  try {
    const { error, value } = listReviewsSchema.validate(req.query, {
      stripUnknown: true,
    });

    if (error) {
      return next({
        message: error.details[0].message,
        statusCode: 400,
      });
    }

    const { page = 1, limit = 7 } = value;
    const searchQuery = req.query.search;

    let reviewFilter = {};

    // البحث باسم أو بريد الطبيب (إذا تم إدخال 3 أحرف أو أكثر)
    if (searchQuery && searchQuery.trim().length >= 3) {
      const searchRegex = new RegExp(searchQuery.trim(), "i");

      // 1. البحث عن الأطباء في جدول User
      const matchingUsers = await User.find({
        role: "doctor",
        $or: [
          { full_name: { $regex: searchRegex } },
          { email: { $regex: searchRegex } }
        ]
      }).select("_id");

      const userIds = matchingUsers.map((u) => u._id);

      // 2. الحصول على _id الخاص بالأطباء من جدول Dr
      const matchingDoctors = await Dr.find({ user_id: { $in: userIds } }).select("_id");
      const doctorIds = matchingDoctors.map((d) => d._id);

      // إذا لم ينطبق البحث على أي طبيب، نرجع نتيجة فارغة فوراً
      if (doctorIds.length === 0) {
        return res.status(200).json({
          success: true,
          data: [],
          meta: {
            page,
            limit,
            total: 0,
            total_pages: 0,
          },
        });
      }

      reviewFilter.doctor_id = { $in: doctorIds };
    }

    const [reviews, total] = await Promise.all([
      Review.find(reviewFilter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({
          path: "patient_id",
          select: "full_name",
        })
        .populate({
          path: "doctor_id",
          select: "image user_id",
          populate: {
            path: "user_id",
            select: "full_name email",
          },
        })
        .lean(),

      Review.countDocuments(reviewFilter),
    ]);

    const data = reviews.map((review) => ({
      review_id: review._id,

      doctor_id: review.doctor_id?._id ?? null,

      doctor_name:
        review.doctor_id?.user_id?.full_name ?? null,

      doctor_image:
        review.doctor_id?.image ?? null,

      patient_name: review.patient_id?.full_name
        ? review.patient_id.full_name.trim().split(/\s+/)[0]
        : null,

      rating: review.rating,

      comment: review.comment ?? "",

      created_date: review.created_at
        ? new Date(review.created_at).toISOString().split("T")[0]
        : null,

      created_time: review.created_at
        ? new Date(review.created_at).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
            timeZone: "Africa/Cairo",
          })
        : null,

      is_visible: review.is_visible !== false,
    }));

    return res.status(200).json({
      success: true,
      data,
      meta: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
};











export const getAllPatients = async (req, res, next) => {
  try {
    const { search } = req.query; // استقبال كلمة البحث (اسم المريض أو الإيميل)

    const matchStage = { role: "patient" };

    // إذا قام المسؤول بكتابة نص في خانة البحث
    if (search && search.trim() !== "") {
      matchStage.$or = [
        { full_name: { $regex: search.trim(),$options: "i" } },
        { email: { $regex: search.trim(),$options: "i" } }
      ];
    }

    const patients = await User.aggregate([
      {
        $match: matchStage,
      },

      // Count appointments and get the latest appointment date and time
      {
        $lookup: {
          from: "appointments",
          let: { patientId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {$eq: ["$patient_id", "$$patientId"] },
              },
            },
            {
              $sort: { appointment_date: -1, appointment_time: -1, }, }, {$group: {
                _id: null,
                appointments_count: { $sum: 1 },
                last_appointment_date: {
                  $first: "$appointment_date",
                },
                last_appointment_time: {
                  $first: "$appointment_time",
                },
              },
            },
          ],
          as: "appointment_stats",
        },
      },

      // Get patient insurance
      {
        $lookup: {
          from: "medicalinsurances",
          localField: "_id",
          foreignField: "patient_id",
          as: "insurance",
        },
      },

      {
        $project: {
          _id: 0,
          patient_id: "$_id",
          patient_image: "$avatar",
          patient_name: "$full_name",
          patient_email: "$email",
          created_at: 1,

          appointments_count: {
            $ifNull: [
              {
                $arrayElemAt: [
                  "$appointment_stats.appointments_count",
                  0,
                ],
              },
              0,
            ],
          },

          last_appointment_date: {
            $arrayElemAt: [
              "$appointment_stats.last_appointment_date",
              0,
            ],
          },

          last_appointment_time: {
            $arrayElemAt: [
              "$appointment_stats.last_appointment_time",
              0,
            ],
          },

          insurance_company: {
            $ifNull: [
              {
                $arrayElemAt: [
                  "$insurance.insurance_company",
                  0,
                ],
              },
              "no insurance",
            ],
          },
        },
      },

      { $sort: { created_at: -1 } },
    ]);

    const data = patients.map((patient) => {
      let lastAppointment = 0;

      if (
        patient.last_appointment_date &&
        patient.last_appointment_time
      ) {
        const d = new Date(patient.last_appointment_date);

        const date = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;

        lastAppointment = `${date} ${patient.last_appointment_time}`;
      }

      let createdAt = null;

      if (patient.created_at) {
        const d = new Date(patient.created_at);

        createdAt = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
      }

      return {
        ...patient,
        created_at: createdAt,
        last_appointment_date: lastAppointment,
        appointments_count: patient.appointments_count ?? 0,
      };
    });

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (err) {
    next(err);
  }
};
















export const getAdminDashboardCounts = async (req, res, next) => {
  try {
    const [
      pendingDoctors,
      acceptedDoctors,
      totalPatients,
      appointmentCounts,
      totalPendingDoctorDocuments,
    ] = await Promise.all([
      // Doctors awaiting review
      Dr.countDocuments({ approval_status: "pending" }),

      // Accepted doctors
      Dr.countDocuments({ approval_status: "accepted" }),

      // Patient accounts only
      User.countDocuments({ role: "patient" }),

      // Appointment counts, excluding cancelled
      Appointment.aggregate([
        {
          $match: {
            status: { $in: ["upcoming", "completed", "missed"] },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: {
              $sum: {
                $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
              },
            },
            upcoming: {
              $sum: {
                $cond: [{ $eq: ["$status", "upcoming"] }, 1, 0],
              },
            },
            missed: {
              $sum: {
                $cond: [{ $eq: ["$status", "missed"] }, 1, 0],
              },
            },
          },
        },
      ]),

      // Documents uploaded by doctors whose accounts need review
      DoctorDocument.countDocuments({
        uploaded_by_role: "doctor",
        doctor_id: {
          $in: await Dr.find({
            approval_status: { $in: ["pending", "require_edits"] },
          }).distinct("_id"),
        },
      }),
    ]);

    const appointments = appointmentCounts[0] || {
      total: 0,
      completed: 0,
      upcoming: 0,
      missed: 0,
    };

    const attendancePercentage =
      appointments.total === 0
        ? 0
        : Number(
            ((appointments.completed / appointments.total) * 100).toFixed(2)
          );

    return res.status(200).json({
      success: true,
      counts: {
        new_doctor_join_requests: pendingDoctors,
        doctor_documents_need_review: totalPendingDoctorDocuments,
      total_appointments: appointments.total,
        accepted_doctors: acceptedDoctors,
        total_patients: totalPatients,

        //completed_appointments: appointments.completed,
        //upcoming_appointments: appointments.upcoming,
        //missed_appointments: appointments.missed,

        attendance_percentage: attendancePercentage,

        
      },
    });
  } catch (err) {
    next(err);
  }
};















//circle chart
export const getAppointmentStatusStats = async (req, res, next) => {
  try {
    const { period = "all" } = req.query;

    const allowedPeriods = ["all", "today", "last7days", "last30days"];

    if (!allowedPeriods.includes(period)) {
      return res.status(400).json({
        success: false,
        message: "Period must be all, today, last7days, or last30days",
      });
    }

    // Get today's date in Cairo
    const now = new Date();

    const cairoDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);

    const [year, month, day] = cairoDate.split("-").map(Number);

    // Start of today in Cairo, represented as a UTC timestamp
    const todayStart = new Date(
      Date.UTC(year, month - 1, day) -
        2 * 60 * 60 * 1000
    );

    // Cairo is UTC+2 in winter and UTC+3 during daylight saving time.
    // Calculate the exact Cairo midnight using its formatted date.
    const getCairoMidnight = (y, m, d) => {
      const target = new Date(Date.UTC(y, m - 1, d));
      const formatted = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Cairo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(target);

      const [fy, fm, fd] = formatted.split("-").map(Number);

      // Find the UTC timestamp corresponding to Cairo midnight.
      const approximate = Date.UTC(y, m - 1, d);
      const offsetText = new Intl.DateTimeFormat("en-US", {
        timeZone: "Africa/Cairo",
        timeZoneName: "longOffset",
        hour: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(approximate))
        .find((part) => part.type === "timeZoneName")?.value;

      const match = offsetText?.match(/GMT([+-])(\d{2}):?(\d{2})/);
      const offsetMinutes = match
        ? (match[1] === "-" ? -1 : 1) *
          (Number(match[2]) * 60 + Number(match[3]))
        : 120;

      return new Date(Date.UTC(fy, fm - 1, fd) - offsetMinutes * 60 * 1000);
    };

    let startDate = null;
    let endDate = null;

    if (period === "today") {
      startDate = getCairoMidnight(year, month, day);
      endDate = getCairoMidnight(year, month, day + 1);
    } else if (period === "last7days") {
      startDate = getCairoMidnight(year, month, day - 6);
      endDate = getCairoMidnight(year, month, day + 1);
    } else if (period === "last30days") {
      startDate = getCairoMidnight(year, month, day - 29);
      endDate = getCairoMidnight(year, month, day + 1);
    }

    const match = {};

    if (period !== "all") {
      match.appointment_date = {
        $gte: startDate,
        $lt: endDate,
      };
    }

    const statuses = ["completed", "missed", "cancelled", "upcoming"];

    const results = await Appointment.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    const counts = Object.fromEntries(
      statuses.map((status) => [status, 0])
    );

    results.forEach((item) => {
      if (Object.prototype.hasOwnProperty.call(counts, item._id)) {
        counts[item._id] = item.count;
      }
    });

    const total = Object.values(counts).reduce(
      (sum, count) => sum + count,
      0
    );

    const data = statuses.map((status) => ({
      status,
      count: counts[status],
      percentage:
        total === 0
          ? 0
          : Number(((counts[status] / total) * 100).toFixed(2)),
    }));

    return res.status(200).json({
      success: true,
      period,
      total_appointments: total,
      data,
    });
  } catch (err) {
    next(err);
  }
};







//growth chart

export const getPlatformGrowthChart = async (req, res, next) => {
  try {
    const timeZone = "Africa/Cairo";

    // Get today's date in Cairo
    const todayString = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const [year, month, day] = todayString.split("-").map(Number);

    // Find Cairo's UTC offset for a particular instant
    const getCairoOffset = (date) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        timeZoneName: "longOffset",
      }).formatToParts(date);

      const zone = parts.find((p) => p.type === "timeZoneName")?.value;
      const match = zone?.match(/GMT([+-])(\d{2}):(\d{2})/);

      if (!match) return 0;

      const sign = match[1] === "-" ? -1 : 1;
      return sign * (Number(match[2]) * 60 + Number(match[3]));
    };

    // Convert Cairo midnight to a UTC Date
    const cairoMidnight = (y, m, d) => {
      const utcApproximation = new Date(Date.UTC(y, m - 1, d, 12));
      const localDate = new Date(Date.UTC(y, m - 1, d));
      const offsetMinutes = getCairoOffset(utcApproximation);

      return new Date(localDate.getTime() - offsetMinutes * 60 * 1000);
    };

    const todayStart = cairoMidnight(year, month, day);
    const startDate = cairoMidnight(year, month, day - 6);
    const endDate = cairoMidnight(year, month, day + 1);

    const [usersByDay, appointmentsByDay] = await Promise.all([
      User.aggregate([
        {
          $match: {
            role: "patient",
            created_at: { $gte: startDate, $lt: endDate },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                date: "$created_at",
                format: "%Y-%m-%d",
                timezone: timeZone,
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),

      Appointment.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate, $lt: endDate },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                date: "$createdAt",
                format: "%Y-%m-%d",
                timezone: timeZone,
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const usersMap = new Map(usersByDay.map((item) => [item._id, item.count]));
    const appointmentsMap = new Map(
      appointmentsByDay.map((item) => [item._id, item.count])
    );

    const data = [];

    for (let i = 0; i < 7; i++) {
      const currentDate = new Date(startDate);
      currentDate.setUTCDate(currentDate.getUTCDate() + i);

      const dateString = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(currentDate);

      // Use a UTC-based date label to avoid accidental timezone shifts
      const labelDate = new Date(Date.UTC(year, month - 1, day - 6 + i));
      const label = `${labelDate.getUTCFullYear()}-${String(
        labelDate.getUTCMonth() + 1
      ).padStart(2, "0")}-${String(labelDate.getUTCDate()).padStart(2, "0")}`;

      const dayName = new Intl.DateTimeFormat("ar-EG", {
        weekday: "long",
        timeZone,
      }).format(cairoMidnight(
        labelDate.getUTCFullYear(),
        labelDate.getUTCMonth() + 1,
        labelDate.getUTCDate()
      ));

      data.push({
        date: label,
        day_name: dayName,
        is_today: label === todayString,
        new_users_count: usersMap.get(label) ?? 0,
        appointments_count: appointmentsMap.get(label) ?? 0,
      });
    }

    return res.status(200).json({
      success: true,
      period: "last7days",
      time_zone: timeZone,
      data,
    });
  } catch (err) {
    next(err);
  }
};




//specialty chart




export const getBookingsBySpecialtyChart = async (req, res, next) => {
  try {
    const data = await Appointment.aggregate([
      // Link each appointment to its doctor
      {
        $lookup: {
          from: "doctors",
          localField: "doctor_id",
          foreignField: "_id",
          as: "doctor",
        },
      },
      { $unwind: "$doctor" },

      // Link the doctor to the specialty
      {
        $lookup: {
          from: "specialities",
          localField: "doctor.speciality_id",
          foreignField: "_id",
          as: "specialty",
        },
      },
      { $unwind: "$specialty" },

      // Count every appointment, regardless of status
      {
        $group: {
          _id: "$doctor.speciality_id",
          specialty_name: { $first: "$specialty.name" },
          booking_count: { $sum: 1 },
        },
      },

      { $sort: { booking_count: -1, specialty_name: 1 } },

      {
        $project: {
          _id: 0,
          specialty_id: "$_id",
          specialty_name: 1,
          booking_count: 1,
        },
      },
    ]);

    const totalBookings = data.reduce(
      (sum, item) => sum + item.booking_count,
      0
    );

    const result = data.map((item) => ({
      ...item,
      percentage_of_all_bookings:
        totalBookings === 0
          ? 0
          : Number(
              ((item.booking_count / totalBookings) * 100).toFixed(2)
            ),
    }));

    return res.status(200).json({
      success: true,
      total_bookings: totalBookings,
      count: result.length,
      data: result,
    });
  } catch (err) {
    next(err);
  }
};













export const getAllDoctorsForAdmin = async (req, res, next) => {
  try {
    const {
      approval_status,
      is_active,
      speciality_id,
      sort = "desc",
      search,
      page = 1,
      limit = 7,
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // Validate approval status
    const allowedStatuses = [
      "pending",
      "accepted",
      "cancelled",
      "require_edits",
    ];

    if (
      approval_status &&
      !allowedStatuses.includes(approval_status)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "approval_status must be pending, accepted, cancelled, or require_edits",
      });
    }

    if (
      is_active !== undefined &&
      !["true", "false"].includes(is_active)
    ) {
      return res.status(400).json({
        success: false,
        message: "is_active must be true or false",
      });
    }

    if (speciality_id && !mongoose.isValidObjectId(speciality_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid speciality_id",
      });
    }

    if (!["asc", "desc"].includes(sort)) {
      return res.status(400).json({
        success: false,
        message: "sort must be asc or desc",
      });
    }

    const filter = {};

    if (approval_status) {
      filter.approval_status = approval_status;
    }

    if (is_active !== undefined) {
      filter.is_active = is_active === "true";
    }

    if (speciality_id) {
      filter.speciality_id = speciality_id;
    }

    // البحث باسم أو بريد الطبيب (إذا تم إدخال 3 أحرف أو أكثر)
    if (search && search.trim().length >= 3) {
      const searchRegex = new RegExp(search.trim(), "i");

      const matchingUsers = await User.find({
        role: "doctor",
        $or: [
          { full_name: { $regex: searchRegex } },
          { email: { $regex: searchRegex } }
        ]
      }).select("_id");

      const userIds = matchingUsers.map((u) => u._id);

      // إذا لم ينطبق البحث على أي طبيب، نرجع نتيجة فارغة فوراً
      if (userIds.length === 0) {
        return res.status(200).json({
          success: true,
          count: 0,
          filters: {
            approval_status: approval_status ?? "all",
            is_active: is_active ?? "all",
            speciality_id: speciality_id ?? "all",
            sort,
          },
          meta: {
            page: pageNum,
            limit: limitNum,
            total: 0,
            total_pages: 0,
          },
          data: [],
        });
      }

      filter.user_id = { $in: userIds };
    }

    // Get doctors with user and specialty information with pagination
    const [doctors, total] = await Promise.all([
      Dr.find(filter)
        .populate({
          path: "user_id",
          select: "full_name email",
        })
        .populate({
          path: "speciality_id",
          select: "name",
        })
        .sort({ createdAt: sort === "asc" ? 1 : -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Dr.countDocuments(filter),
    ]);

    const doctorIds = doctors.map((doctor) => doctor._id);

    const appointmentStats = await Appointment.aggregate([
      {
        $match: {
          doctor_id: { $in: doctorIds },
        },
      },
      {
        $group: {
          _id: "$doctor_id",
          appointments_count: { $sum: 1 },
        },
      },
    ]);

    const appointmentCountMap = new Map(
      appointmentStats.map((item) => [
        String(item._id),
        item.appointments_count,
      ])
    );

    const reviewStats = await Review.aggregate([
      {
        $match: {
          doctor_id: { $in: doctorIds },
        },
      },
      {
        $group: {
          _id: "$doctor_id",
          rating_average: { $avg: "$rating" },
          rating_count: { $sum: 1 },
        },
      },
    ]);

    const reviewMap = new Map(
      reviewStats.map((item) => [
        String(item._id),
        {
          rating_average:
            Math.round(item.rating_average * 10) / 10,
          rating_count: item.rating_count,
        },
      ])
    );

    const data = doctors.map((doctor) => {
      const doctorId = String(doctor._id);
      const rating = reviewMap.get(doctorId);

      let createdDate = null;

      if (doctor.createdAt) {
        const date = new Date(doctor.createdAt);

        const day = String(date.getUTCDate()).padStart(2, "0");
        const month = String(date.getUTCMonth() + 1).padStart(2, "0");
        const year = date.getUTCFullYear();

        createdDate = `${day}-${month}-${year}`;
      }

      return {
        doctor_id: doctor._id,
        doctor_image: doctor.image ?? null,

        doctor_name: doctor.user_id?.full_name ?? null,
        doctor_email: doctor.user_id?.email ?? null,

        specialty: doctor.speciality_id?.name ?? null,

        rating_average: rating?.rating_average ?? 0,

        appointments_count:
          appointmentCountMap.get(doctorId) ?? 0,

        is_active: doctor.is_active,
        approval_status: doctor.approval_status,

        created_at: createdDate,
      };
    });

    return res.status(200).json({
      success: true,
      count: data.length,
      filters: {
        approval_status: approval_status ?? "all",
        is_active: is_active ?? "all",
        speciality_id: speciality_id ?? "all",
        sort,
      },
      meta: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
      },
      data,
    });
  } catch (err) {
    next(err);
  }
};










export const getAllSpecialities = async (req, res, next) => {
  try {
    const { search } = req.query;

    // Validate search length
    if (search !== undefined && search.trim().length < 4) {
      return res.status(400).json({
        success: false,
        message: "Search must be at least 4 characters long",
      });
    }

    const searchFilter = search
      ? {
          $or: [
            { name: { $regex: search.trim(), $options: "i" } },
            { description: { $regex: search.trim(), $options: "i" } },
          ],
        }
      : {};

    const specialities = await Speciality.aggregate([
      {
        $match: searchFilter,
      },
      {
        $lookup: {
          from: "doctors",
          localField: "_id",
          foreignField: "speciality_id",
          as: "doctors",
        },
      },
      {
        $project: {
          _id: 1,
          name: 1,
          icon: 1,
          description: {
            $let: {
              vars: {
                desc: {
                  $trim: {
                    input: { $ifNull: ["$description", ""] },
                  },
                },
              },
              in: {
                $cond: [
                  { $eq: ["$$desc", ""] },
                  "no description found",
                  "$$desc",
                ],
              },
            },
          },
          active_status: 1,
          doctors_count: { $size: "$doctors" },
        },
      },
    ]);

    if (specialities.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: "No match found",
        data: [],
      });
    }

    return res.status(200).json({
      success: true,
      count: specialities.length,
      data: specialities,
    });
  } catch (err) {
    next(err);
  }
};









export const getDoctorsBySpeciality = async (req, res, next) => {
  try {
    const { speciality_id } = req.query;

    if (!speciality_id) {
      return res.status(400).json({
        success: false,
        message: "speciality_id is required",
      });
    }

    if (!mongoose.isValidObjectId(speciality_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid speciality_id",
      });
    }

    // Get ALL doctors belonging to this specialty,
    // regardless of active status or approval status.
    const doctors = await Dr.find({
      speciality_id: speciality_id,
    })
      .populate("user_id", "full_name")
      .populate({
        path: "speciality_id",
        select: "name active_status",
      })
      .select(
        "user_id speciality_id title image consultation_fee rating_average area governorate is_active approval_status"
      )
      .sort({ rating_average: -1 })
      .lean();

    const result = doctors
      .filter((doctor) => doctor.user_id && doctor.speciality_id)
      .map((doctor) => ({
        doctor_id: doctor._id,
        name: doctor.user_id.full_name,
        speciality: doctor.speciality_id.name,
        title: doctor.title,
        image: doctor.image,
        rating: doctor.rating_average,
        area: doctor.area,
        governorate: doctor.governorate,
        consultation_fee: doctor.consultation_fee,
        is_active: doctor.is_active,
        approval_status: doctor.approval_status,
      }));

    return res.status(200).json({
      success: true,
      count: result.length,
      data: result,
    });
  } catch (err) {
    next(err);
  }
};









export const createSpeciality = async (req, res, next) => {
  try {
    const { name, icon, description } = req.body;

    if (!name) {
      return next({
        message: "Speciality name is required",
        statusCode: 400
      });
    }

    const existingSpeciality = await Speciality.findOne({
      name: name.trim()
    });

    if (existingSpeciality) {
      return next({
        message: "Speciality already exists",
        statusCode: 409
      });
    }

    const speciality = await Speciality.create({
      name: name.trim(),
      icon: icon || null,
      description: description ? description.trim() : null
    });

    res.status(201).json({
      success: true,
      message: "Speciality created successfully",
      data: speciality
    });

  } catch (err) {
    next(err);
  }
};


















export const oglobalSearch = async (req, res, next) => {
  try {
    const { search } = req.query;

    // إذا كان نص البحث فارغاً أو أقل من حرفين، نرجع نتائج فارغة فوراً
    if (!search || search.trim().length < 2) {
      return res.status(200).json({
        success: true,
        data: {
          doctors: [],
          specialties: [],
        },
      });
    }

    const searchRegex = new RegExp(search.trim(), "i");

    // 1. البحث عن الأطباء (عبر جدول User حيث الدور doctor والاسم أو الإيميل متطابق)
    const matchingUsers = await User.find({
      role: "doctor",
      $or: [
        { full_name: { $regex: searchRegex } },
        { email: { $regex: searchRegex } },
      ],
    }).select("_id");

    const userIds = matchingUsers.map((u) => u._id);

    // جلب بيانات الأطباء المطابقين مع تقييد العدد (مثلاً 5 نتائج كحد أقصى للاقتراحات السريعة)
    const doctors = await Dr.find({ user_id: { $in: userIds } })
      .populate({
        path: "user_id",
        select: "full_name email",
      })
      .populate({
        path: "speciality_id",
        select: "name",
      })
      .select("image approval_status user_id speciality_id")
      .limit(5)
      .lean();

    const formattedDoctors = doctors.map((doc) => ({
      doctor_id: doc._id,
      name: doc.user_id?.full_name ?? null,
      email: doc.user_id?.email ?? null,
      image: doc.image ?? null,
      specialty: doc.speciality_id?.name ?? null,
      approval_status: doc.approval_status,
    }));

    // 2. البحث عن التخصصات (بالاسم أو الوصف)
    const specialties = await Speciality.find({
      $or: [
        { name: { $regex: searchRegex } },
        { description: { $regex: searchRegex } },
      ],
    })
      .select("name description")
      .limit(5)
      .lean();

    const formattedSpecialties = specialties.map((spec) => ({
      speciality_id: spec._id,
      name: spec.name,
      description: spec.description ?? null,
    }));

    // 3. إرجاع النتائج مقسمة ومنظمة لفريق الواجهة الأمامية
    return res.status(200).json({
      success: true,
      data: {
        doctors: formattedDoctors,
        specialties: formattedSpecialties,
      },
    });
  } catch (err) {
    next(err);
  }
};




















export const getAdminProfile = async (req, res, next) => {
  try {
    const admin = await User.findOne({
      _id: req.user.id,
      role: "admin",
    }).select("avatar full_name email phone");

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin profile not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        image: admin.avatar ?? null,
        name: admin.full_name,
        email: admin.email,
        phone: admin.phone,
      },
    });
  } catch (err) {
    next(err);
  }
};













export const updateAdminProfile = async (req, res, next) => {
  try {
    const { password, name, email, phone } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Current password is required",
      });
    }

    // Load the signed-in admin and explicitly include the hidden password
    const admin = await User.findOne({
      _id: req.user.id,
      role: "admin",
    }).select("+password");

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin profile not found",
      });
    }

    // Verify the current password before changing anything
    const passwordIsCorrect = await bcrypt.compare(
      password,
      admin.password
    );

    if (!passwordIsCorrect) {
      return res.status(401).json({
        success: false,
        message: "No changes were made because the password is incorrect",
      });
    }

    // Only update fields explicitly provided by the client
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Name must not be empty",
        });
      }

      admin.full_name = name.trim();
    }

    if (email !== undefined) {
      if (typeof email !== "string" || !email.trim()) {
        return res.status(400).json({
          success: false,
          message: "Email must not be empty",
        });
      }

      admin.email = email.trim().toLowerCase();
    }

    if (phone !== undefined) {
      if (typeof phone !== "string" || !phone.trim()) {
        return res.status(400).json({
          success: false,
          message: "Phone must not be empty",
        });
      }

      admin.phone = phone.trim();
    }

    if (
      name === undefined &&
      email === undefined &&
      phone === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "No profile fields were provided to update",
      });
    }

    await admin.save();

    return res.status(200).json({
      success: true,
      message: "Admin profile updated successfully",
      data: {
        image: admin.avatar ?? null,
        name: admin.full_name,
        email: admin.email,
        phone: admin.phone,
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Email or another unique field already exists",
      });
    }

    next(err);
  }
};















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







export const globalSearch = async (req, res, next) => {
  try {
    const { search } = req.query;

    // Return empty results if search is less than 2 characters
    if (!search || search.trim().length < 2) {
      return res.status(200).json({
        success: true,
        data: {
          doctors: [],
          specialties: [],
        },
      });
    }

    const searchRegex = new RegExp(search.trim(), "i");

    // 1. Find matching doctor users
    const matchingUsers = await User.find({
      role: "doctor",
      $or: [
        { full_name: { $regex: searchRegex } },
        { email: { $regex: searchRegex } },
      ],
    }).select("_id");

    const userIds = matchingUsers.map((u) => u._id);

    // 2. Fetch matching doctors with all required schedule data
    const doctors = await Dr.find({
      user_id: { $in: userIds },
      is_active: true,
      approval_status: "accepted",
    })
      .populate({
        path: "user_id",
        select: "full_name",
      })
      .populate({
        path: "speciality_id",
        select: "name active_status",
        match: { active_status: true },
      })
      .select(
        "image is_active user_id speciality_id schedule slot_duration_minutes days_off"
      )
      .limit(5);

    // Exclude doctors with inactive specialities
    const activeDoctors = doctors.filter(
      (doctor) => doctor.speciality_id !== null
    );

    // 3. Calculate nearest available slots
    const nearestSlots = new Map();

    if (activeDoctors.length > 0) {
      const todayDate = cairoNow().date;
      const startDate = parseDate(todayDate);

      const dates = [];

      // Check today and the following 6 days
      for (let i = 0; i < 7; i++) {
        const date = new Date(startDate);

        date.setUTCDate(date.getUTCDate() + i);

        dates.push(date.toISOString().slice(0, 10));
      }

      const endDate = new Date(startDate);

      endDate.setUTCDate(endDate.getUTCDate() + 7);

      // Get upcoming appointments
      const appointments = await Appointment.find({
        doctor_id: {
          $in: activeDoctors.map((doctor) => doctor._id),
        },
        status: "upcoming",
        appointment_date: {
          $gte: startDate,
          $lt: endDate,
        },
      }).select(
        "doctor_id appointment_date appointment_time"
      );

      // Store booked slots
      const bookedSlots = new Set(
        appointments.map((appointment) => {
          const dateKey = appointment.appointment_date
            .toISOString()
            .slice(0, 10);

          return `${appointment.doctor_id}_${dateKey}_${appointment.appointment_time}`;
        })
      );

      // Find nearest available slot for each doctor
      for (const doctor of activeDoctors) {
        let nearestSlot = null;

        for (const dateKey of dates) {
          // Check whether the doctor works on this day
          const dateObject = parseDate(dateKey);
          const dayNumber = dateObject.getUTCDay();

          const workingDays =
            doctor.schedule?.working_days || [];

          if (!workingDays.includes(dayNumber)) {
            continue;
          }

          // Check doctor's days off
          const isDayOff = (doctor.days_off || []).some(
            (dayOff) => {
              const offDate = new Date(dayOff);

              return (
                offDate >= dateObject &&
                offDate <
                  new Date(dateObject.getTime() + 86400000)
              );
            }
          );

          if (isDayOff) {
            continue;
          }

          const slots = generateSlots(doctor, dateKey);

          for (const time of slots) {
            // Ignore past slots
            if (!isFuture(dateKey, time)) {
              continue;
            }

            const slotKey =
              `${doctor._id}_${dateKey}_${time}`;

            // Ignore booked slots
            if (bookedSlots.has(slotKey)) {
              continue;
            }

            nearestSlot = {
              date: dateKey,
              time: time,
            };

            break;
          }

          if (nearestSlot) {
            break;
          }
        }

        nearestSlots.set(
          doctor._id.toString(),
          nearestSlot
        );
      }
    }

    // 4. Sort doctors by nearest available slot
    const sortedDoctors = [...activeDoctors];

    sortedDoctors.sort((a, b) => {
      const slotA = nearestSlots.get(
        a._id.toString()
      );

      const slotB = nearestSlots.get(
        b._id.toString()
      );

      // Doctors without available slots go last
      if (!slotA && !slotB) return 0;
      if (!slotA) return 1;
      if (!slotB) return -1;

      // Compare dates first
      const dateComparison =
        slotA.date.localeCompare(slotB.date);

      if (dateComparison !== 0) {
        return dateComparison;
      }

      // Compare times
      return slotA.time.localeCompare(slotB.time);
    });

    // 5. Format doctors response
    const formattedDoctors = sortedDoctors.map((doc) => ({
      doctor_id: doc._id,
      name: doc.user_id?.full_name ?? null,
      image: doc.image ?? null,
      specialty: doc.speciality_id?.name ?? null,

      nearest_available_slot:
        nearestSlots.get(doc._id.toString()) || null,
    }));

    // 6. Search specialties (unchanged)
    const specialties = await Speciality.find({
      $or: [
        { name: { $regex: searchRegex } },
        { description: { $regex: searchRegex } },
      ],
    })
      .select("name description")
      .limit(5)
      .lean();

    const formattedSpecialties = specialties.map((spec) => ({
      speciality_id: spec._id,
      name: spec.name,
      description: spec.description ?? null,
    }));

    // 7. Return results
    return res.status(200).json({
      success: true,
      data: {
        doctors: formattedDoctors,
        specialties: formattedSpecialties,
      },
    });

  } catch (err) {
    next(err);
  }
};
