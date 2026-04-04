/**
 * routine.js — Daily Routine Engine for Pixel Synapse
 *
 * Drives each NPC through their schedule automatically.
 * Runs entirely on the server; pushes state changes to
 * clients via the existing broadcast() WebSocket channel.
 *
 * Time model
 * ──────────
 * One real second = one in-game minute  (configurable via GAME_SPEED).
 * A full 24-hour game day takes 24 minutes of real time at default speed.
 *
 * Per-NPC state machine
 * ─────────────────────
 *   idle    → doing their action at the current location, not moving
 *   walking → moving toward target coordinates
 *   talking → at location, engaged with other characters (special idle)
 *
 * Broadcast messages added by this module
 * ────────────────────────────────────────
 *   npc_state  { id, state, action, label, x, y, targetX, targetY }
 *   npc_move   { id, x, y }          (incremental steps while walking)
 *   game_time  { hour, minute, label }  (every in-game minute)
 */

const agents    = require('./agents.json');
const locations = require('./locations.json');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const GAME_SPEED      = 1;      // 1 real second = 1 in-game minute
const TICK_MS         = 1000;   // how often the engine ticks (ms)
const WALK_SPEED      = 40;     // pixels per in-game minute while walking
const ARRIVAL_RADIUS  = 16;     // pixels — how close = "arrived"
const WANDER_RANGE    = 24;     // pixels — idle position jitter radius

// ─────────────────────────────────────────────
// RUNTIME STATE
// One entry per NPC, mutated each tick
// ─────────────────────────────────────────────
const npcStates = {};

agents.forEach(agent => {
  const startLoc = locations[agent.schedule?.[0]?.location] || { x: agent.startX, y: agent.startY };
  npcStates[agent.id] = {
    id:          agent.id,
    name:        agent.name,
    x:           agent.startX,
    y:           agent.startY,
    targetX:     agent.startX,
    targetY:     agent.startY,
    state:       'idle',
    action:      'wake',
    label:       'Starting the day',
    scheduleIdx: 0,
    arrivedAt:   null,   // game-minute timestamp when we arrived
    lastWander:  0,
  };
});

// ─────────────────────────────────────────────
// IN-GAME CLOCK
// ─────────────────────────────────────────────
let gameMinute = 0;  // 0–1439  (0 = 00:00, 60 = 01:00, …)

function currentHour()   { return Math.floor(gameMinute / 60) % 24; }
function currentMinute() { return gameMinute % 60; }

