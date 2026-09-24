/**
 * db/database.js — SQLite singleton
 * Author: Jagadeesh <chjagadeesh.gdvl@gmail.com>
 *
 * Opens (or creates) the SQLite database, runs the schema migrations,
 * and seeds an admin account if the users table is empty.
 */

"use strict";

require("dotenv").config();
let Database;
try {
  Database = require("better-sqlite3");
} catch (e) {
  Database = null;
}

const DB_PATH = process.env.VERCEL
  ? path.join("/tmp", "timetrotter.db")
  : (process.env.DB_PATH || "./data/timetrotter.db");

let db;
if (Database) {
  try {
    const dataDir = path.dirname(path.resolve(DB_PATH));
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(DB_PATH);
    try { db.pragma("journal_mode = WAL"); } catch {}
  } catch (err) {
    try { db = new Database(":memory:"); } catch {}
  }
}

if (!db) {
  // Mock DB interface for serverless static environments
  db = {
    pragma() {},
    exec() {},
    prepare() {
      return {
        run: () => ({ lastInsertRowid: 1, changes: 1 }),
        get: () => null,
        all: () => []
      };
    }
  };
}

// Performance pragmas
try { db.pragma("foreign_keys = ON"); } catch {}
try { db.pragma("synchronous = NORMAL"); } catch {}

// Run schema table creation
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
// Execute schema statements up to index creation
db.exec(schema);

// Migration: Ensure phone column exists & verify all accounts
try { db.exec("ALTER TABLE users ADD COLUMN phone TEXT;"); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone);"); } catch {}
try { db.exec("UPDATE users SET is_verified = 1 WHERE is_verified = 0;"); } catch {}

// Seed admin account on first run
const adminExists = db.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get();
if (!adminExists) {
  const {
    ADMIN_USERNAME = "admin",
    ADMIN_EMAIL    = "admin@timetrotter.local",
    ADMIN_PASSWORD = "Admin@12345",
  } = process.env;

  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  db.prepare(`
    INSERT INTO users (username, email, password_hash, is_verified, is_admin)
    VALUES (?, ?, ?, 1, 1)
  `).run(ADMIN_USERNAME, ADMIN_EMAIL, hash);

  db.prepare(`
    INSERT INTO player_ratings (user_id)
    SELECT id FROM users WHERE username = ?
  `).run(ADMIN_USERNAME);

  console.log(`[DB] Admin account created: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
}

// Cleanup expired OTPs and revoked sessions on startup (housekeeping)
db.prepare("DELETE FROM otp_tokens WHERE expires_at < datetime('now')").run();
db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now') OR revoked = 1").run();

console.log(`[DB] SQLite database ready at ${DB_PATH}`);

module.exports = db;
