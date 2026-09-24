/**
 * routes/auth.js — Authentication REST API
 * Author: Jagadeesh <chjagadeesh.gdvl@gmail.com>
 *
 * Endpoints:
 *   POST /api/auth/register
 *   POST /api/auth/verify-email
 *   POST /api/auth/resend-otp
 *   POST /api/auth/login
 *   POST /api/auth/logout
 *   POST /api/auth/refresh
 *   POST /api/auth/forgot-password
 *   POST /api/auth/reset-password
 *   GET  /api/auth/me
 *   PATCH /api/auth/me
 */

"use strict";

require("dotenv").config();
const bcrypt       = require("bcryptjs");
const jwt          = require("jsonwebtoken");
const crypto       = require("crypto");
const nodemailer   = require("nodemailer");
const db           = require("../db/database");
const { requireAuth, rateLimit } = require("../middleware/auth");

/* ── Config ──────────────────────────────────────────────────── */
const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || "tt-access-secret";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "tt-refresh-secret";
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES  || "15m";
const REFRESH_EXPIRES= process.env.JWT_REFRESH_EXPIRES || "7d";
const OTP_TTL_MIN    = parseInt(process.env.OTP_TTL_MINUTES || "5", 10);
const OTP_MAX_HOUR   = parseInt(process.env.OTP_MAX_PER_HOUR || "3", 10);
const LOGIN_MAX_ATT  = parseInt(process.env.LOGIN_MAX_ATTEMPTS || "5", 10);
const LOCKOUT_MS     = parseInt(process.env.LOGIN_LOCKOUT_MS || "900000", 10); // 15 min

/* ── Email transporter ───────────────────────────────────────── */
let transporter;

async function getTransporter() {
  if (transporter) return transporter;
  if (process.env.SMTP_USE_ETHEREAL !== "false") {
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    console.log(`[Mail] Ethereal Dev SMTP: ${testAccount.user}`);
  } else {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    console.log(`[Mail] Real SMTP Transporter initialized via ${process.env.SMTP_HOST || "smtp.gmail.com"}`);
  }
  return transporter;
}

async function sendOtpEmail(email, username, otp, purpose) {
  const mailer = await getTransporter();
  const subject = purpose === "verify_email"
    ? `${otp} is your Time Trotter verification code`
    : `${otp} is your Time Trotter password reset code`;

  const body = `Hi ${username},\n\nYour 6-digit verification code is: ${otp}\n\nThis code expires in ${OTP_TTL_MIN} minutes.\n\nIf you did not request this, please ignore this message.\n\n— Time Trotter`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0d1117; color: #c9d1d9; padding: 24px; border-radius: 8px; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #58a6ff; margin-top: 0;">Time Trotter Verification</h2>
      <p>Hi <strong>${username}</strong>,</p>
      <p>Your verification code for Time Trotter is:</p>
      <div style="background-color: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 14px; text-align: center; margin: 16px 0;">
        <span style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #58a6ff; font-family: monospace;">${otp}</span>
      </div>
      <p style="font-size: 13px; color: #8b949e;">Code expires in ${OTP_TTL_MIN} minutes. If you did not create an account, ignore this email.</p>
    </div>
  `;

  const info = await mailer.sendMail({
    from: `"Time Trotter" <${process.env.SMTP_USER}>`,
    replyTo: process.env.SMTP_USER,
    to: email,
    subject,
    text: body,
    html,
  });

  console.log(`[Mail] Verification OTP successfully sent to ${email} (MessageID: ${info.messageId})`);
}

/* ── OTP helpers ─────────────────────────────────────────────── */
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function issueOtp(userId, purpose) {
  // Enforce rate limit: max OTP_MAX_HOUR per hour
  const recentCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM otp_tokens
    WHERE user_id = ? AND purpose = ?
      AND created_at > datetime('now', '-1 hour')
  `).get(userId, purpose).cnt;

  if (recentCount >= OTP_MAX_HOUR) {
    throw Object.assign(new Error("Too many OTP requests. Try again in an hour."), { status: 429 });
  }

  // Invalidate previous OTPs for same purpose
  db.prepare("UPDATE otp_tokens SET used = 1 WHERE user_id = ? AND purpose = ? AND used = 0").run(userId, purpose);

  const token = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  db.prepare(`
    INSERT INTO otp_tokens (user_id, token, purpose, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, token, purpose, expiresAt);

  return token;
}

function consumeOtp(userId, token, purpose) {
  const row = db.prepare(`
    SELECT id FROM otp_tokens
    WHERE user_id = ? AND token = ? AND purpose = ?
      AND used = 0 AND expires_at > datetime('now')
  `).get(userId, token, purpose);

  if (!row) return false;
  db.prepare("UPDATE otp_tokens SET used = 1 WHERE id = ?").run(row.id);
  return true;
}

/* ── JWT helpers ─────────────────────────────────────────────── */
function issueTokens(user) {
  const jti        = crypto.randomUUID();
  const expiresAt  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

  const accessToken = jwt.sign(
    { sub: user.id, username: user.username, jti },
    ACCESS_SECRET,
    { expiresIn: ACCESS_EXPIRES }
  );
  const refreshToken = jwt.sign(
    { sub: user.id, jti },
    REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRES }
  );

  db.prepare(`
    INSERT INTO sessions (jti, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(jti, user.id, expiresAt);

  return { accessToken, refreshToken };
}

/* ── Request body parser ─────────────────────────────────────── */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; if (data.length > 10000) reject(new Error("Payload too large")); });
    req.on("end",  () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

/* ── JSON response helper ────────────────────────────────────── */
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control":  "no-store",
  });
  res.end(payload);
}

