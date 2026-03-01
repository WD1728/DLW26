const CONFIG = {
  PORT: 8080,

  // Risk cost multiplier
  RISK_PENALTY_SCALE: 80,

  // Default incident penalty if not specified
  INCIDENT_PENALTY_DEFAULT: 40,

  // Global mode routing aggressiveness
  MODE_MULTIPLIER: {
    normal: 1,
    alert: 1.15,
    evacuation: 1.4
  },

  // Congestion penalty strength
  CONGESTION_SCALE: 2.0
};

export default CONFIG;