#!/usr/bin/env node

/**
 * Simulate many mobile clients sending GPS updates to backend /presence/update.
 *
 * Example:
 *   node scripts/simulateMobilePresence.mjs --users 80 --interval-ms 2000 --duration-sec 120
 */

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8080",
  users: 60,
  intervalMs: 2000,
  durationSec: 0,
  centerLat: 1.3521,
  centerLng: 103.8198,
  radiusM: 2500,
  driftM: 30,
  mode: "random",
  targetLat: 1.3048,
  targetLng: 103.8318,
  clusterRadiusM: 180,
  cycleSec: 180,
  disperseRatio: 0.4,
  source: "presence_simulator",
};

const SG_RESIDENTIAL_CENTERS = [
  { name: "Tampines", lat: 1.3526, lng: 103.9442 },
  { name: "Jurong West", lat: 1.3404, lng: 103.7069 },
  { name: "Woodlands", lat: 1.4382, lng: 103.7890 },
  { name: "Punggol", lat: 1.4043, lng: 103.9020 },
  { name: "Sengkang", lat: 1.3909, lng: 103.8958 },
  { name: "Yishun", lat: 1.4290, lng: 103.8357 },
  { name: "Bedok", lat: 1.3240, lng: 103.9301 },
  { name: "Ang Mo Kio", lat: 1.3691, lng: 103.8454 },
];

const SG_DESTINATIONS = [
  { name: "Orchard Road", lat: 1.3048, lng: 103.8318 },
  { name: "Marina Bay Sands", lat: 1.2834, lng: 103.8607 },
  { name: "Gardens by the Bay", lat: 1.2816, lng: 103.8636 },
  { name: "VivoCity", lat: 1.2644, lng: 103.8223 },
  { name: "Sentosa", lat: 1.2494, lng: 103.8303 },
  { name: "East Coast Park", lat: 1.3002, lng: 103.9128 },
  { name: "Jewel Changi", lat: 1.3603, lng: 103.9899 },
  { name: "Singapore Zoo", lat: 1.4043, lng: 103.7930 },
];