function refreshCookie(token) {
  const sevenDays = 7 * 24 * 60 * 60;
  return `refreshToken=${token}; HttpOnly; SameSite=Strict; Max-Age=${sevenDays}; Path=/api/auth/refresh`;
}

/* ── Validation helpers ──────────────────────────────────────── */
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d@$!%*?&_\-]{8,72}$/;

/* ═══════════════════════════════════════════════════════════════
   Route handler — called from server.js router
═══════════════════════════════════════════════════════════════ */

const authRateLimit   = rateLimit(
  parseInt(process.env.RATE_LIMIT_AUTH_MAX || "10", 10),
  parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MS || "60000", 10)
);

async function handleAuth(req, res, pathname) {
  // Apply rate limit to all auth routes
  await new Promise((resolve, reject) => {
    authRateLimit(req, res, (err) => err ? reject(err) : resolve());
  });

  const method = req.method.toUpperCase();

  /* ── POST /api/auth/register ─────────────────────────────── */
  if (method === "POST" && pathname === "/api/auth/register") {
    const { username, email, phone, password } = await parseBody(req);

    if (!USERNAME_RE.test(username || "")) return json(res, 400, { error: "Username must be 3–20 alphanumeric/underscore characters." });
    if (!EMAIL_RE.test(email || ""))        return json(res, 400, { error: "Invalid email address." });
    if (phone && !/^[0-9+\-\s()]{7,20}$/.test(phone)) return json(res, 400, { error: "Invalid phone number format." });
    if (!PASSWORD_RE.test(password || "")) return json(res, 400, { error: "Password must be 8–72 chars, include a letter and a number." });

    const existing = db.prepare("SELECT id FROM users WHERE email = ? OR username = ? OR (phone IS NOT NULL AND phone = ?)").get(email, username, phone || null);
    if (existing) return json(res, 409, { error: "Username, email, or phone number already in use." });

    const hash = await bcrypt.hash(password, 12);
    const info = db.prepare(`
      INSERT INTO users (username, email, phone, password_hash, is_verified) VALUES (?, ?, ?, ?, 1)
    `).run(username, email, phone || null, hash);

    db.prepare("INSERT INTO player_ratings (user_id) VALUES (?)").run(info.lastInsertRowid);

    const newUser = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
    const { accessToken, refreshToken } = issueTokens(newUser);

    res.setHeader("Set-Cookie", refreshCookie(refreshToken));
    return json(res, 201, {
      message: "Account created successfully!",
      accessToken,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        phone: newUser.phone,
        is_admin: Boolean(newUser.is_admin),
        elo: 1200
      }
    });
  }

  /* ── POST /api/auth/verify-email ─────────────────────────── */
  if (method === "POST" && pathname === "/api/auth/verify-email") {
    const { email, otp } = await parseBody(req);
    const user = db.prepare("SELECT id, username, is_verified FROM users WHERE email = ? OR phone = ?").get(email || "", email || "");
    if (!user) return json(res, 404, { error: "Account not found." });
    if (user.is_verified) return json(res, 400, { error: "Account already verified." });

    if (!consumeOtp(user.id, String(otp || ""), "verify_email"))
      return json(res, 400, { error: "Invalid or expired code." });

    db.prepare("UPDATE users SET is_verified = 1 WHERE id = ?").run(user.id);
    const { accessToken, refreshToken } = issueTokens(user);

    res.setHeader("Set-Cookie", refreshCookie(refreshToken));
    return json(res, 200, { message: "Account verified! You are now logged in.", accessToken });
  }

  /* ── POST /api/auth/resend-otp ────────────────────────────── */
  if (method === "POST" && pathname === "/api/auth/resend-otp") {
    const { email, purpose } = await parseBody(req);
    const allowed = ["verify_email", "reset_password"];
    if (!allowed.includes(purpose)) return json(res, 400, { error: "Invalid purpose." });

    const user = db.prepare("SELECT id, username, email, is_verified FROM users WHERE email = ? OR phone = ?").get(email || "", email || "");
    if (!user) return json(res, 200, { message: "If that account exists, a new code was sent." });

    try {
      const otp = issueOtp(user.id, purpose);
      await sendOtpEmail(user.email || email, user.username, otp, purpose);
    } catch (e) {
      if (e.status === 429) return json(res, 429, { error: e.message });
    }

    return json(res, 200, { message: "A new verification code has been sent to your email inbox." });
  }

  /* ── POST /api/auth/login ────────────────────────────────── */
  if (method === "POST" && pathname === "/api/auth/login") {
    const { identifier, password } = await parseBody(req);
    if (!identifier || !password) return json(res, 400, { error: "Email/username/phone and password required." });

    const user = db.prepare(
      "SELECT * FROM users WHERE email = ? OR username = ? OR (phone IS NOT NULL AND phone = ?)"
    ).get(identifier, identifier, identifier);

    if (!user) return json(res, 401, { error: "Invalid credentials." });

    // Check lockout
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const wait = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      return json(res, 423, { error: `Account locked. Try again in ${wait} minute(s).` });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = (user.login_attempts || 0) + 1;
      if (attempts >= LOGIN_MAX_ATT) {
        const lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString().replace("T", " ").slice(0, 19);
        db.prepare("UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?").run(attempts, lockedUntil, user.id);
        return json(res, 423, { error: `Too many failed attempts. Account locked for 15 minutes.` });
      }
      db.prepare("UPDATE users SET login_attempts = ? WHERE id = ?").run(attempts, user.id);
      return json(res, 401, { error: `Invalid credentials. ${LOGIN_MAX_ATT - attempts} attempt(s) remaining.` });
    }

    if (!user.is_verified) return json(res, 403, { error: "Please verify your email/phone before logging in." });
    if (user.is_banned)    return json(res, 403, { error: "Account suspended. Contact support." });

    // Reset login attempts, update last_login
    db.prepare("UPDATE users SET login_attempts = 0, locked_until = NULL, last_login = datetime('now') WHERE id = ?").run(user.id);

    const { accessToken, refreshToken } = issueTokens(user);
    res.setHeader("Set-Cookie", refreshCookie(refreshToken));

    const rating = db.prepare("SELECT elo, wins, losses, games_played FROM player_ratings WHERE user_id = ?").get(user.id);

    return json(res, 200, {
      message: "Login successful.",
      accessToken,
      user: {
        id:         user.id,
        username:   user.username,
        email:      user.email,
        phone:      user.phone,
        is_admin:   user.is_admin,
        avatar_url: user.avatar_url,
        elo:        rating?.elo || 1200,
      },
    });
  }

  /* ── POST /api/auth/logout ───────────────────────────────── */
  if (method === "POST" && pathname === "/api/auth/logout") {
    const header = req.headers["authorization"] || "";
    const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token) {
      try {
        const p = jwt.verify(token, ACCESS_SECRET);
        db.prepare("UPDATE sessions SET revoked = 1 WHERE jti = ?").run(p.jti);
      } catch { /* expired already */ }
    }
    res.setHeader("Set-Cookie", "refreshToken=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/api/auth/refresh");
    return json(res, 200, { message: "Logged out." });
  }

  /* ── POST /api/auth/refresh ──────────────────────────────── */
  if (method === "POST" && pathname === "/api/auth/refresh") {
    const cookieHeader = req.headers["cookie"] || "";
    const match = cookieHeader.match(/refreshToken=([^;]+)/);
    if (!match) return json(res, 401, { error: "No refresh token." });

    let payload;
    try { payload = jwt.verify(match[1], REFRESH_SECRET); }
    catch { return json(res, 401, { error: "Invalid refresh token." }); }

    // Revoke old session
    db.prepare("UPDATE sessions SET revoked = 1 WHERE jti = ?").run(payload.jti);

    const user = db.prepare("SELECT id, username, is_admin, is_banned FROM users WHERE id = ?").get(payload.sub);
    if (!user || user.is_banned) return json(res, 403, { error: "Account suspended." });

    const { accessToken, refreshToken } = issueTokens(user);
    res.setHeader("Set-Cookie", refreshCookie(refreshToken));
    return json(res, 200, { accessToken });
  }

  /* ── POST /api/auth/forgot-password ─────────────────────── */
  if (method === "POST" && pathname === "/api/auth/forgot-password") {
    const { email } = await parseBody(req);
    const user = db.prepare("SELECT id, username FROM users WHERE email = ?").get(email || "");
    // Always respond the same to prevent email enumeration
    if (user) {
      try {
        const otp = issueOtp(user.id, "reset_password");
        await sendOtpEmail(email, user.username, otp, "reset_password");
      } catch { /* rate limit — still send 200 */ }
    }
    return json(res, 200, { message: "If that email is registered, a reset code was sent." });
  }

  /* ── POST /api/auth/reset-password ──────────────────────── */
  if (method === "POST" && pathname === "/api/auth/reset-password") {
    const { email, otp, code, newPassword } = await parseBody(req);
    const token = String(otp || code || "").trim();
    if (!PASSWORD_RE.test(newPassword || "")) return json(res, 400, { error: "Password must be 8–72 chars, include a letter and a number." });

    const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email || "");
    if (!user) return json(res, 400, { error: "Invalid or expired code." });

    if (!consumeOtp(user.id, token, "reset_password"))
      return json(res, 400, { error: "Invalid or expired code." });

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare("UPDATE users SET password_hash = ?, login_attempts = 0, locked_until = NULL WHERE id = ?").run(hash, user.id);
    // Revoke all sessions
    db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(user.id);

    return json(res, 200, { message: "Password updated. Please log in with your new password." });
  }

  /* ── GET /api/auth/me ────────────────────────────────────── */
  if (method === "GET" && pathname === "/api/auth/me") {
    return new Promise(resolve => requireAuth(req, res, () => {
      const u = req.user;
      const rating = db.prepare(`
        SELECT elo, wins, losses, draws, games_played, triplets_claimed, perfect_turns,
               win_streak, best_streak
        FROM player_ratings WHERE user_id = ?
      `).get(u.id);
      resolve(json(res, 200, { ...u, ...rating }));
    }));
  }

  /* ── PATCH /api/auth/me ──────────────────────────────────── */
  if (method === "PATCH" && pathname === "/api/auth/me") {
    return new Promise(resolve => requireAuth(req, res, async () => {
      const { bio, avatar_url } = await parseBody(req);
      db.prepare("UPDATE users SET bio = COALESCE(?, bio), avatar_url = COALESCE(?, avatar_url) WHERE id = ?")
        .run(bio || null, avatar_url || null, req.user.id);
      resolve(json(res, 200, { message: "Profile updated." }));
    }));
  }

  return null; // no match
}

module.exports = { handleAuth };
