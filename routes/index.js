var express = require('express');
var router = express.Router();
var db = require('../db');

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */

const ROLE_LOGIN_PATH = {
  admin: '/login-admin',
  driver: '/login-driver',
  student: '/login-student',
};

const PERIODS = ['regular', 'examination', 'summer', 'winter', 'special'];

// Enforces backend-side Role-Based Access Control. Hiding buttons in the
// frontend is not enough - every state-changing route (and every dashboard)
// re-checks the session role here before touching the database.
function requireRole(role) {
  return function (req, res, next) {
    if (!req.session || !req.session.user) {
      return res.redirect(ROLE_LOGIN_PATH[role] || '/login-admin');
    }
    if (req.session.user.role !== role) {
      return res.status(403).render('error', {
        title: 'Forbidden',
        message: 'You do not have permission to access this page.',
        error: { status: 403 },
      });
    }
    next();
  };
}

function setFlash(req, type, text) {
  req.session.flash = { type, text };
}

function popFlash(req) {
  const flash = req.session.flash || null;
  delete req.session.flash;
  return flash;
}

// Student ID is the official ID issued by the university - it is
// REQUIRED at signup (both self-signup and Admin-created accounts) and
// is never auto-generated. This only checks/normalizes what the person
// typed; optionalExcludeId lets an Admin update the same student's own
// record without tripping over its own current student_id.
async function validateStudentId(providedStudentId, optionalExcludeId) {
  const trimmed = cleanText(providedStudentId);
  if (!trimmed) {
    return { ok: false, error: 'Student ID is required.' };
  }
  const existing = await db.get('SELECT id FROM students WHERE student_id = ?', [trimmed]);
  if (existing && (!optionalExcludeId || String(existing.id) !== String(optionalExcludeId))) {
    return { ok: false, error: 'That Student ID is already registered to another account.' };
  }
  return { ok: true, studentId: trimmed };
}

function cleanText(value) {
  return (value || '').toString().trim();
}

function emptyToNull(value) {
  const trimmed = cleanText(value);
  return trimmed === '' ? null : trimmed;
}

function safePeriod(value) {
  return PERIODS.includes(value) ? value : 'regular';
}

/* ================================================================== */
/* Shared data loaders                                                 */
/* ================================================================== */

async function getActiveRoutesWithStops() {
  const routes = await db.all('SELECT * FROM routes WHERE status = ? ORDER BY route_name ASC', ['active']);
  const stops = await db.all('SELECT * FROM stops WHERE status = ? ORDER BY route_id ASC, stop_order ASC', ['active']);
  return routes.map((route) => ({
    ...route,
    stops: stops.filter((stop) => stop.route_id === route.id),
  }));
}

async function getSchedulesForPeriod(period) {
  return db.all(
    `SELECT s.*, b.bus_number, b.bus_name, r.route_name
     FROM schedules s
     JOIN buses b ON b.id = s.bus_id
     JOIN routes r ON r.id = s.route_id
     WHERE s.period = ? AND s.status = 'active'
     ORDER BY r.route_name ASC, COALESCE(s.arrival_time, s.departure_time) ASC`,
    [period]
  );
}

// Notices can now come from a Driver (delay/breakdown report) OR an
// Admin (general/not-running notice) - LEFT JOINed so an Admin notice
// (no driver_id) is never silently dropped from any of the pages that
// list notices. posted_by is what every view actually prints; bus_number/
// bus_name prefer the notice's OWN bus (set at report time, so it never
// drifts if that driver is later reassigned to a different bus) and only
// fall back to the driver's current bus for old, pre-migration rows that
// predate that column.
async function getRecentNotices(limit) {
  return db.all(
    `SELECT n.*,
            COALESCE(d.full_name, CONCAT('Admin', IF(a.full_name IS NOT NULL, CONCAT(' - ', a.full_name), ''))) AS posted_by,
            b.bus_number, b.bus_name,
            r.route_name,
            s.stop_name
     FROM notices n
     LEFT JOIN drivers d ON d.id = n.driver_id
     LEFT JOIN admins a ON a.id = n.admin_id
     LEFT JOIN buses b ON b.id = COALESCE(n.bus_id, d.bus_id)
     LEFT JOIN routes r ON r.id = n.route_id
     LEFT JOIN stops s ON s.id = n.stop_id
     ORDER BY n.created_at DESC
     LIMIT ?`,
    [limit || 50]
  );
}

/* ---- Driver Trip lifecycle (Start / End / Report Breakdown) --------- */
/* A "trip" is one run of a bus, started/ended/reported-broken-down by    */
/* its driver - this is what powers the Driver's "Current Trip" card and  */
/* Admin's "Live Trips & Breakdowns" tab. Passenger boarding/counting is   */
/* no longer part of the student-facing workflow (see trip_boardings'     */
/* comment in db.js), so passenger_count below is always 0 for any trip   */
/* going forward - it is computed here only so nothing breaks for a       */
/* driver's older trips that do have real boarding rows on an existing,   */
/* already-running installation of this project.                         */

// A single trip (any status) with its bus/route/driver details - used
// for the driver's "Current Trip" card.
async function getTripWithCount(tripId) {
  return db.get(
    `SELECT t.*, b.bus_number, b.bus_name, b.capacity, r.route_name, d.full_name AS driver_name,
            (SELECT COUNT(*) FROM trip_boardings tb WHERE tb.trip_id = t.id) AS passenger_count
     FROM trips t
     JOIN buses b ON b.id = t.bus_id
     JOIN drivers d ON d.id = t.driver_id
     LEFT JOIN routes r ON r.id = t.route_id
     WHERE t.id = ?`,
    [tripId]
  );
}

/* ---- Find Your Bus (stop search + live status from notices) --------- */

// Distinct real stop names for the search dropdown - never hard-coded.
async function getSearchableStopNames() {
  const rows = await db.all(
    `SELECT DISTINCT stop_name FROM stops
     WHERE status = 'active' AND stop_name != 'Metropolitan University Campus'
     ORDER BY stop_name ASC`
  );
  return rows.map((r) => r.stop_name);
}

// Very small, transparent keyword read of a driver's own notice text - the
// notice itself is always shown alongside the badge, so the heuristic never
// hides the real message.
function isDelayNotice(message) {
  const text = (message || '').toLowerCase();
  const delayWords = ['late', 'delay', 'traffic', 'congestion', 'jam', 'behind schedule'];
  return delayWords.some((w) => text.includes(w));
}

