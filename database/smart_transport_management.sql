-- Smart Transport Management System
-- MySQL schema + seed data (migrated from SQLite, later extended with
-- Admin-created notices and structured Driver delay/breakdown reports)
-- Generated to exactly match db.js - safe to import via phpMyAdmin (XAMPP)
-- into a fresh database. The Node app also creates/seeds this schema
-- automatically on first run (see db.js), so importing this file first
-- is optional - it is provided as a convenience / portable snapshot.
--
-- This file always creates the CURRENT (final) table shapes directly.
-- If you already have an OLDER version of this database (created before
-- Admin notices / structured Driver reports existed), do NOT run this
-- file against it - just run `npm start` once instead; db.js detects
-- the older `notices` table automatically and upgrades it in place
-- (adding the new columns) without touching any of your existing data.
-- This file is only for creating a database from nothing.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE DATABASE IF NOT EXISTS `smart_transport_management` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `smart_transport_management`;

-- ============================================================
-- Schema
-- ============================================================

CREATE TABLE IF NOT EXISTS admins (
  id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(191) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS routes (
  id INT PRIMARY KEY AUTO_INCREMENT,
  route_name VARCHAR(255) NOT NULL,
  description TEXT,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stops (
  id INT PRIMARY KEY AUTO_INCREMENT,
  route_id INT NOT NULL,
  stop_name VARCHAR(255) NOT NULL,
  stop_order INT NOT NULL DEFAULT 1,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS buses (
  id INT PRIMARY KEY AUTO_INCREMENT,
  bus_number VARCHAR(100) UNIQUE NOT NULL,
  bus_name VARCHAR(255),
  capacity INT,
  route_id INT,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Admin-created notices (notice_type = 'not_running' / 'general') AND
-- structured Driver delay/breakdown reports (notice_type = 'delayed' /
-- 'breakdown') share this one table - driver_id is set for a Driver
-- report, admin_id for an Admin notice, and the two are mutually
-- exclusive in practice (never enforced at the schema level, since a
-- CHECK constraint isn't needed for a DBMS project this size).
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Kept for compatibility with any existing installation - no page in the
-- current app writes to this table any more (the Student Booking
-- feature was removed), but it is not dropped just for that UI change.
CREATE TABLE IF NOT EXISTS bookings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  student_id INT NOT NULL,
  route_id INT NOT NULL,
  travel_date VARCHAR(20) NOT NULL,
  travel_time VARCHAR(10) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Trip log - Start Trip / End Trip / Report Breakdown (Driver Dashboard)
-- and Live Trips & Breakdowns (Admin Panel).
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Kept for compatibility with any existing installation - no page in the
-- current app writes to this table any more (the automatic passenger-
-- counting/boarding feature was removed), but it is not dropped just
-- for that UI change.
CREATE TABLE IF NOT EXISTS trip_boardings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  trip_id INT NOT NULL,
  student_id INT NOT NULL,
  boarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE,
  FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_trip_student (trip_id, student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- Seed data (matches db.js exactly - same routes, stops, buses,
-- drivers, schedules, notices and demo accounts)
-- ============================================================

-- Admin login: username=admin / password=admin123
INSERT INTO admins (id, username, password, full_name) VALUES
  (1, 'admin', 'cee0d27ba002045d178d325109a4b8b9:ec08aab575aa6f42992a8c537ec17710715fc1272c8c2cf3cc73cb2851768af0f042671ac1e64c137bc036310326f65774326877200a9783cd7588dc4adde7d5', 'System Admin');

-- Routes
INSERT INTO routes (id, route_name, description, status) VALUES
  (1, 'Medina Market - Rikabibazar - Shahi Eidgah - Tilagarh (Teacher Transport)', 'Daily staff/teacher transport corridor linking Pathantula, Subidbazar, Rikabibazar, Chowhatta, Ambarkhana and Medina Market to the campus via Shahi Eidgah and Tilagarh.', 'active'),
  (2, 'Rikabibazar - Shahi Eidgah - Tilagarh', 'Connects Rikabibazar, Kumarpara and Shahi Eidgah to the campus via Tilagarh. Serves both staff and student trips.', 'active'),
  (3, 'Pathantula - Subidbazar - Ambarkhana - Tilagarh', 'Serves Pathantula, Subidbazar and Ambarkhana on the way to campus via Shahi Eidgah and Tilagarh.', 'active'),
  (4, 'Temukhi - Medina Market - Subidbazar - Tilagarh', 'Long city route from Temukhi through Medina Market and Subidbazar to campus via Ambarkhana, Shahi Eidgah and Tilagarh.', 'active'),
  (5, 'Rikabibazar - Chowhatta - Naiorpul - Tilagarh', 'Connects Rikabibazar and Chowhatta to campus via Kumarpara, Naiorpul and Tilagarh.', 'active'),
  (6, 'Kajirbazar - Rikabibazar - Naiorpul - Tilagarh (University Bus)', 'University-operated route from Kajirbazar through Rikabibazar, Chowhatta and Naiorpul to campus.', 'active'),
  (7, 'Humayun Chottor - Shibganj - Tilagarh', 'Serves Humayun Chottor and Shibganj on the way to campus via Naiorpul and Tilagarh.', 'active'),
  (8, 'Sreerampur Bypass - Surma Gate Bypass (Trial Route)', 'Trial/pilot bypass route linking Sreerampur Bypass and Surma Gate Bypass directly to campus.', 'active'),
  (9, 'Campus - Rikabibazar Shuttle', 'Midday shuttle service between campus and Rikabibazar via Tilagarh, Shahi Eidgah and Kumarpara.', 'active'),
  (10, 'Campus - Shahi Eidgah Shuttle', 'Midday shuttle service running directly between campus and Shahi Eidgah.', 'active'),
  (11, 'Campus - Tilagarh Shuttle', 'Frequent shuttle service running throughout the day between campus and Tilagarh.', 'active'),
  (12, 'Campus - Darbasta', 'Daily service connecting campus with Darbasta.', 'active');

-- Stops (in order per route)
INSERT INTO stops (id, route_id, stop_name, stop_order, status) VALUES
  (1, 1, 'Pathantula', 1, 'active'),
  (2, 1, 'Subidbazar', 2, 'active'),
  (3, 1, 'Rikabibazar', 3, 'active'),
  (4, 1, 'Chowhatta', 4, 'active'),
  (5, 1, 'Ambarkhana', 5, 'active'),
  (6, 1, 'Medina Market', 6, 'active'),
  (7, 1, 'Kumarpara', 7, 'active'),
  (8, 1, 'Shahi Eidgah', 8, 'active'),
  (9, 1, 'Tilagarh', 9, 'active'),
  (10, 1, 'Metropolitan University Campus', 10, 'active'),
  (11, 2, 'Rikabibazar', 1, 'active'),
  (12, 2, 'Kumarpara', 2, 'active'),
  (13, 2, 'Shahi Eidgah', 3, 'active'),
  (14, 2, 'Tilagarh', 4, 'active'),
  (15, 2, 'Metropolitan University Campus', 5, 'active'),
  (16, 3, 'Pathantula', 1, 'active'),
  (17, 3, 'Subidbazar', 2, 'active'),
  (18, 3, 'Ambarkhana', 3, 'active'),
  (19, 3, 'Shahi Eidgah', 4, 'active'),
  (20, 3, 'Tilagarh', 5, 'active'),
  (21, 3, 'Metropolitan University Campus', 6, 'active'),
  (22, 4, 'Temukhi', 1, 'active'),
  (23, 4, 'Medina Market', 2, 'active'),
  (24, 4, 'Subidbazar', 3, 'active'),
  (25, 4, 'Ambarkhana', 4, 'active'),
  (26, 4, 'Shahi Eidgah', 5, 'active'),
  (27, 4, 'Tilagarh', 6, 'active'),
  (28, 4, 'Metropolitan University Campus', 7, 'active'),
  (29, 5, 'Rikabibazar', 1, 'active'),
  (30, 5, 'Chowhatta', 2, 'active'),
  (31, 5, 'Kumarpara', 3, 'active'),
  (32, 5, 'Naiorpul', 4, 'active'),
  (33, 5, 'Tilagarh', 5, 'active'),
  (34, 5, 'Metropolitan University Campus', 6, 'active'),
  (35, 6, 'Kajirbazar', 1, 'active'),
  (36, 6, 'Rikabibazar', 2, 'active'),
  (37, 6, 'Chowhatta', 3, 'active'),
  (38, 6, 'Kumarpara', 4, 'active'),
  (39, 6, 'Naiorpul', 5, 'active'),
  (40, 6, 'Tilagarh', 6, 'active'),
  (41, 6, 'Metropolitan University Campus', 7, 'active'),
  (42, 7, 'Humayun Chottor', 1, 'active'),
  (43, 7, 'Naiorpul', 2, 'active'),
  (44, 7, 'Shibganj', 3, 'active'),
  (45, 7, 'Tilagarh', 4, 'active'),
  (46, 7, 'Metropolitan University Campus', 5, 'active'),
  (47, 8, 'Sreerampur Bypass', 1, 'active'),
  (48, 8, 'Surma Gate Bypass', 2, 'active'),
  (49, 8, 'Metropolitan University Campus', 3, 'active'),
  (50, 9, 'Metropolitan University Campus', 1, 'active'),
  (51, 9, 'Tilagarh', 2, 'active'),
  (52, 9, 'Shahi Eidgah', 3, 'active'),
  (53, 9, 'Kumarpara', 4, 'active'),
  (54, 9, 'Rikabibazar', 5, 'active'),
  (55, 10, 'Metropolitan University Campus', 1, 'active'),
  (56, 10, 'Shahi Eidgah', 2, 'active'),
  (57, 11, 'Metropolitan University Campus', 1, 'active'),
  (58, 11, 'Tilagarh', 2, 'active'),
  (59, 12, 'Metropolitan University Campus', 1, 'active'),
  (60, 12, 'Darbasta', 2, 'active');

-- Buses (route_id is filled in below, after drivers are assigned -
-- matches db.js, where a bus only gets a route once a driver using
-- it is seeded; Univ-1 has no seed driver, so it keeps route_id NULL here, same as the original)
INSERT INTO buses (id, bus_number, bus_name, capacity, status) VALUES
  (1, '11-0018', 'Bus 11-0018', 40, 'active'),
  (2, '11-0900', 'Bus 11-0900', 40, 'active'),
  (3, '11-0944', 'Bus 11-0944 (Trial)', 40, 'active'),
  (4, '11-0967', 'Bus 11-0967', 40, 'active'),
  (5, '11-0010', 'Bus 11-0010', 40, 'active'),
  (6, 'New-1', 'New-1', 32, 'active'),
  (7, 'New-2', 'New-2', 32, 'active'),
  (8, 'Univ-1', 'University Bus 1', 40, 'active');

-- Drivers (all use password: driver123)
INSERT INTO drivers (id, full_name, email, phone, password, bus_id, status, created_by_admin) VALUES
  (1, 'Sojib', 'sojib.driver@mu.edu.bd', '01710000001', 'ffa54e1cd63025f5355e12c14f2c0b85:924a9d846f24ba970f209a55ce719d1582b52406f6ad2c0386f041e4b8d9502ba4bb6e83d4298f0ee99e8a6eb159559719f84476a7dfa4eb514e332186fc335e', 1, 'active', 1),
  (2, 'Mintu', 'mintu.driver@mu.edu.bd', '01710000002', 'e4d5032535bf9445ad6a2ce92f60cb64:15b22cba801179cbd66923100f91a79d76becd4eb23fa4f11aea594192783c7810d06b2349a48d125dcad90124f526c9ca750bda02c3da8c43e06406dac2bed6', 2, 'active', 1),
  (3, 'Shahadat', 'shahadat.driver@mu.edu.bd', '01710000003', 'cfb62b4ee8a9f0d412faae1f82621264:4faba20a97ae4f5b14a47a65cb654b84fc5ad38d8879b4c35c081d1767a245f43e49473c8b7606a4a56359c44d482a62380f19025d6aa9429ceb91aebfeec0c2', 3, 'active', 1),
  (4, 'Forid', 'forid.driver@mu.edu.bd', '01710000004', 'df92275d9076e7a6a2f3659e9f2db0ba:26d99e63669fa0b50e0f1282bd9ef1809a7521bb0fb232e0437a866dde088cb85c1632e9a300721dda7958a1851de90b009472e3aae279d021cf399fb68ddd73', 7, 'active', 1),
  (5, 'Abed', 'abed.driver@mu.edu.bd', '01710000005', '44db58a4329cab1001560c25adced68f:b17b4d02e14cf6cb298733fc4d0d947bb0401e18659fe5747b070f8e4e608678fbcb1286e6964d0c36d6217eac1112ac2e4e69c8684cad770fe38af7907968aa', 4, 'active', 1),
  (6, 'Monir', 'monir.driver@mu.edu.bd', '01710000006', 'b4bbe79c7af0a7e429bf04b3c99a53f9:a183b4cc741e20a633c5a7e859554e0b8465372820582b966d6e4f93c4340bb2e7cd41515472fdb09d9a666a3c00c82bc82a342ea4695e33d1aaff8e1398e90c', 6, 'active', 1),
  (7, 'Mohsin', 'mohsin.driver@mu.edu.bd', '01710000007', '8cd6a2777d5e2593627cb383123c5345:150927832c41b0813a29579a7ef4366636d12e38c169cf3810aa896f1206cabd9812f4806ea6f8b54aab79b8fdc1e9b69050a001dd1a5f2bc0e4755ad6af091f', 5, 'active', 1);

-- Assign each driver (and their bus) the route matching their first
-- scheduled run - mirrors the seeding logic in db.js exactly.
UPDATE buses SET route_id = 1 WHERE id = 1;
UPDATE buses SET route_id = 2 WHERE id = 2;
UPDATE buses SET route_id = 2 WHERE id = 3;
UPDATE buses SET route_id = 3 WHERE id = 7;
UPDATE buses SET route_id = 5 WHERE id = 4;
UPDATE buses SET route_id = 4 WHERE id = 6;
UPDATE buses SET route_id = 7 WHERE id = 5;
UPDATE drivers SET route_id = 1 WHERE id = 1;
UPDATE drivers SET route_id = 2 WHERE id = 2;
UPDATE drivers SET route_id = 2 WHERE id = 3;
UPDATE drivers SET route_id = 3 WHERE id = 4;
UPDATE drivers SET route_id = 5 WHERE id = 5;
UPDATE drivers SET route_id = 4 WHERE id = 6;
UPDATE drivers SET route_id = 7 WHERE id = 7;

-- Schedules - Regular period
INSERT INTO schedules (bus_id, route_id, departure_time, arrival_time, operating_days, period, effective_from, status, notes) VALUES
  (1, 1, NULL, '08:10', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Teacher transport - morning pickup'),
  (1, 1, '16:00', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Teacher transport - afternoon drop-off'),
  (2, 2, NULL, '09:24', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Staff transport'),
  (3, 2, '18:00', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Staff transport (trial bus)'),
  (2, 2, '17:10', '08:10', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Student transport'),
  (7, 3, '17:10', '08:10', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Student transport'),
  (7, 4, '18:05', '11:00', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Student transport - midday trip'),
  (6, 4, '15:10', '08:05', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Student transport'),
  (4, 5, '15:10', '08:10', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Student transport'),
  (8, 6, '15:10', '08:10', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Student transport (university-operated bus)'),
  (8, 6, '17:10', '08:10', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Student transport (university-operated bus)'),
  (8, 6, '17:05', '08:10', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Student transport (university-operated bus)'),
  (5, 7, '15:10', '11:05', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Student transport'),
  (3, 8, NULL, '08:30', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Trial / pilot service'),
  (1, 8, '18:05', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Trial / pilot service'),
  (7, 9, '12:15', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Midday shuttle service'),
  (7, 9, NULL, '12:50', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Midday shuttle service'),
  (6, 9, '12:50', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Midday shuttle service'),
  (6, 9, NULL, '13:10', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Midday shuttle service'),
  (3, 9, '13:10', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Midday shuttle service'),
  (3, 9, NULL, '13:40', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Midday shuttle service'),
  (2, 10, '13:30', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Midday shuttle service'),
  (2, 10, NULL, '14:00', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Midday shuttle service'),
  (4, 10, '13:30', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Midday shuttle service'),
  (4, 10, NULL, '14:00', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Midday shuttle service'),
  (1, 11, '12:05', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Shuttle service'),
  (1, 11, '13:10', '12:30', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Shuttle service'),
  (1, 11, NULL, '13:35', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Shuttle service'),
  (5, 11, '14:05', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Shuttle service'),
  (5, 11, NULL, '14:30', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Shuttle service'),
  (1, 11, '15:05', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Shuttle service'),
  (5, 11, '17:05', NULL, 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Shuttle service'),
  (5, 12, '18:05', '08:10', 'Sun-Thu', 'regular', '2026-07-27', 'active', 'Daily service');

-- Schedules - Examination period (illustrative examples)
INSERT INTO schedules (bus_id, route_id, departure_time, arrival_time, operating_days, period, effective_from, status, notes) VALUES
  (2, 2, '13:30', '07:00', 'Sun-Thu', 'examination', '2026-07-27', 'active', 'Example examination-period timing - update via Admin Panel with the confirmed schedule.'),
  (1, 1, '13:45', '07:15', 'Sun-Thu', 'examination', '2026-07-27', 'active', 'Example examination-period timing - update via Admin Panel with the confirmed schedule.');

-- Notices - one structured Delay report (Sojib / Bus 11-0018, Traffic
-- near Chowhatta, 15 minutes) and one plain informational notice
-- (Mintu / Bus 11-0900), both dated to the day this file is actually
-- run (CURDATE()) - not a fixed date - so the Student Dashboard shows
-- a live "Delayed" example immediately, whenever you import this file.
INSERT INTO notices (driver_id, notice_type, bus_id, route_id, notice_date, reason, stop_id, delay_minutes, message) VALUES
  (1, 'delayed', 1, 1, CURDATE(), 'Traffic', 4, 15, 'Delay reported: Traffic near Chowhatta (approx. 15 minutes).'),
  (2, 'general', 2, 2, CURDATE(), NULL, NULL, NULL, 'Bus 11-0900 is running on schedule today.');

-- Demo student accounts (password: student123)
INSERT INTO students (full_name, email, student_id, department, phone, password, status, reviewed_at) VALUES
  ('Demo Student', 'demo.student@mu.edu.bd', 'STU000001', 'Computer Science & Engineering', '01810000000', '3da086544bfc01855d87a7c274c43985:844fb881f0ca88fb59deb23f58eff633988c6aacc4b4fe53be0e63e10a50f1423b2ea801601f9f9c7ddf0298e5c78d36a41138b8c78bc6c5ca64388973a5cd72', 'approved', CURRENT_TIMESTAMP);
INSERT INTO students (full_name, email, student_id, department, phone, password, status) VALUES
  ('Pending Example', 'pending.example@mu.edu.bd', 'STU000002', 'Business Administration', '01810000001', '527ebb9fbc2d264b9859306074d2dae4:0b4a9ebb61c3a27c0909a5eb4cf6535581c128d8c802e24073993d664f27adb102356263f2ba6aefc7f86959d5aae8a7bdd261ef651e1aca543d99aeb1cfd758', 'pending');

SET FOREIGN_KEY_CHECKS = 1;
