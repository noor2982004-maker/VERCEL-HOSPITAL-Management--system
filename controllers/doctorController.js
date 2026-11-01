import bcrypt from "bcryptjs";
import User from "../models/user.js";
import {createAdminSchema,} from "../validators/authValidator.js";
import Dr from "../models/doctor.js";
import Speciality from "../models/speciality.js";
import Appointment from "../models/appointment.js";
import { parseDate, isFuture, generateSlots, scheduleSummary,cairoNow } from "../utils/slots.js";





function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function renderPage(res, title, message, form = "", status = 200) {
  return res.status(status).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${title}</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #f4f7fb;
          padding: 24px;
          color: #222;
        }
        main {
          max-width: 480px;
          margin: 50px auto;
          padding: 28px;
          background: white;
          border-radius: 12px;
        }
        input, button {
          width: 100%;
          box-sizing: border-box;
          margin-top: 16px;
          padding: 12px;
        }
        button {
          background: #1769aa;
          color: white;
          border: 0;
          border-radius: 7px;
          cursor: pointer;
        }
      </style>
    </head>
    <body>
      <main>
        <h2>${title}</h2>
        <p>${message}</p>
        ${form}
      </main>
    </body>
    </html>
  `);
}

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "image",
        folder: "doctor-documents",
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    stream.end(buffer);
  });
}



// GET /api/up/doctor-upload?token=...الصفحة اللي هتظهر للدكتور لما يدوس اللينك في الايميل
export const showDoctorUploadPage = async (req, res) => {
  try {
    const { token } = req.query;

    if (typeof token !== "string" || !token) {
      return renderPage(
        res,
        "Invalid link",
        "The upload link is missing or invalid.",
        "",
        400
      );
    }

    const request = await RequestEdits.findOne({
      token_hash: hashToken(token),
      expires_at: { $gt: new Date() },
    }).select("+token_hash +expires_at");

    if (!request) {
      return renderPage(
        res,
        "Link expired",
        "This link is invalid, expired, or has already been used.",
        "",
        410
      );
    }

    
    const form = `
      <form
        action="/api/up/doctor-upload?token=${encodeURIComponent(token)}"
        method="POST"
        enctype="multipart/form-data"
      >
        <label for="avatar">
          Choose an image (JPG, PNG, WEBP — max 2 MB)
        </label>

        <input
          id="avatar"
          type="file"
          name="avatar"
          accept="image/jpeg,image/png,image/webp"
          required
        >

        <button type="submit">Upload</button>
      </form>
    `;

    return renderPage(
      res,
      "Upload requested document",
      "Choose the requested image, then click Upload.",
      form
    );
  } catch (error) {
    console.error("Show upload page error:", error);

    return renderPage(
      res,
      "Error",
      "Something went wrong. Please try again later.",
      "",
      500
    );
  }
};

export const createDoctor = async (req, res, next) => {
  try {
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
      clinic_phone,
      languages,
      license_number,
      location,
      availability,
      slot_duration_minutes
    } = req.body;


    if (!full_name || !email || !password || !speciality_id) {
      return next({
        message: "full_name, email, password and speciality_id are required",
        statusCode: 400
      });
    }

 
    const speciality = await Speciality.findById(speciality_id);

    if (!speciality) {
      return next({
        message: "Speciality not found",
        statusCode: 404
      });
    }

  
    const existingUser = await User.findOne({
      email: email.toLowerCase()
    });

    if (existingUser) {
      return next({
        message: "Email already registered",
        statusCode: 409
      });
    }

    
    if (license_number) {
      const existingDoctor = await Dr.findOne({
        license_number
      });

      if (existingDoctor) {
        return next({
          message: "License number already registered",
          statusCode: 409
        });
      }
    }

    
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
      clinic_phone,
      languages,
      license_number,
      location,
      availability,
      slot_duration_minutes,
      approval_status: "pending"
    });

    
    res.status(201).json({
      success: true,
      message: "Doctor created successfully",

      data: {
        doctor_id: doctor._id,
        user_id: user._id,

        full_name: user.full_name,
        email: user.email,
        role: user.role,

        speciality: {
          id: speciality._id,
          name: speciality.name
        },

        consultation_fee: doctor.consultation_fee,
        availability: doctor.availability,
        is_active: doctor.is_active,
        approval_status: doctor.approval_status
      }
    });

  } catch (err) {
    next(err);
  }
};
//for patients:

export const ogetacceptedDoctors = async (req, res, next) => {
  try {
    const {
      today,
      speciality_id,
      governorate
    } = req.query;

    const filter = {
      is_active: true,
      approval_status: "accepted"
    };

    if (speciality_id) {
      filter.speciality_id = speciality_id;
    }

    if (governorate) {
      filter.governorate = governorate;
    }

    if (today === "true") {
      const todayNumber = new Date().getDay();

      filter.availability = {
        $elemMatch: {
          day_of_week: todayNumber
        }
      };

      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);

      filter.days_off = {
        $not: {
          $elemMatch: {
            $gte: startOfToday,
            $lte: endOfToday
          }
        }
      };
    }

    const doctors = await Dr.find(filter)
      .populate("user_id", "full_name")
      .populate({
        path: "speciality_id",
        select: "name active_status",
        match: { active_status: true } 
      })
      .select(
        "user_id speciality_id title image consultation_fee rating_average area governorate"
      )
      .sort({ rating_average: -1 });

    
    const activeSpecialityDoctors = doctors.filter((dr) => dr.speciality_id !== null);

    const result = activeSpecialityDoctors.map((doctor) => ({
      doctor_id: doctor._id,

      name: doctor.user_id?.full_name,

      speciality: doctor.speciality_id?.name,

      title: doctor.title,

      image: doctor.image,

      rating: doctor.rating_average,

      area: doctor.area,

      governorate: doctor.governorate,

      consultation_fee: doctor.consultation_fee,
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

////////////////////////////////////////////////




export const getacceptedDoctors = async (req, res, next) => {
  try {
    const {
      today,
      speciality_id,
      governorate,
      sort_by,
      sort,
    } = req.query;

    const sortOption = sort_by || sort || "rating";

    const allowedSortOptions = [
      "rating",
      "experience",
      "fee_asc",
      "nearest_slot",
    ];

    if (!allowedSortOptions.includes(sortOption)) {
      return res.status(400).json({
        success: false,
        message: "Invalid sort option",
      });
    }

    const cairoDate = cairoNow().date;
    const startOfToday = parseDate(cairoDate);
    const startOfTomorrow = new Date(startOfToday);

    startOfTomorrow.setUTCDate(
      startOfTomorrow.getUTCDate() + 1
    );

    const todayNumber = startOfToday.getUTCDay();

    // Base filter
    const filter = {
      is_active: true,
      approval_status: "accepted",
    };

    if (speciality_id) {
      filter.speciality_id = speciality_id;
    }

    if (governorate) {
      filter.governorate = governorate;
    }

    const doctors = await Dr.find(filter)
      .populate("user_id", "full_name")
      .populate({
        path: "speciality_id",
        select: "name active_status",
        match: { active_status: true },
      })
      .select(
        "user_id speciality_id title image consultation_fee rating_average years_of_experience area governorate schedule slot_duration_minutes days_off is_active"
      );

    let activeSpecialityDoctors = doctors.filter(
      (doctor) => doctor.speciality_id !== null
    );

    const doctorsWithTodayStatus = activeSpecialityDoctors.map(
      (doctor) => {
        const workingDays =
          doctor.schedule?.working_days || [];

        const worksToday =
          workingDays.includes(todayNumber) &&
          !(doctor.days_off || []).some((dayOff) => {
            const offDate = new Date(dayOff);

            return (
              offDate >= startOfToday &&
              offDate < startOfTomorrow
            );
          });

        return {
          doctor,
          worksToday,
        };
      }
    );

    if (today === "true") {
      activeSpecialityDoctors = doctorsWithTodayStatus
        .filter((item) => item.worksToday)
        .map((item) => item.doctor);
    }

    const nearestSlots = new Map();

    if (activeSpecialityDoctors.length > 0) {
      const dates = [];

      for (let i = 0; i < 7; i++) {
        const date = new Date(startOfToday);

        date.setUTCDate(date.getUTCDate() + i);

        dates.push(date.toISOString().slice(0, 10));
      }

      const endDate = new Date(startOfToday);

      endDate.setUTCDate(endDate.getUTCDate() + 7);

      const appointments = await Appointment.find({
        doctor_id: {
          $in: activeSpecialityDoctors.map(
            (doctor) => doctor._id
          ),
        },
        status: "upcoming",
        appointment_date: {
          $gte: startOfToday,
          $lt: endDate,
        },
      }).select(
        "doctor_id appointment_date appointment_time"
      );

      const bookedSlots = new Set(
        appointments.map((appointment) => {
          const dateKey = appointment.appointment_date
            .toISOString()
            .slice(0, 10);

          return `${appointment.doctor_id}_${dateKey}_${appointment.appointment_time}`;
        })
      );

      for (const doctor of activeSpecialityDoctors) {
        let nearestSlot = null;

        for (const dateKey of dates) {
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
              time,
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

    const sortedDoctors = [...activeSpecialityDoctors];

    switch (sortOption) {
      case "rating":
        sortedDoctors.sort(
          (a, b) =>
            (b.rating_average || 0) -
            (a.rating_average || 0)
        );
        break;

      case "experience":
        sortedDoctors.sort(
          (a, b) =>
            (b.years_of_experience || 0) -
            (a.years_of_experience || 0)
        );
        break;

      case "fee_asc":
        sortedDoctors.sort(
          (a, b) =>
            (a.consultation_fee || 0) -
            (b.consultation_fee || 0)
        );
        break;

      case "nearest_slot":
        sortedDoctors.sort((a, b) => {
          const slotA = nearestSlots.get(
            a._id.toString()
          );

          const slotB = nearestSlots.get(
            b._id.toString()
          );

          if (!slotA && !slotB) return 0;
          if (!slotA) return 1;
          if (!slotB) return -1;

          // Compare dates first
          const dateComparison =
            slotA.date.localeCompare(slotB.date);

          if (dateComparison !== 0) {
            return dateComparison;
          }

          return slotA.time.localeCompare(slotB.time);
        });
        break;
    }

    const result = sortedDoctors.map((doctor) => {
      const doctorTodayStatus =
        doctorsWithTodayStatus.find(
          (item) =>
            item.doctor._id.toString() ===
            doctor._id.toString()
        );

      return {
        doctor_id: doctor._id,
        name: doctor.user_id?.full_name,
        speciality: doctor.speciality_id?.name,
        title: doctor.title,
        image: doctor.image,
        rating: doctor.rating_average,
        years_of_experience: doctor.years_of_experience,
        area: doctor.area,
        governorate: doctor.governorate,
        consultation_fee: doctor.consultation_fee,

        works_today:
          doctorTodayStatus?.worksToday ?? false,

        nearest_available_slot:
          nearestSlots.get(doctor._id.toString()) || null,
      };
    });

    return res.status(200).json({
      success: true,
      count: result.length,
      data: result,
    });

  } catch (err) {
    next(err);
  }
};


/////////////////////////////////////////////////////

export const getDoctorById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const doctor = await Dr.findOne({
      _id: id,
      is_active: true
    })
      .select(
        "user_id speciality_id bio education_and_qualifications clinic_address consultation_fee rating_average title image years_of_experience clinic_name area governorate rating_count"
      )
      .populate("user_id", "full_name avatar")
      .populate("speciality_id", "name");

    if (!doctor) {
      return next({
        message: "Doctor not found",
        statusCode: 404
      });
    }

    res.status(200).json({
      success: true,
      data: doctor
    });

  } catch (err) {
    next(err);
  }
};
export const getDoctoravailability = async (req, res, next) => {
  try {
    const { id } = req.params;

    const doctor = await Dr.findOne({
      _id: id,
      is_active: true
    })
      .select(
        "user_id speciality_id clinic_address consultation_fee rating_average title image years_of_experience clinic_name area governorate rating_count availability"
      )
      .populate("user_id", "full_name avatar")
      .populate("speciality_id", "name");

    if (!doctor) {
      return next({
        message: "Doctor not found",
        statusCode: 404
      });
    }

    res.status(200).json({
      success: true,
      data: doctor
    });

  } catch (err) {
    next(err);
  }
};