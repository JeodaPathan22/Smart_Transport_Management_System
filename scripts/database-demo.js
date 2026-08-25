#!/usr/bin/env node

/**
 * Smart Transport Management System
 * Automated Node.js MySQL database operation demonstration.
 *
 * Runs the same set of operations as database/demo_operations.sql (SHOW
 * TABLES, table structure, SELECT, INSERT, UPDATE, DELETE, CREATE TABLE,
 * DROP TABLE, final verification), but driven from Node instead of typed
 * by hand at a MySQL/MariaDB terminal - a quick, repeatable,
 * screenshot-friendly proof that these operations work from inside the
 * actual project, against the actual project database.
 *
 * Reuses the SAME database layer the website itself uses:
 *   - config/database.js  for connection settings (from .env)
 *   - db.js                for the mysql2/promise pool and run/get/all
 * No second/duplicate database connection is created here.
 *
 * Usage:
 *   npm run db:demo
 *
 * SAFETY (see also the SAFETY note at the top of database/demo_operations.sql)
 *   - Only ever touches one clearly-marked demo route in `routes`
 *     (name starting with "DEMO -", status = 'inactive' so it can never
 *     appear on the live public website even while npm start is running),
 *     and one temporary table (database_demo_table) that the application
 *     never reads or writes.
 *   - Cleans both of those up again before it exits - even if something
 *     fails partway through (see the try/finally below).
 *   - Never touches real students/drivers/buses/routes/schedules/notices/
 *     bookings/trips/boardings, and never drops any of the 11 real
 *     application tables.
 *   - Safe to run again immediately afterwards.
 */

const db = require('../db');
const dbConfig = require('../config/database');

const APP_TABLES = [
  'admins', 'routes', 'stops', 'buses', 'drivers', 'students',
  'schedules', 'notices', 'bookings', 'trips', 'trip_boardings',
];

const DEMO_ROUTE_NAME = 'DEMO - Node.js Automated Demo (safe to delete)';
const DEMO_TABLE = 'database_demo_table';

/* ---------------------------------------------------------------------- */
/* Small output helpers                                                    */
/* ---------------------------------------------------------------------- */

function banner() {
  const line = '='.repeat(70);
  console.log(`\n${line}`);
  console.log('SMART TRANSPORT MANAGEMENT SYSTEM');
  console.log('MYSQL DATABASE OPERATION DEMONSTRATION');
  console.log(`${line}\n`);
}

function section(n, title) {
  const line = '-'.repeat(70);
  console.log(`\n${line}`);
  console.log(`[${n}] ${title}`);
  console.log(line);
}

function ok(msg) { console.log(`  [OK] ${msg}`); }
function note(msg) { console.log(`  [NOTE] ${msg}`); }
function warn(msg) { console.log(`  [WARNING] ${msg}`); }

// Prints rows as a table, or a friendly "(no rows)" note when the result
// set is empty - clearer than an empty console.table() on its own.
function showRows(rows, emptyMessage) {
  if (!rows || rows.length === 0) {
    note(emptyMessage || 'No matching rows.');
  } else {
    console.table(rows);
  }
}

// SHOW TABLES' single column is named Tables_in_<database name>, so its
// name is read positionally instead of being hard-coded here.
async function showTables() {
  const rows = await db.all('SHOW TABLES');
  return rows.map((row) => Object.values(row)[0]);
}

// Removes any leftover demo data from a previous run that was interrupted
// before it could clean up after itself. Every statement here is
// idempotent (safe to run even when there is nothing to clean up), so this
// doubles as the "make it safe to run again" step and the "clean up after
// a failure" step (see the try/finally in main()).
async function cleanupDemoData() {
  await db.run("DELETE FROM routes WHERE route_name LIKE 'DEMO -%'");
  await db.run(`DROP TABLE IF EXISTS ${DEMO_TABLE}`);
}

/* ---------------------------------------------------------------------- */
/* Main demonstration                                                      */
/* ---------------------------------------------------------------------- */

