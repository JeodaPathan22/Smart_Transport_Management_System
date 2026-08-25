-- ============================================================================
-- SMART TRANSPORT MANAGEMENT SYSTEM
-- MySQL / MariaDB Terminal Demonstration Script
-- ============================================================================
--
-- PURPOSE
--   This file lets you demonstrate CREATE / INSERT / SELECT / UPDATE / DELETE /
--   DROP, table structure, and foreign-key relationships against your REAL
--   `smart_transport_management` database during a university presentation
--   or viva - the same way you would type commands at a MySQL/MariaDB
--   terminal. Every command here runs against your actual project database;
--   nothing in this file is simulated.
--
-- HOW TO RUN IT (pick one - both are explained in full in README.md)
--   A) Live, command-by-command (recommended for a viva):
--      1. Open a terminal and connect:  mysql -u root -p
--         (leave the password blank / just press Enter on a stock XAMPP
--         install, since XAMPP's default root account has no password)
--      2. Copy/paste sections from this file one at a time as you narrate
--         each one to your examiner.
--
--   B) Run the whole file in one go, from inside the MySQL client:
--      MariaDB [(none)]> SOURCE database/demo_operations.sql;
--      (path is relative to where you started the `mysql` client - use the
--      full path if needed, e.g. SOURCE C:/xampp/htdocs/.../database/demo_operations.sql;)
--
--   C) Run the whole file from your OS terminal (outside the mysql client):
--      mysql -u root -p < database/demo_operations.sql
--
-- SAFETY
--   - This script only ever touches ONE clearly-marked temporary row (in
--     `routes`, name starting with "DEMO -") and ONE temporary table
--     (`database_demo_table`). It never modifies your 11 real application
--     tables' real data.
--   - The demo route is inserted with status = 'inactive', so even if your
--     Node app (`npm start`) is running live on http://localhost:3000 at
--     the same time, the demo route will NEVER appear on the public
--     website (the site only ever shows routes where status = 'active').
--   - This script is self-cleaning: by the time Section 10 finishes, the
--     demo route and the demo table are both gone again, and all 11 real
--     tables are untouched. It is safe to run from top to bottom as many
--     times as you like (each run cleans up any leftovers from a previous
--     interrupted run before it starts).
--
-- ============================================================================


-- ============================================================================
-- SECTION 1: DATABASE SELECTION
-- ============================================================================
-- Shows every database this MySQL/MariaDB server knows about, then switches
-- into the project's own database so every command below runs against it.

SHOW DATABASES;

USE smart_transport_management;

-- Confirms which database the current session is now pointed at.
SELECT DATABASE() AS current_database;


-- ============================================================================
-- SECTION 2: SHOW ALL TABLES
-- ============================================================================
-- The project has exactly 11 real application tables. This is the same
-- list db.js creates on startup (CREATE TABLE IF NOT EXISTS) and the same
-- list database/smart_transport_management.sql recreates via phpMyAdmin.

SHOW TABLES;

-- Expected (11 rows): admins, routes, stops, buses, drivers, students,
-- schedules, notices, bookings, trips, trip_boardings


-- ============================================================================
-- SECTION 3: TABLE STRUCTURE
-- ============================================================================
-- DESCRIBE (a.k.a. SHOW COLUMNS FROM) prints each table's columns, types,
-- nullability, keys and defaults - good for quickly walking an examiner
-- through every table's shape.

DESCRIBE admins;
DESCRIBE routes;
DESCRIBE stops;
DESCRIBE buses;
DESCRIBE drivers;
DESCRIBE students;
DESCRIBE schedules;
DESCRIBE notices;
DESCRIBE bookings;
DESCRIBE trips;
DESCRIBE trip_boardings;

-- SHOW CREATE TABLE prints the full CREATE TABLE statement MySQL actually
-- stored for a table - this is the clearest way to show a specific
-- constraint (PRIMARY KEY, AUTO_INCREMENT, FOREIGN KEY, UNIQUE, ENUM,
-- NOT NULL, ON DELETE ...) to an examiner. You can run this for ANY of the
-- 11 tables above; three particularly good ones to demonstrate are below.

-- (a) drivers - three foreign keys to three different parent tables, all
--     ON DELETE SET NULL (so deleting a bus/route/admin un-assigns the
--     driver instead of deleting the driver), plus a UNIQUE email.
SHOW CREATE TABLE drivers;

-- (b) students - two independent UNIQUE columns (email, student_id) and a
--     4-value ENUM ('pending','approved','rejected','suspended') that
--     drives the whole signup-approval workflow.
SHOW CREATE TABLE students;

