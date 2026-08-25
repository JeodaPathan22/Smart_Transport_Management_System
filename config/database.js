/**
 * MySQL connection configuration.
 *
 * Reads from environment variables (see .env in the project root) with
 * defaults that match a stock XAMPP install: MySQL on localhost:3306,
 * user "root", no password. If your XAMPP MySQL uses different
 * credentials, edit .env - no code changes are needed.
 *
 * This app was migrated from SQLite to MySQL. This file is the only
 * place database connection details are configured.
 */

require('dotenv').config();

module.exports = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'smart_transport_management',
};