async function main() {
  banner();

  section(1, 'DATABASE CONNECTION');
  console.log('  Connecting using the same settings as the website (.env / config/database.js)');
  console.log(`  Host: ${dbConfig.host}:${dbConfig.port}   User: ${dbConfig.user}   Database: ${dbConfig.database}`);

  // Same initialization bin/www runs before the HTTP server starts
  // accepting requests - creates the database/schema/seed data if this
  // happens to be a completely fresh MySQL install, and is a safe no-op
  // if npm start has already been run at least once.
  await db.initDatabase();

  const info = await db.get('SELECT DATABASE() AS db_name, VERSION() AS mysql_version');
  ok(`Connected. Current database: ${info.db_name}`);
  ok(`MySQL/MariaDB server version: ${info.mysql_version}`);

  section(2, 'DATABASE TABLES');
  const tables = await showTables();
  console.table(tables.map((name) => ({ table: name })));
  const missing = APP_TABLES.filter((t) => !tables.includes(t));
  if (missing.length) {
    warn(`Missing expected application tables: ${missing.join(', ')}`);
  } else {
    ok(`All 11 application tables present (${tables.length} table(s) total).`);
  }

  section(3, 'TABLE STRUCTURE');
  for (const table of APP_TABLES) { // eslint-disable-line no-restricted-syntax
    console.log(`\n  -- DESCRIBE ${table} --`);
    console.table(await db.all(`DESCRIBE ${table}`)); // eslint-disable-line no-await-in-loop
  }
  note('SHOW CREATE TABLE for three tables that best illustrate the schema (PK/AUTO_INCREMENT, foreign keys with SET NULL vs CASCADE, UNIQUE, ENUM):');
  for (const table of ['drivers', 'students', 'trip_boardings']) { // eslint-disable-line no-restricted-syntax
    const row = await db.get(`SHOW CREATE TABLE ${table}`); // eslint-disable-line no-await-in-loop
    console.log(`\n  -- SHOW CREATE TABLE ${table} --`);
    console.log(row['Create Table']);
  }

  section(4, 'SELECT OPERATION');
  // admins / drivers / students store a salted password hash (see db.js
  // hashPassword()) - these three use an explicit column list so the hash
  // is never printed to the screen/screenshots during a presentation.
  const SAFE_SELECTS = {
    admins: 'SELECT id, username, full_name, created_at FROM admins',
    drivers: 'SELECT id, full_name, email, phone, bus_id, route_id, status, created_by_admin, created_at FROM drivers',
    students: 'SELECT id, full_name, email, student_id, department, phone, status, created_at, reviewed_at FROM students',
  };
  for (const table of APP_TABLES) { // eslint-disable-line no-restricted-syntax
    const sql = SAFE_SELECTS[table] || `SELECT * FROM ${table}`;
    console.log(`\n  -- ${table}${SAFE_SELECTS[table] ? ' (password column excluded)' : ''} --`);
    showRows(await db.all(sql), 'No rows in this table yet.'); // eslint-disable-line no-await-in-loop
  }
  note('BONUS: live passenger count, joined across trips -> buses/drivers/routes/trip_boardings');
  showRows(
    await db.all(
      `SELECT t.id AS trip_id, b.bus_number, d.full_name AS driver, r.route_name, t.status,
              (SELECT COUNT(*) FROM trip_boardings tb WHERE tb.trip_id = t.id) AS passenger_count
       FROM trips t
       JOIN buses b ON b.id = t.bus_id
       JOIN drivers d ON d.id = t.driver_id
       LEFT JOIN routes r ON r.id = t.route_id
       ORDER BY t.created_at DESC
       LIMIT 10`
    ),
    'No trips recorded yet (start one from the Driver Dashboard to see this populated).'
  );

  // Everything from here on writes to the database. Clean up any leftovers
  // from a previous interrupted run first, so Sections 5-9 always start
  // from a known, clean state.
  await cleanupDemoData();

  try {
    section(5, 'INSERT OPERATION');
    console.log('  Using table: routes (temporary demo record, status = inactive so it never shows on the live site)');
    console.log('\n  BEFORE INSERT:');
    showRows(
      await db.all('SELECT id, route_name, status FROM routes WHERE route_name = ?', [DEMO_ROUTE_NAME]),
      'No matching row yet (as expected).'
    );

    const insertResult = await db.run(
      'INSERT INTO routes (route_name, description, status) VALUES (?, ?, ?)',
      [DEMO_ROUTE_NAME, 'Temporary record created only to demonstrate INSERT during the database viva.', 'inactive']
    );
    let demoRouteId = insertResult.lastID;
    ok(`Inserted demo route (id = ${demoRouteId}).`);

    console.log('\n  AFTER INSERT:');
    showRows(await db.all('SELECT id, route_name, description, status FROM routes WHERE id = ?', [demoRouteId]));

    section(6, 'UPDATE OPERATION');
    console.log('  BEFORE UPDATE:');
    showRows(await db.all('SELECT id, route_name, description FROM routes WHERE id = ?', [demoRouteId]));

    await db.run('UPDATE routes SET description = ? WHERE id = ?', [
      'This description was changed by the UPDATE demonstration.',
      demoRouteId,
    ]);
    ok('Updated the demo route.');

    console.log('\n  AFTER UPDATE:');
    showRows(await db.all('SELECT id, route_name, description FROM routes WHERE id = ?', [demoRouteId]));

    section(7, 'DELETE OPERATION');
    console.log('  BEFORE DELETE (record exists):');
    showRows(await db.all('SELECT id, route_name FROM routes WHERE id = ?', [demoRouteId]));

    const deletedRouteId = demoRouteId;
    await db.run('DELETE FROM routes WHERE id = ?', [demoRouteId]);
    ok('Deleted the demo route.');
    demoRouteId = null;

    console.log('\n  AFTER DELETE:');
    showRows(
      await db.all('SELECT id, route_name FROM routes WHERE id = ?', [deletedRouteId]),
      'No matching row found (as expected) - the record is gone.'
    );

    section(8, 'CREATE TABLE OPERATION');
    await db.run(`DROP TABLE IF EXISTS ${DEMO_TABLE}`);
    await db.run(`
      CREATE TABLE ${DEMO_TABLE} (
        id INT PRIMARY KEY AUTO_INCREMENT,
        demo_label VARCHAR(100) NOT NULL,
        demo_value VARCHAR(255),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    ok(`Created temporary table "${DEMO_TABLE}" (not one of the 11 application tables).`);

    console.log('\n  SHOW TABLES (12 now - 11 real + the temporary demo table):');
    console.table((await showTables()).map((name) => ({ table: name })));

    console.log(`\n  DESCRIBE ${DEMO_TABLE}:`);
    console.table(await db.all(`DESCRIBE ${DEMO_TABLE}`));

    await db.run(`INSERT INTO ${DEMO_TABLE} (demo_label, demo_value) VALUES (?, ?)`, [
      'CREATE TABLE demo',
      'This row lives only in the temporary demo table.',
    ]);
    console.log(`\n  SELECT * FROM ${DEMO_TABLE}:`);
    showRows(await db.all(`SELECT * FROM ${DEMO_TABLE}`));

    section(9, 'DROP TABLE OPERATION');
    console.log('  NEVER drops any of the 11 real application tables - only the temporary one above.');
    const countRow = await db.get(`SELECT COUNT(*) AS count FROM ${DEMO_TABLE}`);
    note(`"${DEMO_TABLE}" exists with ${countRow.count} row(s) before dropping it.`);

    await db.run(`DROP TABLE ${DEMO_TABLE}`);
    ok(`Dropped "${DEMO_TABLE}".`);

    const tablesAfterDrop = await showTables();
    console.log('\n  SHOW TABLES (back to 11):');
    console.table(tablesAfterDrop.map((name) => ({ table: name })));

    const stillMissing = APP_TABLES.filter((t) => !tablesAfterDrop.includes(t));
    if (stillMissing.length) {
      warn(`Unexpected - missing application table(s) after drop: ${stillMissing.join(', ')}`);
    } else {
      ok('All 11 original application tables are still present.');
    }
    if (tablesAfterDrop.includes(DEMO_TABLE)) {
      warn(`Unexpected - "${DEMO_TABLE}" is still present after DROP TABLE.`);
    } else {
      ok(`"${DEMO_TABLE}" is confirmed gone.`);
    }
  } finally {
    // Belt-and-braces: whatever happened in Sections 5-9 above, make sure
    // no demo route or demo table is left behind. Safe to call even when
    // everything already cleaned up correctly - every statement in
    // cleanupDemoData() is idempotent.
    await cleanupDemoData();
  }

  section(10, 'FINAL DATABASE VERIFICATION');
  const finalTables = await showTables();
  console.table(finalTables.map((name) => ({ table: name })));

  const counts = [];
  for (const table of APP_TABLES) { // eslint-disable-line no-restricted-syntax
    const row = await db.get(`SELECT COUNT(*) AS row_count FROM ${table}`); // eslint-disable-line no-await-in-loop
    counts.push({ table, row_count: row.row_count });
  }
  console.table(counts);

  const leftoverDemoRoutes = await db.all("SELECT id, route_name FROM routes WHERE route_name LIKE 'DEMO -%'");
  const leftoverDemoTable = (await showTables()).includes(DEMO_TABLE);
  if (leftoverDemoRoutes.length || leftoverDemoTable) {
    warn('Unexpected - demo leftovers were found after cleanup. Please check manually.');
  } else {
    ok('No leftover demo data anywhere. Real project data is unchanged.');
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('DATABASE DEMONSTRATION COMPLETED SUCCESSFULLY');
  console.log(`${'='.repeat(70)}\n`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n[ERROR] Database demonstration failed:', err.message);
    try {
      await cleanupDemoData();
      console.error('[NOTE] Cleanup attempted - any demo route/table should have been removed.');
    } catch (cleanupErr) {
      console.error('[WARNING] Cleanup after failure also failed:', cleanupErr.message);
      console.error(`[WARNING] Please check manually for a route named "${DEMO_ROUTE_NAME}" and a table named "${DEMO_TABLE}".`);
    }
    console.error('[NOTE] Make sure XAMPP MySQL is running and the credentials in .env are correct.');
    process.exit(1);
  });