-- (c) trip_boardings - two ON DELETE CASCADE foreign keys, plus the
--     composite UNIQUE KEY uniq_trip_student(trip_id, student_id) that is
--     what actually stops a student being counted twice on the same trip
--     (enforced by the database itself, not just application code).
SHOW CREATE TABLE trip_boardings;


-- ============================================================================
-- SECTION 4: SELECT OPERATION
-- ============================================================================
-- One SELECT per real table. admins / drivers / students store a salted
-- password hash (see db.js hashPassword()) - the plain SELECT * for those
-- three is included for completeness but is commented out, because it
-- would print the hash to your screen/screenshots. Use the safe version
-- (explicit column list, no password column) instead during your
-- presentation - the safe versions are what you should actually run live.

-- admins ---------------------------------------------------------------
-- SELECT * FROM admins;                                        -- exposes password hash - avoid on screen
SELECT id, username, full_name, created_at FROM admins;         -- safe version (recommended)

-- routes -----------------------------------------------------------------
SELECT * FROM routes;

-- stops --------------------------------------------------------------------
SELECT * FROM stops;

-- buses ----------------------------------------------------------------------
SELECT * FROM buses;

-- drivers ------------------------------------------------------------------
-- SELECT * FROM drivers;                                       -- exposes password hash - avoid on screen
SELECT id, full_name, email, phone, bus_id, route_id, status, created_by_admin, created_at
FROM drivers;                                                   -- safe version (recommended)

-- students -----------------------------------------------------------------
-- SELECT * FROM students;                                      -- exposes password hash - avoid on screen
SELECT id, full_name, email, student_id, department, phone, status, created_at, reviewed_at
FROM students;                                                  -- safe version (recommended)

-- schedules ------------------------------------------------------------------
SELECT * FROM schedules;

-- notices ------------------------------------------------------------------
SELECT * FROM notices;

-- bookings -----------------------------------------------------------------
SELECT * FROM bookings;

-- trips --------------------------------------------------------------------
SELECT * FROM trips;

-- trip_boardings ------------------------------------------------------------
SELECT * FROM trip_boardings;