function timeLabel() {
  const h = currentHour().toString().padStart(2, '0');
  const m = currentMinute().toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Return the schedule entry that is active right now for an agent.
 * "Active" = the latest entry whose (hour*60+minute) <= gameMinute,
 * wrapping around midnight.
 */
function getActiveEntry(agent) {
  const now = gameMinute % 1440;
  const entries = agent.schedule;
  if (!entries || entries.length === 0) return null;

  let best = entries[entries.length - 1]; // default: last entry (wraps overnight)
  for (const entry of entries) {
    const entryMinute = entry.hour * 60 + entry.minute;
    if (entryMinute <= now) {
      best = entry;
    }
  }
  return best;
}

// ─────────────────────────────────────────────
// LOCATION HELPERS
// ─────────────────────────────────────────────

/**
 * Pick a concrete pixel coordinate for a named location,
 * with a small random offset within the location's radius
 * so multiple NPCs don't stack exactly.
 */
function resolveLocation(locationName) {
  const loc = locations[locationName];
  if (!loc) return null;
  const r   = (loc.radius || 24) * 0.6;
  const ang = Math.random() * Math.PI * 2;
  return {
    x: Math.round(loc.x + Math.cos(ang) * r * Math.random()),
    y: Math.round(loc.y + Math.sin(ang) * r * Math.random()),
  };
}

function distanceTo(npc, tx, ty) {
  return Math.sqrt((npc.x - tx) ** 2 + (npc.y - ty) ** 2);
}

// ─────────────────────────────────────────────
// MAIN TICK
// Called every TICK_MS — advances clock, evaluates
// schedules, steps movement, emits broadcasts.
// ─────────────────────────────────────────────
function tick(broadcastFn) {
  gameMinute = (gameMinute + GAME_SPEED) % 1440;

  // Broadcast clock every in-game minute
  broadcastFn({
    type:   'game_time',
    hour:   currentHour(),
    minute: currentMinute(),
    label:  timeLabel(),
  });

  agents.forEach(agent => {
    const ns    = npcStates[agent.id];
    const entry = getActiveEntry(agent);
    if (!entry) return;

    const entryKey = `${entry.hour}:${entry.minute}:${entry.action}:${entry.location}`;

    // ── NEW SCHEDULE ENTRY? ──
    // Detect when we've crossed into a new entry
    if (ns._lastEntryKey !== entryKey) {
      ns._lastEntryKey = entryKey;
      ns.action        = entry.action;
      ns.label         = entry.label;

      // Resolve target location
      const resolved = resolveLocation(entry.location);
      if (resolved) {
        ns.targetX = resolved.x;
        ns.targetY = resolved.y;
      }

      // Set state
      const dist = distanceTo(ns, ns.targetX, ns.targetY);
      if (dist > ARRIVAL_RADIUS) {
        ns.state = 'walking';
      } else {
        ns.state = entry.state || 'idle';
      }

      // Broadcast full state change
      broadcastFn({
        type:    'npc_state',
        id:      agent.id,
        state:   ns.state,
        action:  ns.action,
        label:   ns.label,
        x:       ns.x,
        y:       ns.y,
        targetX: ns.targetX,
        targetY: ns.targetY,
      });

      console.log(`[routine] ${agent.name} → ${entry.action} @ ${entry.location} (${timeLabel()})`);
    }

    // ── MOVEMENT STEP ──
    if (ns.state === 'walking') {
      const dist = distanceTo(ns, ns.targetX, ns.targetY);

      if (dist <= ARRIVAL_RADIUS) {
        // Arrived!
        ns.x     = ns.targetX;
        ns.y     = ns.targetY;
        ns.state = entry.state || 'idle';
        broadcastFn({ type: 'npc_state', id: agent.id, state: ns.state, action: ns.action, label: ns.label, x: ns.x, y: ns.y });
        broadcastFn({ type: 'npc_move',  id: agent.id, x: ns.x, y: ns.y });
      } else {
        // Step toward target
        const step = Math.min(WALK_SPEED * GAME_SPEED, dist);
        const nx   = ns.x + ((ns.targetX - ns.x) / dist) * step;
        const ny   = ns.y + ((ns.targetY - ns.y) / dist) * step;
        ns.x       = Math.round(nx);
        ns.y       = Math.round(ny);
        broadcastFn({ type: 'npc_move', id: agent.id, x: ns.x, y: ns.y });
      }
    }

    // ── IDLE WANDER ──
    // Tiny random drift while idle so NPCs feel alive
    if (ns.state === 'idle' && gameMinute - ns.lastWander > 3) {
      ns.lastWander = gameMinute;
      const loc = locations[entry.location];
      if (loc) {
        const r   = WANDER_RANGE;
        const ang = Math.random() * Math.PI * 2;
        const wx  = Math.round(loc.x + Math.cos(ang) * r * Math.random());
        const wy  = Math.round(loc.y + Math.sin(ang) * r * Math.random());
        ns.x      = wx;
        ns.y      = wy;
        broadcastFn({ type: 'npc_move', id: agent.id, x: ns.x, y: ns.y });
      }
    }
  });
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

/**
 * Start the routine engine.
 * @param {Function} broadcastFn  function(data) — sends to all clients
 * @param {number}   [startHour]  0–23, in-game hour to begin at (default 8)
 */
function start(broadcastFn, startHour = 8) {
  gameMinute = startHour * 60;
  console.log(`[routine] Engine started at ${timeLabel()}`);
  setInterval(() => tick(broadcastFn), TICK_MS);
}

/**
 * Get current in-game time as { hour, minute, label }.
 */
function getTime() {
  return { hour: currentHour(), minute: currentMinute(), label: timeLabel() };
}

/**
 * Get the current runtime state of all NPCs.
 * Returns array suitable for sending in the 'init' message.
 */
function getAllStates() {
  return Object.values(npcStates).map(ns => ({
    id:      ns.id,
    x:       ns.x,
    y:       ns.y,
    state:   ns.state,
    action:  ns.action,
    label:   ns.label,
    targetX: ns.targetX,
    targetY: ns.targetY,
  }));
}

/**
 * Temporarily override an NPC's position (e.g. after walk_to_player).
 * The routine will resume normally on the next schedule entry.
 */
function setNpcPosition(npcId, x, y) {
  if (npcStates[npcId]) {
    npcStates[npcId].x = Math.round(x);
    npcStates[npcId].y = Math.round(y);
  }
}

module.exports = { start, getTime, getAllStates, setNpcPosition, npcStates };
