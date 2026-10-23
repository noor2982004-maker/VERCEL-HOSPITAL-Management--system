import Appointment from "../models/appointment.js";
import { cairoNow, parseDate } from "../utils/slots.js";

const GRACE_MINUTES = 60;          
const INTERVAL_MS = 5 * 60 * 1000;  

export const markNoShows = async () => {
  const cutoff = cairoNow(new Date(Date.now() - GRACE_MINUTES * 60 * 1000));
  const cutoffDate = parseDate(cutoff.date);

  const result = await Appointment.updateMany(
    {
      status: "upcoming",
      $or: [
        { appointment_date: { $lt: cutoffDate } },
        { appointment_date: cutoffDate, appointment_time: { $lte: cutoff.time } },
      ],
    },
    { $set: { status: "missed" } }
  );

  if (result.modifiedCount) {
    console.log(`Marked ${result.modifiedCount} appointment(s) as no-show`);
  }
  return result.modifiedCount;
};

export const startAppointmentJobs = () => {
  const run = () =>
    markNoShows().catch((err) => console.error("no-show job failed:", err.message));

  run();
  setInterval(run, INTERVAL_MS).unref();
};