function printUsage() {
  console.log(`
Usage: node scripts/simulateMobilePresence.mjs [options]

Options:
  --base-url <url>        Backend base URL (default: ${DEFAULTS.baseUrl})
  --users <n>             Number of simulated mobile users (default: ${DEFAULTS.users})
  --interval-ms <ms>      Update interval in milliseconds (default: ${DEFAULTS.intervalMs})
  --duration-sec <sec>    Stop after N seconds, 0 = run forever (default: ${DEFAULTS.durationSec})
  --center-lat <lat>      Simulation center latitude (default: ${DEFAULTS.centerLat})
  --center-lng <lng>      Simulation center longitude (default: ${DEFAULTS.centerLng})
  --radius-m <m>          Spawn radius in meters around center (default: ${DEFAULTS.radiusM})
  --drift-m <m>           Max movement per tick in meters (default: ${DEFAULTS.driftM})
  --mode <name>           Movement mode: random | converge | disperse-converge | sg-commute (default: ${DEFAULTS.mode})
  --target-lat <lat>      Converge target latitude (default: ${DEFAULTS.targetLat})
  --target-lng <lng>      Converge target longitude (default: ${DEFAULTS.targetLng})
  --cluster-radius-m <m>  Radius for target clustering (default: ${DEFAULTS.clusterRadiusM})
  --cycle-sec <sec>       Cycle length for disperse-converge / sg-commute (default: ${DEFAULTS.cycleSec})
  --disperse-ratio <r>    Part of cycle spent dispersing [0.1..0.9] (default: ${DEFAULTS.disperseRatio})
  --source <name>         Source label attached to each update (default: ${DEFAULTS.source})
  --help                  Show this help
`);
}

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
    const next = argv[i + 1];
    if (next == null) continue;
    switch (a) {
      case "--base-url":
        out.baseUrl = String(next).replace(/\/+$/, "");
        i += 1;
        break;
      case "--users":
        out.users = Math.max(1, Number(next) || DEFAULTS.users);
        i += 1;
        break;
      case "--interval-ms":
        out.intervalMs = Math.max(250, Number(next) || DEFAULTS.intervalMs);
        i += 1;
        break;
      case "--duration-sec":
        out.durationSec = Math.max(0, Number(next) || DEFAULTS.durationSec);
        i += 1;
        break;
      case "--center-lat":
        out.centerLat = Number(next) || DEFAULTS.centerLat;
        i += 1;
        break;
      case "--center-lng":
        out.centerLng = Number(next) || DEFAULTS.centerLng;
        i += 1;
        break;
      case "--radius-m":
        out.radiusM = Math.max(100, Number(next) || DEFAULTS.radiusM);
        i += 1;
        break;
      case "--drift-m":
        out.driftM = Math.max(1, Number(next) || DEFAULTS.driftM);
        i += 1;
        break;
      case "--mode":
        {
          const mode = String(next || DEFAULTS.mode).toLowerCase();
          if (mode === "converge" || mode === "disperse-converge" || mode === "sg-commute") {
            out.mode = mode;
          } else {
            out.mode = "random";
          }
        }
        i += 1;
        break;
      case "--target-lat":
        out.targetLat = Number(next) || DEFAULTS.targetLat;
        i += 1;
        break;
      case "--target-lng":
        out.targetLng = Number(next) || DEFAULTS.targetLng;
        i += 1;
        break;
      case "--cluster-radius-m":
        out.clusterRadiusM = Math.max(50, Number(next) || DEFAULTS.clusterRadiusM);
        i += 1;
        break;
      case "--cycle-sec":
        out.cycleSec = Math.max(30, Number(next) || DEFAULTS.cycleSec);
        i += 1;
        break;
      case "--disperse-ratio":
        out.disperseRatio = clamp(Number(next) || DEFAULTS.disperseRatio, 0.1, 0.9);
        i += 1;
        break;
      case "--source":
        out.source = String(next) || DEFAULTS.source;
        i += 1;
        break;
      default:
        break;
    }
  }
  return out;
}

function metersToLat(m) {
  return m / 111_320;
}