// Reads an explicit "X minutes/min" figure out of the driver's own words
// (e.g. "approximately 15 minutes late"). If the driver didn't give a
// number, DEFAULT_DELAY_MINUTES is used as a reasonable estimate so the
// feature still works instead of failing to compute anything.
function extractDelayMinutes(message) {
  const match = (message || '').toLowerCase().match(/(\d+)\s*(?:minutes?|mins?)/);
  return match ? parseInt(match[1], 10) : null;
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string' || !timeStr.includes(':')) return null;
  const [h, m] = timeStr.split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToTimeStr(totalMinutes) {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// A bus's most recent notice, but only if it was posted today - an older
// notice is stale and must never be shown as if it were current. Because
// this always reads the NEWEST notice for the bus, it automatically covers
// "is there an updated/newer delay" - there is never an older notice hiding
// behind it that this query would miss.
async function getTodaysNoticeForBus(busId) {
  const notice = await db.get(
    `SELECT n.message, n.created_at
     FROM notices n
     JOIN drivers d ON d.id = n.driver_id
     WHERE d.bus_id = ?
     ORDER BY n.created_at DESC
     LIMIT 1`,
    [busId]
  );
  if (!notice) return null;
  const noticeDate = (notice.created_at || '').slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return noticeDate === today ? notice : null;
}

const ARRIVING_SOON_MINUTES = 15; // within this many minutes before the scheduled time
const DEFAULT_DELAY_MINUTES = 20; // fallback estimate when a delay notice gives no explicit figure

// The status for ONE specific stop time, recalculated fresh on every
// search using: the student's current search time, that stop's scheduled
// time, and any active driver delay - never the scheduled time alone.
//
// Priority:
//   1. An active delay notice for an imminent/just-due run: compute its
//      estimated arrival (scheduled + reported delay). If "now" is still
//      at or before that estimate, the bus has NOT reached the stop yet -
//      show Delayed + the estimated time, never "Already Passed".
//   2. If that estimated delayed time has ALSO passed, this notice is
//      already the newest one on file (see getTodaysNoticeForBus), so
//      there is no newer update - fall through to the plain schedule
//      comparison below, which will correctly land on "Already Passed".
//   3. No active delay at all: compare now vs. the original scheduled
//      time directly - before it is On Time/Arriving Soon, after it is
//      Already Passed. "On Time" is never shown once the time has gone by.
function computeStopStatus(scheduledTime, todaysNotice, stopName, now) {
  const scheduledMinutes = parseTimeToMinutes(scheduledTime);
  if (scheduledMinutes === null) {
    return { code: 'unknown', label: 'Schedule Unavailable', detail: null, estimatedTime: null, message: todaysNotice ? todaysNotice.message : null };
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const delayed = todaysNotice && isDelayNotice(todaysNotice.message);

  // A delay notice can only plausibly describe THIS schedule slot if the
  // slot itself is imminent or already due - never a distinct, materially
  // later run still hours away (a morning delay must not leak onto an
  // evening trip for the same bus).
  const slotIsImminentOrDue = scheduledMinutes <= nowMinutes + ARRIVING_SOON_MINUTES;

  if (delayed && slotIsImminentOrDue) {
    const reportedDelay = extractDelayMinutes(todaysNotice.message);
    const effectiveDelay = reportedDelay === null ? DEFAULT_DELAY_MINUTES : reportedDelay;
    const estimatedMinutes = scheduledMinutes + effectiveDelay;

    if (nowMinutes <= estimatedMinutes) {
      return {
        code: 'delayed',
        label: 'Delayed',
        detail: null,
        estimatedTime: minutesToTimeStr(estimatedMinutes),
        message: todaysNotice.message,
      };
    }
    // Estimated delayed arrival has also passed, and there is no newer
    // notice than this one - falls through to the passed/on-time check.
  }

  const minutesUntilScheduled = scheduledMinutes - nowMinutes;

  if (minutesUntilScheduled < 0) {
    return {
      code: 'passed',
      label: 'Already Passed This Stop',
      detail: `This bus has already passed ${stopName} today.`,
      estimatedTime: null,
      message: todaysNotice ? todaysNotice.message : null,
    };
  }

  if (minutesUntilScheduled <= ARRIVING_SOON_MINUTES) {
    return {
      code: 'arriving_soon',
      label: 'Arriving Soon',
      detail: null,
      estimatedTime: null,
      message: todaysNotice ? todaysNotice.message : null,
    };
  }

  return {
    code: 'on_time',
    label: 'On Time',
    detail: null,
    estimatedTime: null,
    message: todaysNotice ? todaysNotice.message : null,
  };
}

// Every bus whose route serves the given stop, for the current Regular
// schedule, in the requested direction - each joined live to its own
// time-aware, notice-aware status for that specific scheduled time.
async function findBusesForStop(stopName, direction) {
  const timeColumn = direction === 'from_campus' ? 'departure_time' : 'arrival_time';
  const rows = await db.all(
    `SELECT DISTINCT sc.id AS schedule_id, sc.arrival_time, sc.departure_time, sc.operating_days, sc.notes,
            b.id AS bus_id, b.bus_number, b.bus_name,
            r.id AS route_id, r.route_name
     FROM schedules sc
     JOIN buses b ON b.id = sc.bus_id
     JOIN routes r ON r.id = sc.route_id
     JOIN stops st ON st.route_id = r.id
     WHERE st.stop_name = ? AND st.status = 'active'
       AND sc.status = 'active' AND sc.period = 'regular'
       AND sc.${timeColumn} IS NOT NULL
     ORDER BY sc.${timeColumn} ASC`,
    [stopName]
  );

  const now = new Date();
  const noticeCache = {};
  const results = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const row of rows) {
    if (!(row.bus_id in noticeCache)) {
      noticeCache[row.bus_id] = await getTodaysNoticeForBus(row.bus_id); // eslint-disable-line no-await-in-loop
    }
    const scheduledTime = direction === 'from_campus' ? row.departure_time : row.arrival_time;
    const status = computeStopStatus(scheduledTime, noticeCache[row.bus_id], stopName, now);
    results.push({ ...row, status });
  }
  return results;
}

/* ================================================================== */
/* Student Dashboard - Route + Date Bus Status                         */
/*                                                                      */
/* A student picks a Route and a Date; every regular-period schedule    */
/* for that route is shown with a status computed fresh on every        */
/* request from three things only: the schedule's own scheduled time(s),*/
/* the selected date vs. today, and the most recent Driver/Admin notice */
/* that targets that exact bus (or, failing that, the whole route) on   */
/* that exact date - see computeScheduleStatus() below for the full     */
/* priority order. Nothing here is a stored/cached status - it is       */
/* always recalculated, so it can never go stale.                       */
/* ================================================================== */

const DELAY_REASONS = ['Traffic', 'Bus Problem', 'Other'];
const BREAKDOWN_REASONS = ['Mechanical Problem', 'Bus Fault', 'Other'];
const DELAY_DURATIONS = [10, 20, 30, 40, 60];

// Local (server) calendar date as YYYY-MM-DD - deliberately NOT
// toISOString(), which is UTC and would read as "yesterday" for several
// hours after local midnight. A student's "today" is the transport
// office's local today, so this always uses the server machine's own
// clock/timezone (XAMPP running locally, e.g. on the transport office's
// own computer, set to local time).
function todayDateStr(now) {
  const d = now || new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isValidDateStr(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// The plain-language label for whichever reason a Driver picked -
// "Other" is replaced with their own short explanation when they gave
// one, so the generated message below never just says "Other".
function reasonLabel(reason, reasonOther) {
  if (reason === 'Other' && cleanText(reasonOther)) {
    return cleanText(reasonOther);
  }
  return reason;
}

// These two build the one human-readable `message` stored on every
// notice row (and shown everywhere a notice already gets listed - the
// homepage, /notices, Recent Notices, Admin's Notice Management) directly
// from the structured fields a Driver picked - never free text - so a
// Breakdown report can never accidentally show delay-shaped wording, and
// vice versa (see Section 10 of the spec this project was built against).
function buildDelayMessage(reason, reasonOther, stopName, delayMinutes) {
  const label = reasonLabel(reason, reasonOther);
  const location = stopName ? ` near ${stopName}` : '';
  return `Delay reported: ${label}${location} (approx. ${delayMinutes} minutes).`;
}

function buildBreakdownMessage(reason, reasonOther, stopName) {
  const label = reasonLabel(reason, reasonOther);
  const location = stopName ? ` near ${stopName}` : '';
  return `Breakdown reported: ${label}${location}.`;
}

// The single most relevant notice for one schedule row on one date - a
// notice aimed at this EXACT bus wins if one exists; otherwise a
// route-wide notice (posted with no specific bus) applies to every bus
// on that route for that date. Either way, only ever the newest one -
// see the ORDER BY / LIMIT 1 - so a follow-up report always supersedes
// an earlier one instead of both applying at once.
async function getActiveNoticeForSchedule(busId, routeId, dateStr) {
  let notice = await db.get(
    `SELECT n.*, s.stop_name
     FROM notices n
     LEFT JOIN stops s ON s.id = n.stop_id
     WHERE n.notice_date = ? AND n.bus_id = ?
     ORDER BY n.created_at DESC
     LIMIT 1`,
    [dateStr, busId]
  );
  if (!notice && routeId) {
    notice = await db.get(
      `SELECT n.*, s.stop_name
       FROM notices n
       LEFT JOIN stops s ON s.id = n.stop_id
       WHERE n.notice_date = ? AND n.route_id = ? AND n.bus_id IS NULL
       ORDER BY n.created_at DESC
       LIMIT 1`,
      [dateStr, routeId]
    );
  }
  return notice || null;
}

// The status for ONE schedule row on ONE selected date - see the spec's
// status definitions (Section 5): a Delayed/Breakdown/Not Running notice
// always wins first; a purely informational ("general") notice never
// changes the status, only rides along as an extra message; otherwise
// the status is worked out from the date/time alone.
function computeScheduleStatus(schedule, targetDateStr, todayStr, notice, now) {
  if (notice && notice.notice_type === 'not_running') {
    return { code: 'not_running', label: 'Not Running', notice };
  }
  if (notice && notice.notice_type === 'breakdown') {
    return { code: 'breakdown', label: 'Breakdown', notice };
  }
  if (notice && notice.notice_type === 'delayed') {
    const delayMinutes = notice.delay_minutes || 0;
    const schedArrival = parseTimeToMinutes(schedule.arrival_time);
    const schedDeparture = parseTimeToMinutes(schedule.departure_time);
    return {
      code: 'delayed',
      label: 'Delayed',
      notice,
      delayMinutes,
      estimatedArrival: schedArrival === null ? null : minutesToTimeStr(schedArrival + delayMinutes),
      estimatedDeparture: schedDeparture === null ? null : minutesToTimeStr(schedDeparture + delayMinutes),
    };
  }

  const infoMessage = notice && notice.notice_type === 'general' ? notice : null;

  if (targetDateStr > todayStr) {
    return { code: 'on_time', label: 'On Time', notice: infoMessage };
  }
  if (targetDateStr < todayStr) {
    return { code: 'departed', label: 'Departed', notice: infoMessage };
  }

  const times = [parseTimeToMinutes(schedule.arrival_time), parseTimeToMinutes(schedule.departure_time)].filter(
    (m) => m !== null
  );
  if (times.length === 0) {
    return { code: 'on_time', label: 'On Time', notice: infoMessage };
  }
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const latestScheduled = Math.max(...times);
  if (nowMinutes > latestScheduled) {
    return { code: 'departed', label: 'Departed', notice: infoMessage };
  }
  return { code: 'upcoming', label: 'Upcoming', notice: infoMessage };
}

// Every regular-period schedule for one route on one date, each with its
// own freshly-computed status. One notice lookup per distinct bus (a bus
// can have several schedule rows, e.g. a shuttle running back and forth)
// - cached here so it is never queried twice for the same bus.
async function getRouteBusStatusForDate(routeId, dateStr, todayStr) {
  const schedules = await db.all(
    `SELECT sc.*, b.bus_number, b.bus_name, r.route_name
     FROM schedules sc
     JOIN buses b ON b.id = sc.bus_id
     JOIN routes r ON r.id = sc.route_id
     WHERE sc.route_id = ? AND sc.status = 'active' AND sc.period = 'regular'
     ORDER BY COALESCE(sc.arrival_time, sc.departure_time) ASC`,
    [routeId]
  );
  const now = new Date();
  const noticeCache = {};
  const results = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const schedule of schedules) {
    if (!(schedule.bus_id in noticeCache)) {
      noticeCache[schedule.bus_id] = await getActiveNoticeForSchedule(schedule.bus_id, routeId, dateStr); // eslint-disable-line no-await-in-loop
    }
    const status = computeScheduleStatus(schedule, dateStr, todayStr, noticeCache[schedule.bus_id], now);
    results.push({ ...schedule, status });
  }
  return results;
}

/* ================================================================== */
/* Public pages                                                        */
/* ================================================================== */

router.get('/', async function (req, res, next) {
  try {
    const popularRoutes = await db.all(
      `SELECT r.*, MIN(s.departure_time) AS departure_time, MIN(s.arrival_time) AS arrival_time
       FROM routes r
       LEFT JOIN schedules s ON s.route_id = r.id AND s.status = 'active' AND s.period = 'regular'
       WHERE r.status = 'active'
       GROUP BY r.id
       ORDER BY r.id ASC
       LIMIT 4`
    );
    const latestNotices = await getRecentNotices(3);

    // Find Your Bus: always load the stop options; only run the search
    // itself when a stop was actually submitted.
    const stopOptions = await getSearchableStopNames();
    const selectedStop = cleanText(req.query.stop);
    const direction = req.query.direction === 'from_campus' ? 'from_campus' : 'to_campus';
    let busSearchResults = null;
    if (selectedStop) {
      busSearchResults = await findBusesForStop(selectedStop, direction);
    }

    res.render('index', {
      title: 'STMS Home',
      user: req.session && req.session.user ? req.session.user : null,
      popularRoutes,
      latestNotices,
      stopOptions,
      selectedStop,
      direction,
      busSearchResults,
      flash: popFlash(req),
    });
  } catch (err) {
    console.error(err);
    res.render('index', {
      title: 'STMS Home',
      user: req.session && req.session.user ? req.session.user : null,
      popularRoutes: [],
      latestNotices: [],
      stopOptions: [],
      selectedStop: '',
      direction: 'to_campus',
      busSearchResults: null,
      flash: { type: 'error', text: 'Unable to load your home page right now.' },
    });
  }
});

/* GET routes page - dynamic, database-driven (no hard-coded routes/stops). */
router.get('/routes', async function (req, res, next) {
  try {
    const routes = await getActiveRoutesWithStops();
    res.render('routes', { title: 'Routes', user: req.session.user || null, routes });
  } catch (err) {
    next(err);
  }
});

/* GET timetable page - dynamic, database-driven, filterable by schedule period. */
router.get('/timetable', async function (req, res, next) {
  try {
    const period = safePeriod(req.query.period || 'regular');
    const schedules = await getSchedulesForPeriod(period);
    res.render('timetable', {
      title: 'Timetable',
      user: req.session.user || null,
      schedules,
      period,
      periods: PERIODS,
    });
  } catch (err) {
    next(err);
  }
});

/* GET notices page - dynamic, database-driven. */
router.get('/notices', async function (req, res, next) {
  try {
    const notices = await getRecentNotices(50);
    res.render('notices', { title: 'Notices', user: req.session.user || null, notices });
  } catch (err) {
    next(err);
  }
});

router.get('/about', function (req, res, next) {
  res.render('about', { title: 'About', user: req.session.user || null });
});

router.get('/contact', function (req, res, next) {
  res.render('contact', { title: 'Contact', user: req.session.user || null });
});

/* ================================================================== */
/* Authentication                                                      */
/* ================================================================== */

router.get('/login-admin', function (req, res, next) {
  res.render('login-admin', { title: 'Admin Login', message: '' });
});

router.post('/login-admin', async function (req, res, next) {
  try {
    const { username, password } = req.body;
    const admin = await db.get('SELECT * FROM admins WHERE username = ?', [cleanText(username)]);

    if (admin && db.verifyPassword(password, admin.password)) {
      req.session.user = { id: admin.id, role: 'admin', username: admin.username, fullName: admin.full_name };
      return res.redirect('/admin-panel');
    }

    res.render('login-admin', { title: 'Admin Login', message: 'Invalid admin credentials.' });
  } catch (err) {
    next(err);
  }
});

const STATUS_REDIRECT_MESSAGES = {
  pending: 'Your registration is still pending Admin approval. Please check back soon.',
  rejected: 'Your registration was rejected. Please contact the transport office.',
  suspended: 'Your account has been suspended. Please contact the transport office.',
};

router.get('/login-student', function (req, res, next) {
  const message = STATUS_REDIRECT_MESSAGES[req.query.status] || '';
  res.render('login-student', { title: 'Student Login', message });
});

router.post('/login-student', async function (req, res, next) {
  try {
    const { email, studentId, password } = req.body;
    const student = await db.get('SELECT * FROM students WHERE email = ? AND student_id = ?', [
      cleanText(email).toLowerCase(),
      cleanText(studentId),
    ]);

    if (!student || !db.verifyPassword(password, student.password)) {
      return res.render('login-student', {
        title: 'Student Login',
        message: 'Invalid student credentials or student ID does not match the registered record.',
      });
    }

    if (student.status === 'pending') {
      return res.render('login-student', {
        title: 'Student Login',
        message: 'Your registration is still pending Admin approval. Please check back soon.',
      });
    }
    if (student.status === 'rejected') {
      return res.render('login-student', {
        title: 'Student Login',
        message: 'Your registration was rejected. Please contact the transport office.',
      });
    }
    if (student.status === 'suspended') {
      return res.render('login-student', {
        title: 'Student Login',
        message: 'Your account has been suspended. Please contact the transport office.',
      });
    }

    req.session.user = {
      id: student.id,
      role: 'student',
      email: student.email,
      studentId: student.student_id,
      fullName: student.full_name,
    };
    return res.redirect('/student-dashboard');
  } catch (err) {
    next(err);
  }
});

router.get('/login-driver', function (req, res, next) {
  const message = req.query.status === 'inactive' ? 'Your driver account is currently deactivated. Please contact the Admin.' : '';
  res.render('login-driver', { title: 'Driver Login', message });
});

router.post('/login-driver', async function (req, res, next) {
  try {
    const { email, password } = req.body;
    const driver = await db.get('SELECT * FROM drivers WHERE email = ?', [cleanText(email).toLowerCase()]);

    if (!driver || !db.verifyPassword(password, driver.password)) {
      return res.render('login-driver', { title: 'Driver Login', message: 'Invalid driver credentials.' });
    }
    if (driver.status === 'inactive') {
      return res.render('login-driver', {
        title: 'Driver Login',
        message: 'Your driver account is currently deactivated. Please contact the Admin.',
      });
    }

    req.session.user = { id: driver.id, role: 'driver', email: driver.email, fullName: driver.full_name };
    return res.redirect('/driver-dashboard');
  } catch (err) {
    next(err);
  }
});

/* Student self-registration only. Drivers and admins can never self
   register - their accounts are created exclusively by an Admin, and the
   role is never trusted from client input. */
router.get('/signup', function (req, res, next) {
  res.render('signup', { title: 'Sign Up', message: '', success: false });
});

router.post('/signup', async function (req, res, next) {
  const { fullName, email, studentId, department, phone, password, confirmPassword } = req.body;

  if (!cleanText(fullName) || !cleanText(email) || !cleanText(studentId) || !cleanText(password)) {
    return res.render('signup', {
      title: 'Sign Up',
      message: 'Full name, university email, Student ID and password are all required.',
      success: false,
    });
  }
  if (password !== confirmPassword) {
    return res.render('signup', { title: 'Sign Up', message: 'Password and Confirm Password do not match.', success: false });
  }
  if (password.length < 6) {
    return res.render('signup', { title: 'Sign Up', message: 'Password must be at least 6 characters long.', success: false });
  }

  try {
    const idCheck = await validateStudentId(studentId);
    if (!idCheck.ok) {
      return res.render('signup', { title: 'Sign Up', message: idCheck.error, success: false });
    }
    const existingEmail = await db.get('SELECT id FROM students WHERE email = ?', [cleanText(email).toLowerCase()]);
    if (existingEmail) {
      return res.render('signup', {
        title: 'Sign Up',
        message: 'A student account with that university email already exists.',
        success: false,
      });
    }
    await db.run(
      'INSERT INTO students (full_name, email, student_id, department, phone, password, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [cleanText(fullName), cleanText(email).toLowerCase(), idCheck.studentId, emptyToNull(department), emptyToNull(phone), db.hashPassword(password), 'pending']
    );
    return res.render('signup', {
      title: 'Sign Up',
      message: `Registration submitted successfully with Student ID ${idCheck.studentId}. Your account is pending Admin approval - you will be able to log in once it is approved.`,
      success: true,
    });
  } catch (err) {
    console.error(err);
    return res.render('signup', {
      title: 'Sign Up',
      message: 'A student account with that email or student ID already exists. Please use different details.',
      success: false,
    });
  }
});

router.get('/logout', function (req, res, next) {
  req.session.destroy(() => res.redirect('/'));
});

/* ================================================================== */
/* Admin Panel                                                         */
/* ================================================================== */

const ADMIN_TABS = ['overview', 'students', 'drivers', 'buses', 'routes', 'stops', 'schedules', 'notices', 'trips'];

router.get('/admin-panel', requireRole('admin'), async function (req, res, next) {
  try {
    const tab = ADMIN_TABS.includes(req.query.tab) ? req.query.tab : 'overview';

    const [students, drivers, buses, routes, stops, schedules, notices, trips] = await Promise.all([
      db.all('SELECT * FROM students ORDER BY id DESC'),
      db.all(
        `SELECT d.*, b.bus_number, r.route_name
         FROM drivers d
         LEFT JOIN buses b ON b.id = d.bus_id
         LEFT JOIN routes r ON r.id = d.route_id
         ORDER BY d.id DESC`
      ),
      db.all(
        `SELECT bu.*, r.route_name, dr.full_name AS driver_name
         FROM buses bu
         LEFT JOIN routes r ON r.id = bu.route_id
         LEFT JOIN drivers dr ON dr.bus_id = bu.id
         ORDER BY bu.id DESC`
      ),
      db.all(
        `SELECT ro.*, (SELECT COUNT(*) FROM stops st WHERE st.route_id = ro.id) AS stop_count
         FROM routes ro ORDER BY ro.id DESC`
      ),
      db.all(
        `SELECT st.*, ro.route_name
         FROM stops st
         JOIN routes ro ON ro.id = st.route_id
         ORDER BY st.route_id ASC, st.stop_order ASC`
      ),
      db.all(
        `SELECT sc.*, b.bus_number, r.route_name
         FROM schedules sc
         JOIN buses b ON b.id = sc.bus_id
         JOIN routes r ON r.id = sc.route_id
         ORDER BY r.route_name ASC, sc.period ASC, COALESCE(sc.arrival_time, sc.departure_time) ASC`
      ),
      getRecentNotices(100),
      db.all(
        `SELECT t.*, b.bus_number, b.bus_name, r.route_name, d.full_name AS driver_name
         FROM trips t
         JOIN buses b ON b.id = t.bus_id
         JOIN drivers d ON d.id = t.driver_id
         LEFT JOIN routes r ON r.id = t.route_id
         ORDER BY t.created_at DESC
         LIMIT 100`
      ),
    ]);

    const stats = {
      totalStudents: students.length,
      pendingStudents: students.filter((s) => s.status === 'pending').length,
      totalDrivers: drivers.length,
      activeDrivers: drivers.filter((d) => d.status === 'active').length,
      totalBuses: buses.length,
      totalRoutes: routes.length,
      totalStops: stops.length,
      activeSchedules: schedules.filter((s) => s.status === 'active').length,
      totalNotices: notices.length,
      breakdownReports: trips.filter((t) => t.status === 'breakdown').length,
    };

    res.render('admin-panel', {
      title: 'Admin Panel',
      user: req.session.user,
      tab,
      stats,
      students,
      drivers,
      buses,
      routes,
      stops,
      schedules,
      notices: notices.slice(0, 8),
      allNotices: notices,
      trips,
      periods: PERIODS,
      todayStr: todayDateStr(new Date()),
      flash: popFlash(req),
    });
  } catch (err) {
    next(err);
  }
});

/* ---- Student management ------------------------------------------- */

router.post('/admin/students', requireRole('admin'), async function (req, res, next) {
  const { fullName, email, studentId, department, phone, password } = req.body;
  try {
    if (!cleanText(fullName) || !cleanText(email) || !cleanText(studentId) || !cleanText(password)) {
      setFlash(req, 'error', 'Full name, email, Student ID and password are all required.');
      return res.redirect('/admin-panel?tab=students');
    }
    const idCheck = await validateStudentId(studentId);
    if (!idCheck.ok) {
      setFlash(req, 'error', idCheck.error);
      return res.redirect('/admin-panel?tab=students');
    }
    await db.run(
      'INSERT INTO students (full_name, email, student_id, department, phone, password, status, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [cleanText(fullName), cleanText(email).toLowerCase(), idCheck.studentId, emptyToNull(department), emptyToNull(phone), db.hashPassword(password), 'approved']
    );
    setFlash(req, 'success', `Student account created and approved (ID: ${idCheck.studentId}).`);
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not create the student account. Email or Student ID may already be in use.');
  }
  res.redirect('/admin-panel?tab=students');
});

router.get('/admin/students/:id/edit', requireRole('admin'), async function (req, res, next) {
  try {
    const student = await db.get('SELECT * FROM students WHERE id = ?', [req.params.id]);
    if (!student) {
      setFlash(req, 'error', 'Student not found.');
      return res.redirect('/admin-panel?tab=students');
    }
    res.render('admin-edit-student', { title: 'Edit Student', user: req.session.user, student, flash: popFlash(req) });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/students/:id/update', requireRole('admin'), async function (req, res, next) {
  const { fullName, email, studentId, department, phone, password, status } = req.body;
  try {
    if (!cleanText(studentId)) {
      setFlash(req, 'error', 'Student ID is required.');
      return res.redirect('/admin-panel?tab=students');
    }
    const idCheck = await validateStudentId(studentId, req.params.id);
    if (!idCheck.ok) {
      setFlash(req, 'error', idCheck.error);
      return res.redirect('/admin-panel?tab=students');
    }
    if (password && cleanText(password)) {
      await db.run(
        'UPDATE students SET full_name = ?, email = ?, student_id = ?, department = ?, phone = ?, password = ?, status = ? WHERE id = ?',
        [cleanText(fullName), cleanText(email).toLowerCase(), idCheck.studentId, emptyToNull(department), emptyToNull(phone), db.hashPassword(password), status, req.params.id]
      );
    } else {
      await db.run(
        'UPDATE students SET full_name = ?, email = ?, student_id = ?, department = ?, phone = ?, status = ? WHERE id = ?',
        [cleanText(fullName), cleanText(email).toLowerCase(), idCheck.studentId, emptyToNull(department), emptyToNull(phone), status, req.params.id]
      );
    }
    setFlash(req, 'success', 'Student information updated.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not update this student. Email or Student ID may already be in use.');
  }
  res.redirect('/admin-panel?tab=students');
});

router.post('/admin/students/:id/approve', requireRole('admin'), async function (req, res, next) {
  await db.run("UPDATE students SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
  setFlash(req, 'success', 'Student approved.');
  res.redirect('/admin-panel?tab=students');
});

router.post('/admin/students/:id/reject', requireRole('admin'), async function (req, res, next) {
  await db.run("UPDATE students SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
  setFlash(req, 'success', 'Student registration rejected.');
  res.redirect('/admin-panel?tab=students');
});

router.post('/admin/students/:id/suspend', requireRole('admin'), async function (req, res, next) {
  await db.run("UPDATE students SET status = 'suspended' WHERE id = ?", [req.params.id]);
  setFlash(req, 'success', 'Student account suspended.');
  res.redirect('/admin-panel?tab=students');
});

router.post('/admin/students/:id/activate', requireRole('admin'), async function (req, res, next) {
  await db.run("UPDATE students SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
  setFlash(req, 'success', 'Student account re-activated.');
  res.redirect('/admin-panel?tab=students');
});

router.post('/admin/students/:id/delete', requireRole('admin'), async function (req, res, next) {
  await db.run('DELETE FROM students WHERE id = ?', [req.params.id]);
  setFlash(req, 'success', 'Student account deleted.');
  res.redirect('/admin-panel?tab=students');
});

/* ---- Driver management --------------------------------------------- */

router.post('/admin/drivers', requireRole('admin'), async function (req, res, next) {
  const { fullName, email, phone, password, busId } = req.body;
  try {
    if (!cleanText(fullName) || !cleanText(email) || !cleanText(password)) {
      setFlash(req, 'error', 'Full name, email and password are required.');
      return res.redirect('/admin-panel?tab=drivers');
    }
    let routeId = null;
    if (busId) {
      const bus = await db.get('SELECT route_id FROM buses WHERE id = ?', [busId]);
      routeId = bus ? bus.route_id : null;
    }
    await db.run(
      'INSERT INTO drivers (full_name, email, phone, password, bus_id, route_id, status, created_by_admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [cleanText(fullName), cleanText(email).toLowerCase(), emptyToNull(phone), db.hashPassword(password), busId || null, routeId, 'active', req.session.user.id]
    );
    setFlash(req, 'success', 'Driver account created.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not create the driver account. Email may already be in use.');
  }
  res.redirect('/admin-panel?tab=drivers');
});

router.get('/admin/drivers/:id/edit', requireRole('admin'), async function (req, res, next) {
  try {
    const driver = await db.get('SELECT * FROM drivers WHERE id = ?', [req.params.id]);
    if (!driver) {
      setFlash(req, 'error', 'Driver not found.');
      return res.redirect('/admin-panel?tab=drivers');
    }
    const buses = await db.all('SELECT * FROM buses ORDER BY bus_number ASC');
    const routes = await db.all('SELECT * FROM routes ORDER BY route_name ASC');
    res.render('admin-edit-driver', { title: 'Edit Driver', user: req.session.user, driver, buses, routes, flash: popFlash(req) });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/drivers/:id/update', requireRole('admin'), async function (req, res, next) {
  const { fullName, email, phone, password, busId, routeId, status } = req.body;
  try {
    if (password && cleanText(password)) {
      await db.run(
        'UPDATE drivers SET full_name = ?, email = ?, phone = ?, password = ?, bus_id = ?, route_id = ?, status = ? WHERE id = ?',
        [cleanText(fullName), cleanText(email).toLowerCase(), emptyToNull(phone), db.hashPassword(password), busId || null, routeId || null, status, req.params.id]
      );
    } else {
      await db.run(
        'UPDATE drivers SET full_name = ?, email = ?, phone = ?, bus_id = ?, route_id = ?, status = ? WHERE id = ?',
        [cleanText(fullName), cleanText(email).toLowerCase(), emptyToNull(phone), busId || null, routeId || null, status, req.params.id]
      );
    }
    setFlash(req, 'success', 'Driver information updated.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not update this driver. Email may already be in use.');
  }
  res.redirect('/admin-panel?tab=drivers');
});

router.post('/admin/drivers/:id/assign', requireRole('admin'), async function (req, res, next) {
  const { busId, routeId } = req.body;
  try {
    if (busId) {
      // Assigning a bus also carries the driver onto that bus's route,
      // unless a specific route override was explicitly submitted too.
      let finalRouteId = routeId || null;
      if (!routeId) {
        const bus = await db.get('SELECT route_id FROM buses WHERE id = ?', [busId]);
        finalRouteId = bus ? bus.route_id : null;
      }
      await db.run('UPDATE drivers SET bus_id = ?, route_id = ? WHERE id = ?', [busId, finalRouteId, req.params.id]);
    } else if (routeId) {
      // Route-only override (bus field left blank) - keep the current bus.
      await db.run('UPDATE drivers SET route_id = ? WHERE id = ?', [routeId, req.params.id]);
    } else {
      // Both left blank - fully unassign.
      await db.run('UPDATE drivers SET bus_id = NULL, route_id = NULL WHERE id = ?', [req.params.id]);
    }
    setFlash(req, 'success', 'Driver assignment updated.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not update this assignment.');
  }
  res.redirect('/admin-panel?tab=drivers');
});

router.post('/admin/drivers/:id/activate', requireRole('admin'), async function (req, res, next) {
  await db.run("UPDATE drivers SET status = 'active' WHERE id = ?", [req.params.id]);
  setFlash(req, 'success', 'Driver activated.');
  res.redirect('/admin-panel?tab=drivers');
});

router.post('/admin/drivers/:id/deactivate', requireRole('admin'), async function (req, res, next) {
  await db.run("UPDATE drivers SET status = 'inactive' WHERE id = ?", [req.params.id]);
  setFlash(req, 'success', 'Driver deactivated.');
  res.redirect('/admin-panel?tab=drivers');
});

router.post('/admin/drivers/:id/delete', requireRole('admin'), async function (req, res, next) {
  await db.run('DELETE FROM drivers WHERE id = ?', [req.params.id]);
  setFlash(req, 'success', 'Driver account deleted.');
  res.redirect('/admin-panel?tab=drivers');
});

/* ---- Bus management -------------------------------------------------- */

router.post('/admin/buses', requireRole('admin'), async function (req, res, next) {
  const { busNumber, busName, capacity, routeId, status } = req.body;
  try {
    if (!cleanText(busNumber)) {
      setFlash(req, 'error', 'Bus number is required.');
      return res.redirect('/admin-panel?tab=buses');
    }
    await db.run(
      'INSERT INTO buses (bus_number, bus_name, capacity, route_id, status) VALUES (?, ?, ?, ?, ?)',
      [cleanText(busNumber), emptyToNull(busName), capacity ? parseInt(capacity, 10) : null, routeId || null, status === 'inactive' ? 'inactive' : 'active']
    );
    setFlash(req, 'success', 'Bus added.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not add the bus. That bus number may already exist.');
  }
  res.redirect('/admin-panel?tab=buses');
});

router.get('/admin/buses/:id/edit', requireRole('admin'), async function (req, res, next) {
  try {
    const bus = await db.get('SELECT * FROM buses WHERE id = ?', [req.params.id]);
    if (!bus) {
      setFlash(req, 'error', 'Bus not found.');
      return res.redirect('/admin-panel?tab=buses');
    }
    const routes = await db.all('SELECT * FROM routes ORDER BY route_name ASC');
    res.render('admin-edit-bus', { title: 'Edit Bus', user: req.session.user, bus, routes, flash: popFlash(req) });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/buses/:id/update', requireRole('admin'), async function (req, res, next) {
  const { busNumber, busName, capacity, routeId, status } = req.body;
  try {
    await db.run(
      'UPDATE buses SET bus_number = ?, bus_name = ?, capacity = ?, route_id = ?, status = ? WHERE id = ?',
      [cleanText(busNumber), emptyToNull(busName), capacity ? parseInt(capacity, 10) : null, routeId || null, status === 'inactive' ? 'inactive' : 'active', req.params.id]
    );
    setFlash(req, 'success', 'Bus updated.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not update this bus. That bus number may already exist.');
  }
  res.redirect('/admin-panel?tab=buses');
});

router.post('/admin/buses/:id/delete', requireRole('admin'), async function (req, res, next) {
  await db.run('DELETE FROM buses WHERE id = ?', [req.params.id]);
  setFlash(req, 'success', 'Bus removed.');
  res.redirect('/admin-panel?tab=buses');
});

/* ---- Route management ------------------------------------------------ */

router.post('/admin/routes', requireRole('admin'), async function (req, res, next) {
  const { routeName, description, status } = req.body;
  if (!cleanText(routeName)) {
    setFlash(req, 'error', 'Route name is required.');
    return res.redirect('/admin-panel?tab=routes');
  }
  await db.run('INSERT INTO routes (route_name, description, status) VALUES (?, ?, ?)', [
    cleanText(routeName),
    emptyToNull(description),
    status === 'inactive' ? 'inactive' : 'active',
  ]);
  setFlash(req, 'success', 'Route created.');
  res.redirect('/admin-panel?tab=routes');
});

router.get('/admin/routes/:id/edit', requireRole('admin'), async function (req, res, next) {
  try {
    const route = await db.get('SELECT * FROM routes WHERE id = ?', [req.params.id]);
    if (!route) {
      setFlash(req, 'error', 'Route not found.');
      return res.redirect('/admin-panel?tab=routes');
    }
    const stops = await db.all('SELECT * FROM stops WHERE route_id = ? ORDER BY stop_order ASC', [req.params.id]);
    res.render('admin-edit-route', { title: 'Edit Route', user: req.session.user, route, stops, flash: popFlash(req) });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/routes/:id/update', requireRole('admin'), async function (req, res, next) {
  const { routeName, description, status } = req.body;
  await db.run('UPDATE routes SET route_name = ?, description = ?, status = ? WHERE id = ?', [
    cleanText(routeName),
    emptyToNull(description),
    status === 'inactive' ? 'inactive' : 'active',
    req.params.id,
  ]);
  setFlash(req, 'success', 'Route updated.');
  res.redirect('/admin-panel?tab=routes');
});

router.post('/admin/routes/:id/delete', requireRole('admin'), async function (req, res, next) {
  await db.run('DELETE FROM routes WHERE id = ?', [req.params.id]);
  setFlash(req, 'success', 'Route deleted (its stops and schedules were removed as well).');
  res.redirect('/admin-panel?tab=routes');
});

/* ---- Stop management --------------------------------------------------- */

router.post('/admin/stops', requireRole('admin'), async function (req, res, next) {
  const { routeId, stopName, stopOrder, status } = req.body;
  if (!routeId || !cleanText(stopName)) {
    setFlash(req, 'error', 'Route and stop name are required.');
    return res.redirect('/admin-panel?tab=stops');
  }
  try {
    let order = parseInt(stopOrder, 10);
    if (!order) {
      const maxRow = await db.get('SELECT MAX(stop_order) AS maxOrder FROM stops WHERE route_id = ?', [routeId]);
      order = (maxRow && maxRow.maxOrder ? maxRow.maxOrder : 0) + 1;
    }
    await db.run('INSERT INTO stops (route_id, stop_name, stop_order, status) VALUES (?, ?, ?, ?)', [
      routeId,
      cleanText(stopName),
      order,
      status === 'inactive' ? 'inactive' : 'active',
    ]);
    setFlash(req, 'success', 'Stop added.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not add this stop. Please re-check the selected route.');
  }
  res.redirect('/admin-panel?tab=stops');
});

router.get('/admin/stops/:id/edit', requireRole('admin'), async function (req, res, next) {
  try {
    const stop = await db.get('SELECT * FROM stops WHERE id = ?', [req.params.id]);
    if (!stop) {
      setFlash(req, 'error', 'Stop not found.');
      return res.redirect('/admin-panel?tab=stops');
    }
    const routes = await db.all('SELECT * FROM routes ORDER BY route_name ASC');
    res.render('admin-edit-stop', { title: 'Edit Stop', user: req.session.user, stop, routes, flash: popFlash(req) });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/stops/:id/update', requireRole('admin'), async function (req, res, next) {
  const { routeId, stopName, stopOrder, status } = req.body;
  try {
    await db.run('UPDATE stops SET route_id = ?, stop_name = ?, stop_order = ?, status = ? WHERE id = ?', [
      routeId,
      cleanText(stopName),
      parseInt(stopOrder, 10) || 1,
      status === 'inactive' ? 'inactive' : 'active',
      req.params.id,
    ]);
    setFlash(req, 'success', 'Stop updated.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not update this stop. Please re-check the selected route.');
  }
  res.redirect('/admin-panel?tab=stops');
});

router.post('/admin/stops/:id/delete', requireRole('admin'), async function (req, res, next) {
  await db.run('DELETE FROM stops WHERE id = ?', [req.params.id]);
  setFlash(req, 'success', 'Stop removed.');
  res.redirect('/admin-panel?tab=stops');
});

/* ---- Schedule management (core dynamic schedule feature) -------------- */

router.post('/admin/schedules', requireRole('admin'), async function (req, res, next) {
  const { busId, routeId, departureTime, arrivalTime, operatingDays, period, effectiveFrom, effectiveTo, status, notes } = req.body;
  if (!busId || !routeId) {
    setFlash(req, 'error', 'Bus and Route are required.');
    return res.redirect('/admin-panel?tab=schedules');
  }
  if (!emptyToNull(departureTime) && !emptyToNull(arrivalTime)) {
    setFlash(req, 'error', 'Provide at least a departure time or an arrival time.');
    return res.redirect('/admin-panel?tab=schedules');
  }
  try {
  await db.run(
    `INSERT INTO schedules
      (bus_id, route_id, departure_time, arrival_time, operating_days, period, effective_from, effective_to, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      busId,
      routeId,
      emptyToNull(departureTime),
      emptyToNull(arrivalTime),
      cleanText(operatingDays) || 'Sun-Thu',
      safePeriod(period),
      emptyToNull(effectiveFrom),
      emptyToNull(effectiveTo),
      status === 'inactive' ? 'inactive' : 'active',
      emptyToNull(notes),
    ]
  );
  setFlash(req, 'success', 'Schedule created. Students will see this the next time they load the timetable.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not create the schedule. Please re-check the selected bus and route.');
  }
  res.redirect('/admin-panel?tab=schedules');
});

router.get('/admin/schedules/:id/edit', requireRole('admin'), async function (req, res, next) {
  try {
    const schedule = await db.get('SELECT * FROM schedules WHERE id = ?', [req.params.id]);
    if (!schedule) {
      setFlash(req, 'error', 'Schedule not found.');
      return res.redirect('/admin-panel?tab=schedules');
    }
    const buses = await db.all('SELECT * FROM buses ORDER BY bus_number ASC');
    const routes = await db.all('SELECT * FROM routes ORDER BY route_name ASC');
    res.render('admin-edit-schedule', {
      title: 'Edit Schedule',
      user: req.session.user,
      schedule,
      buses,
      routes,
      periods: PERIODS,
      flash: popFlash(req),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/schedules/:id/update', requireRole('admin'), async function (req, res, next) {
  const { busId, routeId, departureTime, arrivalTime, operatingDays, period, effectiveFrom, effectiveTo, status, notes } = req.body;
  try {
    await db.run(
      `UPDATE schedules SET
         bus_id = ?, route_id = ?, departure_time = ?, arrival_time = ?, operating_days = ?,
         period = ?, effective_from = ?, effective_to = ?, status = ?, notes = ?
       WHERE id = ?`,
      [
        busId,
        routeId,
        emptyToNull(departureTime),
        emptyToNull(arrivalTime),
        cleanText(operatingDays) || 'Sun-Thu',
        safePeriod(period),
        emptyToNull(effectiveFrom),
        emptyToNull(effectiveTo),
        status === 'inactive' ? 'inactive' : 'active',
        emptyToNull(notes),
        req.params.id,
      ]
    );
    setFlash(req, 'success', 'Schedule updated. The new timing is live immediately - no code changes needed.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not update this schedule. Please re-check the selected bus and route.');
  }
  res.redirect('/admin-panel?tab=schedules');
});

router.post('/admin/schedules/:id/delete', requireRole('admin'), async function (req, res, next) {
  await db.run('DELETE FROM schedules WHERE id = ?', [req.params.id]);
  setFlash(req, 'success', 'Schedule removed.');
  res.redirect('/admin-panel?tab=schedules');
});

/* ---- Notice management (Admin can create + view + delete) -------------- */

router.post('/admin/notices', requireRole('admin'), async function (req, res, next) {
  const { busId, routeId, noticeDate, noticeType, message } = req.body;
  try {
    if (!cleanText(message)) {
      setFlash(req, 'error', 'Please write a short notice message.');
      return res.redirect('/admin-panel?tab=notices');
    }
    const finalNoticeType = noticeType === 'not_running' ? 'not_running' : 'general';
    const finalDate = isValidDateStr(noticeDate) ? noticeDate : todayDateStr(new Date());

    const finalBusId = busId ? parseInt(busId, 10) : null;
    let finalRouteId = routeId ? parseInt(routeId, 10) : null;
    if (finalBusId && !finalRouteId) {
      // A bus implies its own route, even if the Admin didn't also pick
      // one explicitly - keeps the notice's route_id meaningful for
      // display without making the Admin fill in both fields by hand.
      const bus = await db.get('SELECT route_id FROM buses WHERE id = ?', [finalBusId]);
      finalRouteId = bus ? bus.route_id : null;
    }

    await db.run(
      `INSERT INTO notices (admin_id, notice_type, bus_id, route_id, notice_date, message)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.session.user.id, finalNoticeType, finalBusId, finalRouteId, finalDate, cleanText(message).slice(0, 500)]
    );
    setFlash(req, 'success', 'Notice posted. Students checking that route/date will see it immediately.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not post this notice. Please try again.');
  }
  res.redirect('/admin-panel?tab=notices');
});

router.post('/admin/notices/:id/delete', requireRole('admin'), async function (req, res, next) {
  await db.run('DELETE FROM notices WHERE id = ?', [req.params.id]);
  setFlash(req, 'success', 'Notice removed.');
  res.redirect('/admin-panel?tab=notices');
});

/* ================================================================== */
/* Driver Dashboard                                                     */
/* ================================================================== */

router.get('/driver-dashboard', requireRole('driver'), async function (req, res, next) {
  try {
    const driverProfile = await db.get(
      `SELECT d.*, b.bus_number, b.bus_name, b.capacity, r.id AS assigned_route_id, r.route_name
       FROM drivers d
       LEFT JOIN buses b ON b.id = d.bus_id
       LEFT JOIN routes r ON r.id = d.route_id
       WHERE d.id = ?`,
      [req.session.user.id]
    );

    if (!driverProfile || driverProfile.status === 'inactive') {
      req.session.destroy(() => res.redirect('/login-driver?status=inactive'));
      return;
    }

    let schedules = [];
    if (driverProfile.bus_id) {
      schedules = await db.all(
        `SELECT sc.*, r.route_name
         FROM schedules sc
         JOIN routes r ON r.id = sc.route_id
         WHERE sc.bus_id = ? AND sc.status = 'active'
         ORDER BY sc.period ASC, COALESCE(sc.arrival_time, sc.departure_time) ASC`,
        [driverProfile.bus_id]
      );
    }

    // Real stops belonging to the driver's own assigned route, for the
    // Delay/Breakdown "Location/Stop" dropdowns - never hard-coded.
    let routeStops = [];
    if (driverProfile.assigned_route_id) {
      routeStops = await db.all(
        'SELECT * FROM stops WHERE route_id = ? AND status = ? ORDER BY stop_order ASC',
        [driverProfile.assigned_route_id, 'active']
      );
    }

    const myNotices = await db.all('SELECT * FROM notices WHERE driver_id = ? ORDER BY created_at DESC', [req.session.user.id]);
    const allNotices = await getRecentNotices(20);

    const activeTripRow = await db.get(
      "SELECT id FROM trips WHERE driver_id = ? AND status = 'in_progress' ORDER BY started_at DESC LIMIT 1",
      [req.session.user.id]
    );
    const currentTrip = activeTripRow ? await getTripWithCount(activeTripRow.id) : null;
    const recentTrips = await db.all(
      `SELECT t.*, r.route_name
       FROM trips t
       LEFT JOIN routes r ON r.id = t.route_id
       WHERE t.driver_id = ?
       ORDER BY t.created_at DESC
       LIMIT 10`,
      [req.session.user.id]
    );

    res.render('driver-dashboard', {
      title: 'Driver Dashboard',
      user: req.session.user,
      driverProfile,
      schedules,
      routeStops,
      delayReasons: DELAY_REASONS,
      breakdownReasons: BREAKDOWN_REASONS,
      delayDurations: DELAY_DURATIONS,
      myNotices,
      allNotices,
      currentTrip,
      recentTrips,
      flash: popFlash(req),
    });
  } catch (err) {
    next(err);
  }
});

/* Structured Delay Report - Reason + Location/Stop + Delay Duration,
   picked from real dropdowns (never free text), so the message stored is
   always consistent and the Student Dashboard can compute an updated
   estimated time from it automatically. Independent of the Trip Status
   Controls below - a driver can report a delay whether or not they have
   started a trip. A driver still cannot touch schedules, routes, stops
   or buses themselves. */
router.post('/driver-dashboard/delay-report', requireRole('driver'), async function (req, res, next) {
  const { reason, reasonOther, stopId, delayMinutes } = req.body;
  try {
    const driverProfile = await db.get('SELECT bus_id, route_id FROM drivers WHERE id = ?', [req.session.user.id]);
    if (!driverProfile || !driverProfile.bus_id) {
      setFlash(req, 'error', 'You need an assigned bus before you can report a delay. Please contact the Admin.');
      return res.redirect('/driver-dashboard');
    }

    const finalReason = DELAY_REASONS.includes(reason) ? reason : DELAY_REASONS[0];
    const parsedDelay = parseInt(delayMinutes, 10);
    const finalDelay = DELAY_DURATIONS.includes(parsedDelay) ? parsedDelay : DELAY_DURATIONS[0];

    let stopName = null;
    let finalStopId = null;
    if (stopId) {
      const stop = await db.get('SELECT id, stop_name FROM stops WHERE id = ? AND route_id = ?', [stopId, driverProfile.route_id]);
      if (stop) {
        finalStopId = stop.id;
        stopName = stop.stop_name;
      }
    }

    const message = buildDelayMessage(finalReason, reasonOther, stopName, finalDelay);
    await db.run(
      `INSERT INTO notices (driver_id, notice_type, bus_id, route_id, notice_date, reason, reason_other, stop_id, delay_minutes, message)
       VALUES (?, 'delayed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.session.user.id,
        driverProfile.bus_id,
        driverProfile.route_id,
        todayDateStr(new Date()),
        finalReason,
        finalReason === 'Other' ? emptyToNull(reasonOther) : null,
        finalStopId,
        finalDelay,
        message,
      ]
    );
    setFlash(req, 'success', 'Delay reported. Students checking your route today will see the updated status.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not report this delay. Please try again.');
  }
  res.redirect('/driver-dashboard');
});

/* ---- Trip Status Controls (Start / End / Report Breakdown) ----------- */
/* Starting a trip is what opens boarding to students and begins the      */
/* automatic passenger count; ending it or reporting a breakdown closes   */
/* it again. A driver can only ever have one trip in progress at a time,  */
/* and can only start/end/report a breakdown for their own trips.        */

router.post('/driver-dashboard/trip/start', requireRole('driver'), async function (req, res, next) {
  try {
    const driverProfile = await db.get('SELECT bus_id, route_id FROM drivers WHERE id = ?', [req.session.user.id]);
    if (!driverProfile || !driverProfile.bus_id) {
      setFlash(req, 'error', 'You need an assigned bus before you can start a trip. Please contact the Admin.');
      return res.redirect('/driver-dashboard');
    }
    const existingTrip = await db.get(
      "SELECT id FROM trips WHERE driver_id = ? AND status = 'in_progress'",
      [req.session.user.id]
    );
    if (existingTrip) {
      setFlash(req, 'error', 'You already have a trip in progress. End it (or report a breakdown) before starting a new one.');
      return res.redirect('/driver-dashboard');
    }
    const today = new Date().toISOString().slice(0, 10);
    await db.run(
      `INSERT INTO trips (bus_id, driver_id, route_id, status, trip_date, started_at)
       VALUES (?, ?, ?, 'in_progress', ?, CURRENT_TIMESTAMP)`,
      [driverProfile.bus_id, req.session.user.id, driverProfile.route_id, today]
    );
    setFlash(req, 'success', 'Trip started. Students can now board and be counted for this bus.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not start the trip. Please try again.');
  }
  res.redirect('/driver-dashboard');
});

router.post('/driver-dashboard/trip/:id/end', requireRole('driver'), async function (req, res, next) {
  try {
    const trip = await db.get('SELECT id, status FROM trips WHERE id = ? AND driver_id = ?', [req.params.id, req.session.user.id]);
    if (!trip || trip.status !== 'in_progress') {
      setFlash(req, 'error', 'This trip cannot be ended.');
      return res.redirect('/driver-dashboard');
    }
    await db.run("UPDATE trips SET status = 'completed', ended_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
    setFlash(req, 'success', 'Trip ended.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not end the trip. Please try again.');
  }
  res.redirect('/driver-dashboard');
});

/* Breakdown stays separate from a Delay - a mechanical fault, reported
   with a clear Reason (+ optional Location/Stop), never free text, so it
   can never accidentally show delay-shaped wording. Still tied to the
   driver's current trip (as before - it both closes that trip out AND
   posts the matching notice students see on the Student Dashboard). */
router.post('/driver-dashboard/trip/:id/breakdown', requireRole('driver'), async function (req, res, next) {
  const { reason, reasonOther, stopId } = req.body;
  try {
    const trip = await db.get('SELECT id, status, bus_id, route_id FROM trips WHERE id = ? AND driver_id = ?', [req.params.id, req.session.user.id]);
    if (!trip || trip.status !== 'in_progress') {
      setFlash(req, 'error', 'This trip cannot be reported as a breakdown.');
      return res.redirect('/driver-dashboard');
    }

    const finalReason = BREAKDOWN_REASONS.includes(reason) ? reason : 'Mechanical Problem';
    let stopName = null;
    let finalStopId = null;
    if (stopId) {
      const stop = await db.get('SELECT id, stop_name FROM stops WHERE id = ? AND route_id = ?', [stopId, trip.route_id]);
      if (stop) {
        finalStopId = stop.id;
        stopName = stop.stop_name;
      }
    }
    const breakdownMessage = buildBreakdownMessage(finalReason, reasonOther, stopName);

    await db.run(
      "UPDATE trips SET status = 'breakdown', breakdown_message = ?, breakdown_reported_at = CURRENT_TIMESTAMP WHERE id = ?",
      [breakdownMessage, req.params.id]
    );
    await db.run(
      `INSERT INTO notices (driver_id, notice_type, bus_id, route_id, notice_date, reason, reason_other, stop_id, message)
       VALUES (?, 'breakdown', ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.session.user.id,
        trip.bus_id,
        trip.route_id,
        todayDateStr(new Date()),
        finalReason,
        finalReason === 'Other' ? emptyToNull(reasonOther) : null,
        finalStopId,
        breakdownMessage,
      ]
    );
    setFlash(req, 'success', 'Breakdown reported. The Admin has been notified and students checking your route today will see it.');
  } catch (err) {
    console.error(err);
    setFlash(req, 'error', 'Could not report the breakdown. Please try again.');
  }
  res.redirect('/driver-dashboard');
});

/* ================================================================== */
/* Student Dashboard - Route + Date Bus Status                         */
/* ================================================================== */

router.get('/student-dashboard', requireRole('student'), async function (req, res, next) {
  try {
    const student = await db.get('SELECT * FROM students WHERE id = ?', [req.session.user.id]);
    if (!student) {
      req.session.destroy(() => res.redirect('/login-student'));
      return;
    }
    if (student.status !== 'approved') {
      // Status may have changed since login (e.g. suspended mid-session).
      const status = student.status;
      req.session.destroy(() => res.redirect(`/login-student?status=${status}`));
      return;
    }

    const routes = await getActiveRoutesWithStops();
    const notices = await getRecentNotices(10);

    const todayStr = todayDateStr(new Date());
    const selectedRouteId = req.query.routeId ? parseInt(req.query.routeId, 10) : null;
    const selectedDate = isValidDateStr(req.query.date) ? req.query.date : todayStr;

    let selectedRoute = null;
    let statusResults = null;
    if (selectedRouteId) {
      selectedRoute = routes.find((r) => r.id === selectedRouteId) || null;
      if (selectedRoute) {
        statusResults = await getRouteBusStatusForDate(selectedRouteId, selectedDate, todayStr);
      }
    }

    res.render('student-dashboard', {
      title: 'Student Dashboard',
      user: req.session.user,
      student,
      routes,
      notices,
      todayStr,
      selectedRouteId,
      selectedDate,
      selectedRoute,
      statusResults,
      flash: popFlash(req),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
