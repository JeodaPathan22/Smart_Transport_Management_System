/**
 * Database access layer for the Smart Transport Management System.
 *
 * Backed by MySQL (designed to run against a local XAMPP MySQL/MariaDB
 * server - see config/database.js and .env for connection settings).
 *
 * This module exposes the exact same Promise-based run/get/all API the
 * rest of the app already used with the previous SQLite backend, so no
 * other file needed to change its query calls for the migration:
 *   - run(sql, params) -> { lastID, changes }
 *   - get(sql, params) -> a single row object, or undefined
 *   - all(sql, params) -> an array of row objects
 */

const mysql = require('mysql2/promise');
const crypto = require('crypto');
const dbConfig = require('./config/database');

// Created synchronously (mysql2's createPool() does not itself open a
// network connection - connections are established lazily per-query),
// so it behaves like the previous `new sqlite3.Database(...)` call: safe
// to use immediately after this module is required. The pool targets the
// configured database by name; initDatabase() (awaited once at startup,
// see bin/www) makes sure that database and its tables exist before the
// HTTP server starts accepting requests.
const pool = mysql.createPool({
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
});

async function run(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return { lastID: result.insertId, changes: result.affectedRows };
}

async function get(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows[0];
}

async function all(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows || [];
}

// Runs once, before the pool's default database is guaranteed to exist -
// creates the database itself (CREATE DATABASE IF NOT EXISTS) using its
// own short-lived connection so a completely fresh XAMPP install (no
// database created yet) still works with zero manual setup, exactly like
// the old SQLite file used to be created automatically on first run.
async function ensureDatabaseExists() {
  const bootstrapConnection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
  });
  try {
    await bootstrapConnection.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await bootstrapConnection.end();
  }
}

/* ------------------------------------------------------------------ */
/* Password hashing (salted PBKDF2, built-in crypto only) - unchanged  */
/* from the SQLite version, so existing password hashes and login      */
/* behaviour are completely unaffected by the database migration.      */
/* ------------------------------------------------------------------ */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) {
    return false;
  }
  const [salt, hash] = storedHash.split(':');
  try {
    const check = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha256').toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(check, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (err) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Idempotent schema migration helpers                                 */
/*                                                                      */
/* Safe to call on every startup, whether this is the very first run   */
/* (nothing to do - CREATE TABLE already created the final shape) or a  */
/* database created by an earlier version of this project (the real    */
/* work happens here, one ALTER TABLE at a time). Existing rows/data    */
/* are never touched - only the table structure.                       */
/* ------------------------------------------------------------------ */

async function columnExists(table, column) {
  const row = await get(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbConfig.database, table, column]
  );
  return !!(row && row.cnt > 0);
}

async function ensureColumn(table, column, columnDefinitionSql) {
  if (!(await columnExists(table, column))) {
    await run(`ALTER TABLE \`${table}\` ADD COLUMN ${columnDefinitionSql}`);
  }
}

// Checked by (table, column, referenced table) rather than by a specific
// constraint name, because a foreign key declared inline inside CREATE
// TABLE (as notices' are, above) gets an auto-generated name from
// MySQL/MariaDB itself - not the name this file would otherwise guess -
// so matching on the actual relationship is what makes this safe to call
// unconditionally right after createSchema() on a brand-new database.
async function foreignKeyExistsOnColumn(table, column, refTable) {
  const row = await get(
    `SELECT COUNT(*) AS cnt FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
       AND REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?`,
    [dbConfig.database, table, column, dbConfig.database, refTable]
  );
  return !!(row && row.cnt > 0);
}

async function ensureForeignKey(table, column, refTable, constraintDefinitionSql) {
  if (!(await foreignKeyExistsOnColumn(table, column, refTable))) {
    await run(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`fk_${table}_${column}\` ${constraintDefinitionSql}`);
  }
}