-- BONUS - two JOIN queries that demonstrate the foreign-key relationships
-- actually being used, not just declared (good for the "explain your
-- relationships" part of a viva):

-- Every stop, with the route it belongs to (stops.route_id -> routes.id)
SELECT r.route_name, s.stop_name, s.stop_order
FROM stops s
JOIN routes r ON s.route_id = r.id
ORDER BY r.route_name, s.stop_order
LIMIT 15;

-- Every trip with its bus/driver/route and a LIVE passenger count, i.e.
-- COUNT(*) computed on the fly from trip_boardings - this is exactly the
-- query the Driver Dashboard and Admin Panel use, so it is never a stored
-- number that could drift out of sync.
SELECT t.id AS trip_id, b.bus_number, d.full_name AS driver, r.route_name, t.status,
       (SELECT COUNT(*) FROM trip_boardings tb WHERE tb.trip_id = t.id) AS passenger_count
FROM trips t
JOIN buses b ON b.id = t.bus_id
JOIN drivers d ON d.id = t.driver_id
LEFT JOIN routes r ON r.id = t.route_id
ORDER BY t.created_at DESC
LIMIT 10;


-- ============================================================================
-- SECTION 5: INSERT OPERATION
-- ============================================================================
-- Demonstrates INSERT with a single, clearly-marked, disposable record in
-- `routes`. status is set to 'inactive' on purpose - see SAFETY note above.

-- Safety net: remove any leftover demo route from a previous run that was
-- interrupted before it could clean up after itself, so this section
-- always starts from a clean slate.
DELETE FROM routes WHERE route_name = 'DEMO - SQL Terminal Viva Demo (safe to delete)';

-- BEFORE INSERT - should return an empty result set.
SELECT * FROM routes WHERE route_name = 'DEMO - SQL Terminal Viva Demo (safe to delete)';

-- INSERT the demonstration record.
INSERT INTO routes (route_name, description, status)
VALUES (
  'DEMO - SQL Terminal Viva Demo (safe to delete)',
  'Temporary record created only to demonstrate INSERT during the database viva.',
  'inactive'
);

-- Remember the auto-generated id so Sections 6 and 7 can target this exact
-- row (this is what AUTO_INCREMENT on routes.id is doing for you).
SET @demo_route_id = LAST_INSERT_ID();
SELECT @demo_route_id AS demo_route_id;

-- AFTER INSERT - the new row now appears, with its auto-generated id.
SELECT * FROM routes WHERE id = @demo_route_id;


-- ============================================================================
-- SECTION 6: UPDATE OPERATION
-- ============================================================================
-- Uses the same demonstration record created in Section 5.

-- BEFORE UPDATE
SELECT id, route_name, description, status FROM routes WHERE id = @demo_route_id;

-- UPDATE the record.
UPDATE routes
SET description = 'This description was changed by the UPDATE demonstration.'
WHERE id = @demo_route_id;

-- AFTER UPDATE - description column has visibly changed.
SELECT id, route_name, description, status FROM routes WHERE id = @demo_route_id;


-- ============================================================================
-- SECTION 7: DELETE OPERATION
-- ============================================================================
-- Removes the same demonstration record, proving DELETE works and leaving
-- the real database exactly as it was before Section 5 ran.

-- BEFORE DELETE - the record still exists.
SELECT * FROM routes WHERE id = @demo_route_id;

-- DELETE the record.
DELETE FROM routes WHERE id = @demo_route_id;

-- AFTER DELETE - empty result set proves it is gone.
SELECT * FROM routes WHERE id = @demo_route_id;

-- Double-check no demo route is left behind under any name.
SELECT * FROM routes WHERE route_name LIKE 'DEMO -%';


-- ============================================================================
-- SECTION 8: CREATE TABLE OPERATION
-- ============================================================================
-- Creates a table that is NOT one of the 11 real application tables, purely
-- for demonstration. Nothing in the application ever reads or writes
-- database_demo_table.

-- Safety net for repeated runs.
DROP TABLE IF EXISTS database_demo_table;

CREATE TABLE database_demo_table (
  id INT PRIMARY KEY AUTO_INCREMENT,
  demo_label VARCHAR(100) NOT NULL,
  demo_value VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Confirms the new table now exists alongside the 11 real tables (12 total).
SHOW TABLES;

DESCRIBE database_demo_table;

-- Small demonstration record inside the temporary table.
INSERT INTO database_demo_table (demo_label, demo_value)
VALUES ('CREATE TABLE demo', 'This row lives only in the temporary demo table.');

SELECT * FROM database_demo_table;


-- ============================================================================
-- SECTION 9: DROP TABLE OPERATION
-- ============================================================================
-- IMPORTANT: only ever drops the temporary table created in Section 8.
-- NEVER drop any of the 11 real application tables:
--   admins, routes, stops, buses, drivers, students, schedules, notices,
--   bookings, trips, trip_boardings

-- Confirm the temporary table still exists before dropping it.
SELECT COUNT(*) AS database_demo_table_row_count FROM database_demo_table;

DROP TABLE database_demo_table;

-- Proves only the temporary table disappeared - this should list exactly
-- the same 11 real tables as Section 2, and nothing named database_demo_table.
SHOW TABLES;

-- Explicit, table-by-table proof that all 11 original application tables
-- are still present (each query should return exactly 1).
SELECT COUNT(*) AS exists_admins        FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins';
SELECT COUNT(*) AS exists_routes        FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'routes';
SELECT COUNT(*) AS exists_stops         FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stops';
SELECT COUNT(*) AS exists_buses         FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'buses';
SELECT COUNT(*) AS exists_drivers       FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'drivers';
SELECT COUNT(*) AS exists_students      FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students';
SELECT COUNT(*) AS exists_schedules     FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schedules';
SELECT COUNT(*) AS exists_notices       FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notices';
SELECT COUNT(*) AS exists_bookings      FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings';
SELECT COUNT(*) AS exists_trips         FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trips';
SELECT COUNT(*) AS exists_trip_boardings FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trip_boardings';

-- And that database_demo_table is genuinely gone (should return 0).
SELECT COUNT(*) AS exists_database_demo_table FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'database_demo_table';


-- ============================================================================
-- SECTION 10: FINAL VERIFICATION
-- ============================================================================
-- One last full pass proving the database is back to exactly 11 real
-- tables, with real data untouched and no demo leftovers anywhere.

SHOW TABLES;

SELECT
  (SELECT COUNT(*) FROM admins)         AS admins_count,
  (SELECT COUNT(*) FROM routes)         AS routes_count,
  (SELECT COUNT(*) FROM stops)          AS stops_count,
  (SELECT COUNT(*) FROM buses)          AS buses_count,
  (SELECT COUNT(*) FROM drivers)        AS drivers_count,
  (SELECT COUNT(*) FROM students)       AS students_count,
  (SELECT COUNT(*) FROM schedules)      AS schedules_count,
  (SELECT COUNT(*) FROM notices)        AS notices_count,
  (SELECT COUNT(*) FROM bookings)       AS bookings_count,
  (SELECT COUNT(*) FROM trips)          AS trips_count,
  (SELECT COUNT(*) FROM trip_boardings) AS trip_boardings_count;

-- Confirms no demo route was left behind (should be an empty result set).
SELECT * FROM routes WHERE route_name LIKE 'DEMO -%';

SELECT 'DATABASE DEMONSTRATION COMPLETED SUCCESSFULLY' AS status;
