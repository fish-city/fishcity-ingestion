/**
 * Moon phase calculation using SunCalc.
 * Matches backend: getMoonPhase() in weather-model.js — exact same logic.
 *
 * Returns: { time_stamp, moon_phase, moon_phase_name } or null
 */
import SunCalc from "suncalc";

/**
 * Calculate moon phase for each date in an array. No API call — pure local calc.
 *
 * @param {string[]} dates - Array of YYYY-MM-DD strings
 * @returns {Object} Map of { [date]: { time_stamp, moon_phase, moon_phase_name } }
 */
export function getMoonPhaseRange(dates) {
  const result = {};
  for (const date of dates) {
    const phase = getMoonPhase(date);
    if (phase) result[date] = phase;
  }
  return result;
}

/**
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {{ time_stamp: string, moon_phase: string, moon_phase_name: string }} or null
 */
export function getMoonPhase(dateStr) {
  try {
    const moonData = SunCalc.getMoonIllumination(new Date(dateStr));
    const phase = moonData.phase;

    let moonPhaseName;
    if (phase === 0) {
      moonPhaseName = "New Moon";
    } else if (phase > 0 && phase < 0.25) {
      moonPhaseName = "Waxing Crescent";
    } else if (phase === 0.25) {
      moonPhaseName = "First Quarter";
    } else if (phase > 0.25 && phase < 0.5) {
      moonPhaseName = "Waxing Gibbous";
    } else if (phase === 0.5) {
      moonPhaseName = "Full Moon";
    } else if (phase > 0.5 && phase < 0.75) {
      moonPhaseName = "Waning Gibbous";
    } else if (phase === 0.75) {
      moonPhaseName = "Last Quarter";
    } else {
      moonPhaseName = "Waning Crescent";
    }

    return {
      time_stamp: dateStr,
      moon_phase: phase.toFixed(2),
      moon_phase_name: moonPhaseName
    };
  } catch (error) {
    console.error("[moon-phase] Error:", error.message);
    return null;
  }
}