// Brings a `notices` table created by an earlier version of this project
// (driver_id NOT NULL, only id/driver_id/message/created_at) up to the
// current shape, which also supports Admin-created notices and
// structured Driver delay/breakdown reports.
async function migrateNoticesTable() {
  const driverIdColumn = await get(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'notices' AND COLUMN_NAME = 'driver_id'`,
    [dbConfig.database]
  );
  if (driverIdColumn && driverIdColumn.IS_NULLABLE === 'NO') {
    // Admin-created notices have no driver, so this column can no longer
    // be required. Loosening a NOT NULL -> NULL constraint never puts
    // existing rows at risk - every one of them already has a real value.
    await run('ALTER TABLE notices MODIFY COLUMN driver_id INT NULL');
  }

  await ensureColumn('notices', 'admin_id', 'admin_id INT NULL AFTER driver_id');
  await ensureColumn('notices', 'notice_type', "notice_type ENUM('delayed','breakdown','not_running','general') NOT NULL DEFAULT 'general' AFTER admin_id");
  await ensureColumn('notices', 'bus_id', 'bus_id INT NULL AFTER notice_type');
  await ensureColumn('notices', 'route_id', 'route_id INT NULL AFTER bus_id');
  await ensureColumn('notices', 'notice_date', 'notice_date DATE NULL AFTER route_id');
  await ensureColumn('notices', 'reason', 'reason VARCHAR(100) NULL AFTER notice_date');
  await ensureColumn('notices', 'reason_other', 'reason_other VARCHAR(255) NULL AFTER reason');
  await ensureColumn('notices', 'stop_id', 'stop_id INT NULL AFTER reason_other');
  await ensureColumn('notices', 'delay_minutes', 'delay_minutes INT NULL AFTER stop_id');

  await ensureForeignKey('notices', 'admin_id', 'admins', 'FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL');
  await ensureForeignKey('notices', 'bus_id', 'buses', 'FOREIGN KEY (bus_id) REFERENCES buses(id) ON DELETE CASCADE');
  await ensureForeignKey('notices', 'route_id', 'routes', 'FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE');
  await ensureForeignKey('notices', 'stop_id', 'stops', 'FOREIGN KEY (stop_id) REFERENCES stops(id) ON DELETE SET NULL');
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

async function createSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(191) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      full_name VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS routes (
      id INT PRIMARY KEY AUTO_INCREMENT,
      route_name VARCHAR(255) NOT NULL,
      description TEXT,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS stops (
      id INT PRIMARY KEY AUTO_INCREMENT,
      route_id INT NOT NULL,
      stop_name VARCHAR(255) NOT NULL,
      stop_order INT NOT NULL DEFAULT 1,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS buses (
      id INT PRIMARY KEY AUTO_INCREMENT,
      bus_number VARCHAR(100) UNIQUE NOT NULL,
      bus_name VARCHAR(255),
      capacity INT,
      route_id INT,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS drivers (
      id INT PRIMARY KEY AUTO_INCREMENT,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(191) UNIQUE NOT NULL,
      phone VARCHAR(50),
      password VARCHAR(255) NOT NULL,
      bus_id INT,
      route_id INT,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      created_by_admin INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(bus_id) REFERENCES buses(id) ON DELETE SET NULL,
      FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by_admin) REFERENCES admins(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS students (
      id INT PRIMARY KEY AUTO_INCREMENT,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(191) UNIQUE NOT NULL,
      student_id VARCHAR(100) UNIQUE NOT NULL,
      department VARCHAR(255),
      phone VARCHAR(50),
      password VARCHAR(255) NOT NULL,
      status ENUM('pending','approved','rejected','suspended') NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS schedules (
      id INT PRIMARY KEY AUTO_INCREMENT,
      bus_id INT NOT NULL,
      route_id INT NOT NULL,
      departure_time VARCHAR(10),
      arrival_time VARCHAR(10),
      operating_days VARCHAR(100) NOT NULL DEFAULT 'Sun-Thu',
      period ENUM('regular','examination','summer','winter','special') NOT NULL DEFAULT 'regular',
      period_label VARCHAR(255),
      effective_from VARCHAR(20),
      effective_to VARCHAR(20),
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(bus_id) REFERENCES buses(id) ON DELETE CASCADE,
      FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notices (
      id INT PRIMARY KEY AUTO_INCREMENT,
      driver_id INT NULL,
      admin_id INT NULL,
      notice_type ENUM('delayed','breakdown','not_running','general') NOT NULL DEFAULT 'general',
      bus_id INT NULL,
      route_id INT NULL,
      notice_date DATE NULL,
      reason VARCHAR(100) NULL,
      reason_other VARCHAR(255) NULL,
      stop_id INT NULL,
      delay_minutes INT NULL,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
      FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE SET NULL,
      FOREIGN KEY(bus_id) REFERENCES buses(id) ON DELETE CASCADE,
      FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE CASCADE,
      FOREIGN KEY(stop_id) REFERENCES stops(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  /* ------------------------------------------------------------------
   * `notices` used to only support a driver posting free text
   * (driver_id + message). It now also supports Admin-created notices
   * and structured Driver delay/breakdown reports - see
   * migrateNoticesTable() below, which brings a database created by an
   * earlier version of this project up to the shape created above,
   * column by column, without ever touching an existing row. On a
   * brand-new database (just created above) every check inside it is
   * already satisfied, so it does nothing.
   * ------------------------------------------------------------------ */
  await migrateNoticesTable();

  await run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INT PRIMARY KEY AUTO_INCREMENT,
      student_id INT NOT NULL,
      route_id INT NOT NULL,
      travel_date VARCHAR(20) NOT NULL,
      travel_time VARCHAR(10) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  /* ------------------------------------------------------------------
   * `trips` / `trip_boardings` - trip log + (unused) passenger boarding.
   *
   * A "trip" is one run of a bus, started/ended/breakdown-reported by
   * its driver (Trip Status Controls on the Driver Dashboard) - this
   * part is still active and is what powers Admin's "Live Trips &
   * Breakdowns" tab. `trip_boardings` (one row per student who "boards"
   * a trip, with automatic passenger counting) is kept only so this
   * table isn't dropped from a real, already-running database; the
   * student-facing boarding workflow that used to write to it has been
   * removed, so in the current app nothing writes new rows here any
   * more.
   * ------------------------------------------------------------------ */

  await run(`
    CREATE TABLE IF NOT EXISTS trips (
      id INT PRIMARY KEY AUTO_INCREMENT,
      bus_id INT NOT NULL,
      driver_id INT NOT NULL,
      route_id INT,
      status ENUM('in_progress','completed','breakdown') NOT NULL DEFAULT 'in_progress',
      trip_date DATE NOT NULL,
      started_at DATETIME NULL,
      ended_at DATETIME NULL,
      breakdown_message TEXT,
      breakdown_reported_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(bus_id) REFERENCES buses(id) ON DELETE CASCADE,
      FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
      FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS trip_boardings (
      id INT PRIMARY KEY AUTO_INCREMENT,
      trip_id INT NOT NULL,
      student_id INT NOT NULL,
      boarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE,
      FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
      UNIQUE KEY uniq_trip_student (trip_id, student_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/* ------------------------------------------------------------------ */
/* Seed data - real routes/stops/buses/schedules transcribed from the  */
/* Metropolitan University, Sylhet regular class bus schedule sheet    */
/* (effective 27/7/2026). Times are stored in 24-hour HH:MM format.    */
/* Unchanged from the SQLite version - the same routes, stops, buses,  */
/* drivers, schedules, notices and demo accounts are seeded here.      */
/* ------------------------------------------------------------------ */

const SEED_ROUTES = [
  {
    key: 'medina-tilagarh',
    route_name: 'Medina Market - Rikabibazar - Shahi Eidgah - Tilagarh (Teacher Transport)',
    description: 'Daily staff/teacher transport corridor linking Pathantula, Subidbazar, Rikabibazar, Chowhatta, Ambarkhana and Medina Market to the campus via Shahi Eidgah and Tilagarh.',
    stops: ['Pathantula', 'Subidbazar', 'Rikabibazar', 'Chowhatta', 'Ambarkhana', 'Medina Market', 'Kumarpara', 'Shahi Eidgah', 'Tilagarh', 'Metropolitan University Campus'],
  },
  {
    key: 'rikabibazar-tilagarh',
    route_name: 'Rikabibazar - Shahi Eidgah - Tilagarh',
    description: 'Connects Rikabibazar, Kumarpara and Shahi Eidgah to the campus via Tilagarh. Serves both staff and student trips.',
    stops: ['Rikabibazar', 'Kumarpara', 'Shahi Eidgah', 'Tilagarh', 'Metropolitan University Campus'],
  },
  {
    key: 'pathantula-tilagarh',
    route_name: 'Pathantula - Subidbazar - Ambarkhana - Tilagarh',
    description: 'Serves Pathantula, Subidbazar and Ambarkhana on the way to campus via Shahi Eidgah and Tilagarh.',
    stops: ['Pathantula', 'Subidbazar', 'Ambarkhana', 'Shahi Eidgah', 'Tilagarh', 'Metropolitan University Campus'],
  },
  {
    key: 'temukhi-tilagarh',
    route_name: 'Temukhi - Medina Market - Subidbazar - Tilagarh',
    description: 'Long city route from Temukhi through Medina Market and Subidbazar to campus via Ambarkhana, Shahi Eidgah and Tilagarh.',
    stops: ['Temukhi', 'Medina Market', 'Subidbazar', 'Ambarkhana', 'Shahi Eidgah', 'Tilagarh', 'Metropolitan University Campus'],
  },
  {
    key: 'rikabibazar-naiorpul',
    route_name: 'Rikabibazar - Chowhatta - Naiorpul - Tilagarh',
    description: 'Connects Rikabibazar and Chowhatta to campus via Kumarpara, Naiorpul and Tilagarh.',
    stops: ['Rikabibazar', 'Chowhatta', 'Kumarpara', 'Naiorpul', 'Tilagarh', 'Metropolitan University Campus'],
  },
  {
    key: 'kajirbazar-naiorpul',
    route_name: 'Kajirbazar - Rikabibazar - Naiorpul - Tilagarh (University Bus)',
    description: 'University-operated route from Kajirbazar through Rikabibazar, Chowhatta and Naiorpul to campus.',
    stops: ['Kajirbazar', 'Rikabibazar', 'Chowhatta', 'Kumarpara', 'Naiorpul', 'Tilagarh', 'Metropolitan University Campus'],
  },
  {
    key: 'humayun-shibganj',
    route_name: 'Humayun Chottor - Shibganj - Tilagarh',
    description: 'Serves Humayun Chottor and Shibganj on the way to campus via Naiorpul and Tilagarh.',
    stops: ['Humayun Chottor', 'Naiorpul', 'Shibganj', 'Tilagarh', 'Metropolitan University Campus'],
  },
  {
    key: 'sreerampur-bypass',
    route_name: 'Sreerampur Bypass - Surma Gate Bypass (Trial Route)',
    description: 'Trial/pilot bypass route linking Sreerampur Bypass and Surma Gate Bypass directly to campus.',
    stops: ['Sreerampur Bypass', 'Surma Gate Bypass', 'Metropolitan University Campus'],
  },
  {
    key: 'campus-rikabibazar-shuttle',
    route_name: 'Campus - Rikabibazar Shuttle',
    description: 'Midday shuttle service between campus and Rikabibazar via Tilagarh, Shahi Eidgah and Kumarpara.',
    stops: ['Metropolitan University Campus', 'Tilagarh', 'Shahi Eidgah', 'Kumarpara', 'Rikabibazar'],
  },
  {
    key: 'campus-shahieidgah-shuttle',
    route_name: 'Campus - Shahi Eidgah Shuttle',
    description: 'Midday shuttle service running directly between campus and Shahi Eidgah.',
    stops: ['Metropolitan University Campus', 'Shahi Eidgah'],
  },
  {
    key: 'campus-tilagarh-shuttle',
    route_name: 'Campus - Tilagarh Shuttle',
    description: 'Frequent shuttle service running throughout the day between campus and Tilagarh.',
    stops: ['Metropolitan University Campus', 'Tilagarh'],
  },
  {
    key: 'campus-darbasta',
    route_name: 'Campus - Darbasta',
    description: 'Daily service connecting campus with Darbasta.',
    stops: ['Metropolitan University Campus', 'Darbasta'],
  },
];

const SEED_BUSES = [
  { number: '11-0018', name: 'Bus 11-0018', capacity: 40 },
  { number: '11-0900', name: 'Bus 11-0900', capacity: 40 },
  { number: '11-0944', name: 'Bus 11-0944 (Trial)', capacity: 40 },
  { number: '11-0967', name: 'Bus 11-0967', capacity: 40 },
  { number: '11-0010', name: 'Bus 11-0010', capacity: 40 },
  { number: 'New-1', name: 'New-1', capacity: 32 },
  { number: 'New-2', name: 'New-2', capacity: 32 },
  { number: 'Univ-1', name: 'University Bus 1', capacity: 40 },
];

const SEED_DRIVERS = [
  { full_name: 'Sojib', email: 'sojib.driver@mu.edu.bd', phone: '01710000001', bus: '11-0018' },
  { full_name: 'Mintu', email: 'mintu.driver@mu.edu.bd', phone: '01710000002', bus: '11-0900' },
  { full_name: 'Shahadat', email: 'shahadat.driver@mu.edu.bd', phone: '01710000003', bus: '11-0944' },
  { full_name: 'Forid', email: 'forid.driver@mu.edu.bd', phone: '01710000004', bus: 'New-2' },
  { full_name: 'Abed', email: 'abed.driver@mu.edu.bd', phone: '01710000005', bus: '11-0967' },
  { full_name: 'Monir', email: 'monir.driver@mu.edu.bd', phone: '01710000006', bus: 'New-1' },
  { full_name: 'Mohsin', email: 'mohsin.driver@mu.edu.bd', phone: '01710000007', bus: '11-0010' },
];

const EFFECTIVE_FROM = '2026-07-27';
const REGULAR_DAYS = 'Sun-Thu';

const SEED_SCHEDULES = [
  // Route 1 - Teacher transport (Bus 11-0018 / Sojib)
  { route: 'medina-tilagarh', bus: '11-0018', arrival: '08:10', departure: null, notes: 'Teacher transport - morning pickup' },
  { route: 'medina-tilagarh', bus: '11-0018', arrival: null, departure: '16:00', notes: 'Teacher transport - afternoon drop-off' },

  // Route 2 - Rikabibazar corridor (staff + student)
  { route: 'rikabibazar-tilagarh', bus: '11-0900', arrival: '09:24', departure: null, notes: 'Staff transport' },
  { route: 'rikabibazar-tilagarh', bus: '11-0944', arrival: null, departure: '18:00', notes: 'Staff transport (trial bus)' },
  { route: 'rikabibazar-tilagarh', bus: '11-0900', arrival: '08:10', departure: '17:10', notes: 'Student transport' },

  // Route 3 - Pathantula corridor (student)
  { route: 'pathantula-tilagarh', bus: 'New-2', arrival: '08:10', departure: '17:10', notes: 'Student transport' },

  // Route 4 - Temukhi corridor (student)
  { route: 'temukhi-tilagarh', bus: 'New-2', arrival: '11:00', departure: '18:05', notes: 'Student transport - midday trip' },
  { route: 'temukhi-tilagarh', bus: 'New-1', arrival: '08:05', departure: '15:10', notes: 'Student transport' },

  // Route 5 - Rikabibazar / Naiorpul corridor (student)
  { route: 'rikabibazar-naiorpul', bus: '11-0967', arrival: '08:10', departure: '15:10', notes: 'Student transport' },

  // Route 6 - University-operated bus, Kajirbazar corridor
  { route: 'kajirbazar-naiorpul', bus: 'Univ-1', arrival: '08:10', departure: '15:10', notes: 'Student transport (university-operated bus)' },
  { route: 'kajirbazar-naiorpul', bus: 'Univ-1', arrival: '08:10', departure: '17:10', notes: 'Student transport (university-operated bus)' },
  { route: 'kajirbazar-naiorpul', bus: 'Univ-1', arrival: '08:10', departure: '17:05', notes: 'Student transport (university-operated bus)' },

  // Route 7 - Humayun Chottor / Shibganj corridor
  { route: 'humayun-shibganj', bus: '11-0010', arrival: '11:05', departure: '15:10', notes: 'Student transport' },

  // Route 8 - Trial bypass route
  { route: 'sreerampur-bypass', bus: '11-0944', arrival: '08:30', departure: null, notes: 'Trial / pilot service' },
  { route: 'sreerampur-bypass', bus: '11-0018', arrival: null, departure: '18:05', notes: 'Trial / pilot service' },

  // Route 9 - Campus <-> Rikabibazar midday shuttle
  { route: 'campus-rikabibazar-shuttle', bus: 'New-2', arrival: null, departure: '12:15', notes: 'Midday shuttle service' },
  { route: 'campus-rikabibazar-shuttle', bus: 'New-2', arrival: '12:50', departure: null, notes: 'Midday shuttle service' },
  { route: 'campus-rikabibazar-shuttle', bus: 'New-1', arrival: null, departure: '12:50', notes: 'Midday shuttle service' },
  { route: 'campus-rikabibazar-shuttle', bus: 'New-1', arrival: '13:10', departure: null, notes: 'Midday shuttle service' },
  { route: 'campus-rikabibazar-shuttle', bus: '11-0944', arrival: null, departure: '13:10', notes: 'Midday shuttle service' },
  { route: 'campus-rikabibazar-shuttle', bus: '11-0944', arrival: '13:40', departure: null, notes: 'Midday shuttle service' },

  // Route 10 - Campus <-> Shahi Eidgah shuttle
  { route: 'campus-shahieidgah-shuttle', bus: '11-0900', arrival: null, departure: '13:30', notes: 'Midday shuttle service' },
  { route: 'campus-shahieidgah-shuttle', bus: '11-0900', arrival: '14:00', departure: null, notes: 'Midday shuttle service' },
  { route: 'campus-shahieidgah-shuttle', bus: '11-0967', arrival: null, departure: '13:30', notes: 'Midday shuttle service' },
  { route: 'campus-shahieidgah-shuttle', bus: '11-0967', arrival: '14:00', departure: null, notes: 'Midday shuttle service' },

  // Route 11 - Campus <-> Tilagarh shuttle (frequent)
  { route: 'campus-tilagarh-shuttle', bus: '11-0018', arrival: null, departure: '12:05', notes: 'Shuttle service' },
  { route: 'campus-tilagarh-shuttle', bus: '11-0018', arrival: '12:30', departure: '13:10', notes: 'Shuttle service' },
  { route: 'campus-tilagarh-shuttle', bus: '11-0018', arrival: '13:35', departure: null, notes: 'Shuttle service' },
  { route: 'campus-tilagarh-shuttle', bus: '11-0010', arrival: null, departure: '14:05', notes: 'Shuttle service' },
  { route: 'campus-tilagarh-shuttle', bus: '11-0010', arrival: '14:30', departure: null, notes: 'Shuttle service' },
  { route: 'campus-tilagarh-shuttle', bus: '11-0018', arrival: null, departure: '15:05', notes: 'Shuttle service' },
  { route: 'campus-tilagarh-shuttle', bus: '11-0010', arrival: null, departure: '17:05', notes: 'Shuttle service' },

  // Route 12 - Campus <-> Darbasta
  { route: 'campus-darbasta', bus: '11-0010', arrival: '08:10', departure: '18:05', notes: 'Daily service' },
];

// A couple of illustrative examination-period examples so the "different
// schedule periods" feature is visibly working out of the box. Admins can
// edit or replace these once the official examination timing is confirmed.
const SEED_EXAM_SCHEDULES = [
  { route: 'rikabibazar-tilagarh', bus: '11-0900', arrival: '07:00', departure: '13:30', notes: 'Example examination-period timing - update via Admin Panel with the confirmed schedule.' },
  { route: 'medina-tilagarh', bus: '11-0018', arrival: '07:15', departure: '13:45', notes: 'Example examination-period timing - update via Admin Panel with the confirmed schedule.' },
];

// Two illustrative examples, seeded with today's date (whatever day the
// database happens to be first initialized on) so they show up live the
// moment someone opens the Student Dashboard - one structured Delay
// report (with a reason, stop and delay duration, exactly like a Driver
// would submit from the Driver Dashboard) and one plain informational
// notice. Both use the same "Driver reports -> notices table -> Student
// Dashboard status" path as a real report; nothing here is faked.
const SEED_NOTICES = [
  {
    driverEmail: 'sojib.driver@mu.edu.bd',
    busNumber: '11-0018',
    routeKey: 'medina-tilagarh',
    noticeType: 'delayed',
    reason: 'Traffic',
    stopName: 'Chowhatta',
    delayMinutes: 15,
  },
  {
    driverEmail: 'mintu.driver@mu.edu.bd',
    busNumber: '11-0900',
    routeKey: 'rikabibazar-tilagarh',
    noticeType: 'general',
    message: 'Bus 11-0900 is running on schedule today.',
  },
];

async function seedTransportData(adminId) {
  const routeIdByKey = {};
  const stopIdByRouteAndName = {};
  for (const route of SEED_ROUTES) { // eslint-disable-line no-restricted-syntax
    const result = await run( // eslint-disable-line no-await-in-loop
      'INSERT INTO routes (route_name, description, status) VALUES (?, ?, ?)',
      [route.route_name, route.description, 'active']
    );
    routeIdByKey[route.key] = result.lastID;

    let order = 1;
    for (const stopName of route.stops) { // eslint-disable-line no-restricted-syntax
      const stopResult = await run( // eslint-disable-line no-await-in-loop
        'INSERT INTO stops (route_id, stop_name, stop_order, status) VALUES (?, ?, ?, ?)',
        [result.lastID, stopName, order, 'active']
      );
      stopIdByRouteAndName[`${route.key}::${stopName}`] = stopResult.lastID;
      order += 1;
    }
  }

  const busIdByNumber = {};
  for (const bus of SEED_BUSES) { // eslint-disable-line no-restricted-syntax
    const result = await run( // eslint-disable-line no-await-in-loop
      'INSERT INTO buses (bus_number, bus_name, capacity, status) VALUES (?, ?, ?, ?)',
      [bus.number, bus.name, bus.capacity, 'active']
    );
    busIdByNumber[bus.number] = result.lastID;
  }

  const driverIdByEmail = {};
  for (const driver of SEED_DRIVERS) { // eslint-disable-line no-restricted-syntax
    const busId = busIdByNumber[driver.bus] || null;
    const result = await run( // eslint-disable-line no-await-in-loop
      'INSERT INTO drivers (full_name, email, phone, password, bus_id, status, created_by_admin) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [driver.full_name, driver.email, driver.phone, hashPassword('driver123'), busId, 'active', adminId]
    );
    driverIdByEmail[driver.email] = result.lastID;
    if (busId) {
      const scheduleForBus = SEED_SCHEDULES.find((s) => s.bus === driver.bus);
      if (scheduleForBus) {
        const routeId = routeIdByKey[scheduleForBus.route];
        await run('UPDATE buses SET route_id = ? WHERE id = ?', [routeId, busId]); // eslint-disable-line no-await-in-loop
        await run('UPDATE drivers SET route_id = ? WHERE id = ?', [routeId, result.lastID]); // eslint-disable-line no-await-in-loop
      }
    }
  }

  for (const item of SEED_SCHEDULES) { // eslint-disable-line no-restricted-syntax
    const busId = busIdByNumber[item.bus];
    const routeId = routeIdByKey[item.route];
    if (!busId || !routeId) continue; // eslint-disable-line no-continue
    await run( // eslint-disable-line no-await-in-loop
      `INSERT INTO schedules
        (bus_id, route_id, departure_time, arrival_time, operating_days, period, effective_from, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [busId, routeId, item.departure, item.arrival, REGULAR_DAYS, 'regular', EFFECTIVE_FROM, 'active', item.notes]
    );
  }

  for (const item of SEED_EXAM_SCHEDULES) { // eslint-disable-line no-restricted-syntax
    const busId = busIdByNumber[item.bus];
    const routeId = routeIdByKey[item.route];
    if (!busId || !routeId) continue; // eslint-disable-line no-continue
    await run( // eslint-disable-line no-await-in-loop
      `INSERT INTO schedules
        (bus_id, route_id, departure_time, arrival_time, operating_days, period, effective_from, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [busId, routeId, item.departure, item.arrival, REGULAR_DAYS, 'examination', EFFECTIVE_FROM, 'active', item.notes]
    );
  }

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  for (const notice of SEED_NOTICES) { // eslint-disable-line no-restricted-syntax
    const driverId = driverIdByEmail[notice.driverEmail];
    const busId = busIdByNumber[notice.busNumber] || null;
    const routeId = routeIdByKey[notice.routeKey] || null;
    if (!driverId) continue; // eslint-disable-line no-continue
    const stopId = notice.stopName ? stopIdByRouteAndName[`${notice.routeKey}::${notice.stopName}`] || null : null;
    const message = notice.noticeType === 'delayed'
      ? `Delay reported: ${notice.reason}${notice.stopName ? ` near ${notice.stopName}` : ''} (approx. ${notice.delayMinutes} minutes).`
      : notice.message;
    await run( // eslint-disable-line no-await-in-loop
      `INSERT INTO notices (driver_id, notice_type, bus_id, route_id, notice_date, reason, stop_id, delay_minutes, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [driverId, notice.noticeType, busId, routeId, todayStr, notice.reason || null, stopId, notice.delayMinutes || null, message]
    );
  }

  // Demo accounts so the full workflow can be tested immediately.
  await run(
    'INSERT INTO students (full_name, email, student_id, department, phone, password, status, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
    ['Demo Student', 'demo.student@mu.edu.bd', 'STU000001', 'Computer Science & Engineering', '01810000000', hashPassword('student123'), 'approved']
  );
  await run(
    'INSERT INTO students (full_name, email, student_id, department, phone, password, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['Pending Example', 'pending.example@mu.edu.bd', 'STU000002', 'Business Administration', '01810000001', hashPassword('student123'), 'pending']
  );
}

async function initDatabase() {
  await ensureDatabaseExists();
  await createSchema();

  let admin = await get('SELECT id FROM admins WHERE username = ?', ['admin']);
  if (!admin) {
    const result = await run(
      'INSERT INTO admins (username, password, full_name) VALUES (?, ?, ?)',
      ['admin', hashPassword('admin123'), 'System Admin']
    );
    admin = { id: result.lastID };
  }

  const routeCountRow = await get('SELECT COUNT(*) as count FROM routes');
  if (!routeCountRow || routeCountRow.count === 0) {
    await seedTransportData(admin.id);
  }
}

module.exports = {
  run: (sql, params) => run(sql, params),
  get: (sql, params) => get(sql, params),
  all: (sql, params) => all(sql, params),
  initDatabase,
  hashPassword,
  verifyPassword,
};