function metersToLng(m, lat) {
  return m / (111_320 * Math.cos((lat * Math.PI) / 180));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function makeInitialUsers(opts) {
  const users = [];
  if (opts.mode === "sg-commute") {
    for (let i = 0; i < opts.users; i += 1) {
      const homeBase = SG_RESIDENTIAL_CENTERS[Math.floor(Math.random() * SG_RESIDENTIAL_CENTERS.length)];
      const destination = SG_DESTINATIONS[Math.floor(Math.random() * SG_DESTINATIONS.length)];
      const homeJitter = randomBetween(40, 700);
      const homeAngle = randomBetween(0, Math.PI * 2);
      const homeLat = homeBase.lat + metersToLat(Math.sin(homeAngle) * homeJitter);
      const homeLng = homeBase.lng + metersToLng(Math.cos(homeAngle) * homeJitter, homeBase.lat);
      users.push({
        userId: `U_SIM_${String(i + 1).padStart(4, "0")}`,
        lat: homeLat,
        lng: homeLng,
        heading: randomBetween(0, Math.PI * 2),
        homeLat,
        homeLng,
        targetLat: destination.lat,
        targetLng: destination.lng,
        phaseOffsetMs: Math.floor(randomBetween(0, opts.cycleSec * 1000)),
        lastCycle: -1,
      });
    }
    return users;
  }

  if (opts.mode === "converge") {
    const spawnDistanceM = Math.max(1200, opts.radiusM);
    const latDelta = metersToLat(spawnDistanceM);
    const lngDelta = metersToLng(spawnDistanceM, opts.targetLat);
    const anchors = [
      { lat: opts.targetLat + latDelta, lng: opts.targetLng }, // north
      { lat: opts.targetLat, lng: opts.targetLng + lngDelta }, // east
      { lat: opts.targetLat - latDelta, lng: opts.targetLng }, // south
      { lat: opts.targetLat, lng: opts.targetLng - lngDelta }, // west
    ];

    for (let i = 0; i < opts.users; i += 1) {
      const anchor = anchors[i % anchors.length];
      const angle = randomBetween(0, Math.PI * 2);
      const jitterM = randomBetween(80, spawnDistanceM * 0.28);
      const lat = anchor.lat + metersToLat(Math.sin(angle) * jitterM);
      const lng = anchor.lng + metersToLng(Math.cos(angle) * jitterM, anchor.lat);
      users.push({
        userId: `U_SIM_${String(i + 1).padStart(4, "0")}`,
        lat,
        lng,
        heading: randomBetween(0, Math.PI * 2),
      });
    }
    return users;
  }

  if (opts.mode === "disperse-converge") {
    for (let i = 0; i < opts.users; i += 1) {
      const angle = randomBetween(0, Math.PI * 2);
      const radius = randomBetween(0, Math.max(40, opts.clusterRadiusM));
      const lat = opts.targetLat + metersToLat(Math.sin(angle) * radius);
      const lng = opts.targetLng + metersToLng(Math.cos(angle) * radius, opts.targetLat);
      users.push({
        userId: `U_SIM_${String(i + 1).padStart(4, "0")}`,
        lat,
        lng,
        heading: randomBetween(0, Math.PI * 2),
      });
    }
    return users;
  }

  for (let i = 0; i < opts.users; i += 1) {
    const angle = randomBetween(0, Math.PI * 2);
    const radius = randomBetween(0, opts.radiusM);
    const lat = opts.centerLat + metersToLat(Math.sin(angle) * radius);
    const lng = opts.centerLng + metersToLng(Math.cos(angle) * radius, opts.centerLat);
    users.push({
      userId: `U_SIM_${String(i + 1).padStart(4, "0")}`,
      lat,
      lng,
      heading: randomBetween(0, Math.PI * 2),
    });
  }
  return users;
}

function stepUserRandom(user, opts) {
  const headingDelta = randomBetween(-0.55, 0.55);
  const stepM = randomBetween(opts.driftM * 0.25, opts.driftM);
  const heading = user.heading + headingDelta;
  const dLat = metersToLat(Math.sin(heading) * stepM);
  const dLng = metersToLng(Math.cos(heading) * stepM, user.lat);
  const nextLat = user.lat + dLat;
  const nextLng = user.lng + dLng;

  // Keep user around center in a bounded region.
  const maxLatDelta = metersToLat(opts.radiusM);
  const maxLngDelta = metersToLng(opts.radiusM, opts.centerLat);
  user.lat = clamp(nextLat, opts.centerLat - maxLatDelta, opts.centerLat + maxLatDelta);
  user.lng = clamp(nextLng, opts.centerLng - maxLngDelta, opts.centerLng + maxLngDelta);
  user.heading = heading;
}

function stepUserConverge(user, opts) {
  const dLatM = (opts.targetLat - user.lat) * 111320;
  const lngScale = Math.cos((user.lat * Math.PI) / 180);
  const dLngM = (opts.targetLng - user.lng) * 111320 * lngScale;
  const distanceM = Math.hypot(dLatM, dLngM);

  if (distanceM > opts.clusterRadiusM) {
    const stepM = randomBetween(opts.driftM * 1.8, opts.driftM * 3.8);
    const ratio = Math.min(1, stepM / distanceM);
    const jitterAngle = randomBetween(-0.35, 0.35);
    const baseHeading = Math.atan2(dLatM, dLngM) + jitterAngle;
    const moveLatM = Math.sin(baseHeading) * stepM;
    const moveLngM = Math.cos(baseHeading) * stepM;
    user.lat += metersToLat(moveLatM) * ratio * 1.5;
    user.lng += metersToLng(moveLngM, user.lat) * ratio * 1.5;
    user.heading = baseHeading;
    return;
  }

  // When users reach target, keep a clustered circulating motion.
  const heading = user.heading + randomBetween(-0.9, 0.9);
  const stepM = randomBetween(opts.driftM * 0.4, opts.driftM * 1.2);
  const dLat = metersToLat(Math.sin(heading) * stepM);
  const dLng = metersToLng(Math.cos(heading) * stepM, user.lat);
  const nextLat = user.lat + dLat;
  const nextLng = user.lng + dLng;

  const toTargetLatM = (nextLat - opts.targetLat) * 111320;
  const toTargetLngM = (nextLng - opts.targetLng) * 111320 * Math.cos((nextLat * Math.PI) / 180);
  const nextDistance = Math.hypot(toTargetLatM, toTargetLngM);

  if (nextDistance > opts.clusterRadiusM * 1.35) {
    const pull = 0.45;
    user.lat = nextLat + (opts.targetLat - nextLat) * pull;
    user.lng = nextLng + (opts.targetLng - nextLng) * pull;
  } else {
    user.lat = nextLat;
    user.lng = nextLng;
  }
  user.heading = heading;
}

function moveToward(user, targetLat, targetLng, minStepM, maxStepM) {
  const dLatM = (targetLat - user.lat) * 111320;
  const lngScale = Math.cos((user.lat * Math.PI) / 180);
  const dLngM = (targetLng - user.lng) * 111320 * lngScale;
  const distanceM = Math.hypot(dLatM, dLngM);
  if (distanceM < 1) return distanceM;
  const heading = Math.atan2(dLatM, dLngM) + randomBetween(-0.2, 0.2);
  const stepM = randomBetween(minStepM, maxStepM);
  const ratio = Math.min(1, stepM / distanceM);
  user.lat += metersToLat(Math.sin(heading) * stepM) * ratio;
  user.lng += metersToLng(Math.cos(heading) * stepM, user.lat) * ratio;
  user.heading = heading;
  return distanceM;
}

function wanderAround(user, centerLat, centerLng, radiusM, driftM) {
  const step = randomBetween(driftM * 0.45, driftM * 1.35);
  const heading = user.heading + randomBetween(-1.0, 1.0);
  const nextLat = user.lat + metersToLat(Math.sin(heading) * step);
  const nextLng = user.lng + metersToLng(Math.cos(heading) * step, user.lat);
  const dLatM = (nextLat - centerLat) * 111320;
  const dLngM = (nextLng - centerLng) * 111320 * Math.cos((nextLat * Math.PI) / 180);
  const distanceM = Math.hypot(dLatM, dLngM);
  if (distanceM > radiusM) {
    user.lat = nextLat + (centerLat - nextLat) * 0.45;
    user.lng = nextLng + (centerLng - nextLng) * 0.45;
  } else {
    user.lat = nextLat;
    user.lng = nextLng;
  }
  user.heading = heading;
}

function stepUserDisperse(user, opts) {
  const awayLatM = (user.lat - opts.targetLat) * 111320;
  const awayLngM = (user.lng - opts.targetLng) * 111320 * Math.cos((user.lat * Math.PI) / 180);
  const distanceM = Math.hypot(awayLatM, awayLngM);
  const outerLimitM = Math.max(opts.radiusM, opts.clusterRadiusM * 6);

  if (distanceM >= outerLimitM) {
    stepUserRandom(user, {
      ...opts,
      centerLat: user.lat,
      centerLng: user.lng,
      radiusM: opts.driftM * 4,
    });
    return;
  }

  let headingAway = Math.atan2(awayLatM, awayLngM);
  if (!Number.isFinite(headingAway) || distanceM < 5) {
    headingAway = randomBetween(0, Math.PI * 2);
  }
  headingAway += randomBetween(-0.45, 0.45);
  const stepM = randomBetween(opts.driftM * 1.3, opts.driftM * 2.8);
  user.lat += metersToLat(Math.sin(headingAway) * stepM);
  user.lng += metersToLng(Math.cos(headingAway) * stepM, user.lat);
  user.heading = headingAway;
}

function stepUserSgCommute(user, opts, tickState) {
  const cycleMs = Math.max(1, opts.cycleSec * 1000);
  const elapsed = Math.max(0, tickState.now - tickState.startedAt) + (user.phaseOffsetMs || 0);
  const cycleProgress = (elapsed % cycleMs) / cycleMs;
  const cycleIndex = Math.floor(elapsed / cycleMs);

  if (user.lastCycle !== cycleIndex) {
    const destination = SG_DESTINATIONS[Math.floor(Math.random() * SG_DESTINATIONS.length)];
    user.targetLat = destination.lat;
    user.targetLng = destination.lng;
    user.lastCycle = cycleIndex;
  }

  // Four phases: home -> destination, stay around destination, destination -> home, stay around home.
  if (cycleProgress < 0.38) {
    moveToward(user, user.targetLat, user.targetLng, opts.driftM * 2.4, opts.driftM * 5.4);
    return;
  }
  if (cycleProgress < 0.62) {
    wanderAround(user, user.targetLat, user.targetLng, Math.max(80, opts.clusterRadiusM), opts.driftM * 1.6);
    return;
  }
  if (cycleProgress < 0.9) {
    moveToward(user, user.homeLat, user.homeLng, opts.driftM * 2.2, opts.driftM * 5.0);
    return;
  }
  wanderAround(user, user.homeLat, user.homeLng, 160, opts.driftM * 1.5);
}

function stepUser(user, opts, tickState) {
  if (opts.mode === "converge") {
    stepUserConverge(user, opts);
    return;
  }

  if (opts.mode === "sg-commute") {
    stepUserSgCommute(user, opts, tickState);
    return;
  }

  if (opts.mode === "disperse-converge") {
    const cycleMs = opts.cycleSec * 1000;
    const elapsedMs = Math.max(0, tickState.now - tickState.startedAt);
    const cycleProgress = cycleMs > 0 ? (elapsedMs % cycleMs) / cycleMs : 0;
    if (cycleProgress < opts.disperseRatio) {
      stepUserDisperse(user, opts);
      return;
    }
    stepUserConverge(user, opts);
    return;
  }

  stepUserRandom(user, opts);
}

async function postPresence(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/presence/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${msg}`.trim());
  }
}

async function tick(users, opts, tickState) {
  const ts = Date.now();
  users.forEach((u) => stepUser(u, opts, { ...tickState, now: ts }));

  const jobs = users.map((u) =>
    postPresence(opts.baseUrl, {
      userId: u.userId,
      lat: u.lat,
      lng: u.lng,
      ts,
      source: opts.source,
    })
  );
  const results = await Promise.allSettled(jobs);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const fail = results.length - ok;
  return { ok, fail, ts };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const users = makeInitialUsers(opts);
  const startedAt = Date.now();
  const endAt = opts.durationSec > 0 ? startedAt + opts.durationSec * 1000 : Number.POSITIVE_INFINITY;

  console.log(
    `[sim] start users=${opts.users} intervalMs=${opts.intervalMs} mode=${opts.mode} center=${opts.centerLat.toFixed(5)},${opts.centerLng.toFixed(5)} baseUrl=${opts.baseUrl}`
  );
  console.log(
    `[sim] source=${opts.source} radiusM=${opts.radiusM} driftM=${opts.driftM} target=${opts.targetLat.toFixed(5)},${opts.targetLng.toFixed(5)} clusterRadiusM=${opts.clusterRadiusM} cycleSec=${opts.cycleSec} disperseRatio=${opts.disperseRatio}`
  );

  let stopped = false;
  process.on("SIGINT", () => {
    if (!stopped) {
      stopped = true;
      console.log("\n[sim] stopping...");
    }
  });

  while (!stopped && Date.now() < endAt) {
    const { ok, fail, ts } = await tick(users, opts, { startedAt });
    const stamp = new Date(ts).toLocaleTimeString();
    if (fail > 0) {
      console.log(`[sim ${stamp}] ok=${ok} fail=${fail}`);
    } else {
      console.log(`[sim ${stamp}] ok=${ok}`);
    }
    if (Date.now() >= endAt) break;
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }

  console.log("[sim] done");
}

main().catch((err) => {
  console.error("[sim] fatal:", err);
  process.exit(1);
});
