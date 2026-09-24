"use strict";

const { handleAuth }        = require("../routes/auth.js");
const { handleLeaderboard } = require("../routes/leaderboard.js");
const { handleAdmin }       = require("../routes/admin.js");
const db                    = require("../db/database.js");

module.exports = async function handler(req, res) {
  // CORS Preflight & Headers for minimum latency & cross-origin support
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  /* ── Auth API ── */
  if (pathname.startsWith("/api/auth/")) {
    try {
      await handleAuth(req, res, pathname);
    } catch (e) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal auth server error." }));
      }
    }
    return;
  }

  /* ── Leaderboard API ── */
  if (pathname.startsWith("/api/leaderboard")) {
    try {
      const result = handleLeaderboard(req, res, pathname);
      if (result instanceof Promise) await result;
    } catch (e) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Leaderboard error." }));
      }
    }
    return;
  }

  /* ── Admin API ── */
  if (pathname.startsWith("/api/admin/")) {
    try {
      const result = handleAdmin(req, res, pathname);
      if (result instanceof Promise) await result;
    } catch (e) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Admin error." }));
      }
    }
    return;
  }

  /* ── Rooms API ── */
  if (pathname === "/api/rooms") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-cache");
    return res.end(JSON.stringify([]));
  }

  /* ── Stats API ── */
  if (pathname === "/api/stats") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=10");
    return res.end(JSON.stringify({
      rooms: 0,
      activeGames: 0,
      connectedWS: 0,
      uptime: Math.round(process.uptime()),
      status: "online",
      env: "vercel-edge"
    }));
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "Endpoint not found" }));
};
