/**
 * routines.js — Daily Routine Engine for Pixel Synapse
 *
 * Manages a compressed game clock (1 real minute = 1 game hour by default),
 * looks up each agent's current schedule entry, drives movement toward target
 * locations, and exposes state for broadcasting to clients.
 *
 * Usage in server.js:
 *   const routines = require('./routines');
 *   routines.init(npcs, broadcast);
 */

const agents = require('./agents.json');

// ─────────────────────────────────────────────
// NAMED LOCATIONS → world pixel coordinates
// These match the tile layout in main.js createTextures()
// ─────────────────────────────────────────────
const LOCATIONS = {
  home:        { x: 400, y: 700 },  // default home (south area)
  cafe:        { x: 120, y: 580 },  // Mira's café (SW building)
  town_square: { x: 400, y: 400 },  // cobblestone square center
  fountain:    { x: 400, y: 370 },  // fountain in square
  park:        { x: 130, y: 130 },  // NW park area
  workshop:    { x: 580, y: 80  },  // NE building (Orion's workshop)
  east_wall:   { x: 750, y: 400 },  // east boundary wall
  west_gate:   { x: 50,  y: 400 },  // west gate (Bram's post)
  market:      { x: 300, y: 580 },  // market area (SW quadrant)
};

// Add small per-NPC offsets so NPCs don't all stack at the same spot
const LOCATION_OFFSETS = {
  lena:  { x:  20, y: -10 },
  orion: { x: -15, y:  15 },
  mira:  { x:   0, y:   0 },
  kai:   { x:  30, y:  20 },
  zara:  { x: -20, y:  10 },
  bram:  { x:   0, y: -20 },
  ivy:   { x:  25, y:  25 },
  juno:  { x: -25, y: -15 },
  sol:   { x:  10, y:  10 },
  pix:   { x: -10, y: -25 },
};

// ─────────────────────────────────────────────
// GAME CLOCK
// Real time is compressed: MINUTES_PER_GAME_HOUR real minutes = 1 game hour.
// Default: 1 real minute = 1 game hour → full day = 24 real minutes.
// Set MINUTES_PER_GAME_HOUR=60 for real-time.
// ─────────────────────────────────────────────
const MINUTES_PER_GAME_HOUR = 1; // 1 real min = 1 game hour

let _gameHour   = 8;    // start at 8am
let _gameMinute = 0;
let _lastTick   = Date.now();

function tickClock() {
  const now     = Date.now();
  const elapsed = (now - _lastTick) / 1000; // seconds since last tick
  _lastTick     = now;

  // Advance game minutes
  const gameSecondsPerRealSecond = 60 / (MINUTES_PER_GAME_HOUR * 60);
  const gameMinutesAdvanced = elapsed * gameSecondsPerRealSecond * 60;

  _gameMinute += gameMinutesAdvanced;
  while (_gameMinute >= 60) {
    _gameMinute -= 60;
    _gameHour   = (_gameHour + 1) % 24;
  }
}

function getGameTime() {
  return {
    hour:   _gameHour,
    minute: Math.floor(_gameMinute),
    label:  `${String(_gameHour).padStart(2,'0')}:${String(Math.floor(_gameMinute)).padStart(2,'0')}`,
  };
}

// ─────────────────────────────────────────────
// SCHEDULE LOOKUP
// Find the active schedule entry for an agent at the current game time.
// Returns the last entry whose time is ≤ current time (wraps midnight).
// ─────────────────────────────────────────────
function getActiveEntry(agentId, hour, minute) {
  const agent = agents.find(a => a.id === agentId);
  if (!agent || !agent.schedule || agent.schedule.length === 0) return null;

  const nowMinutes = hour * 60 + minute;

  // Find the last entry whose start time is ≤ now
  let best = null;
  let bestStart = -1;

  for (const entry of agent.schedule) {
    const entryStart = entry.hour * 60 + entry.minute;
    if (entryStart <= nowMinutes && entryStart > bestStart) {
      best      = entry;
      bestStart = entryStart;
    }
  }

  // If nothing matched (we're before the first entry), wrap to the last entry of yesterday
  if (!best) {
    for (const entry of agent.schedule) {
      const entryStart = entry.hour * 60 + entry.minute;
      if (entryStart > bestStart) {
        best      = entry;
        bestStart = entryStart;
      }
    }
  }

  return best;
}

// ─────────────────────────────────────────────
// MOVEMENT TOWARD TARGET
// Returns the new x/y after stepping toward (tx, ty) at given speed.
// Speed is in pixels-per-second; tick is seconds elapsed.
// ─────────────────────────────────────────────
const NPC_SPEED     = 40;   // px/sec
const ARRIVAL_DIST  = 12;   // px — snap to destination within this
const WORLD_MIN     = 32;
const WORLD_MAX_X   = 768;
const WORLD_MAX_Y   = 768;

function stepToward(x, y, tx, ty, speed, dt) {
  const dx   = tx - x;
  const dy   = ty - y;
  const dist = Math.sqrt(dx*dx + dy*dy);
  if (dist < ARRIVAL_DIST) return { x: tx, y: ty, arrived: true };

  const step = speed * dt;
  const ratio = Math.min(step / dist, 1);
  return {
    x:       Math.round(x + dx * ratio),
    y:       Math.round(y + dy * ratio),
    arrived: false,
  };
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ─────────────────────────────────────────────
// NPC STATE MACHINE
// Each NPC has:
//   state:     'idle' | 'walking' | 'talking'
//   targetX/Y: destination pixel coords
//   entry:     current schedule entry
//   label:     what they're doing right now
// ─────────────────────────────────────────────
const npcStates = {}; // npcId → { state, targetX, targetY, entry, label, arrivedAt }

function initNpcState(npc) {
  const { hour, minute } = getGameTime();
  const entry    = getActiveEntry(npc.id, hour, minute);
  const offset   = LOCATION_OFFSETS[npc.id] || { x:0, y:0 };
  const locBase  = entry ? (LOCATIONS[entry.location] || { x: npc.x, y: npc.y }) : { x: npc.x, y: npc.y };

  npcStates[npc.id] = {
    state:     entry ? entry.state : 'idle',
    targetX:   locBase.x + offset.x,
    targetY:   locBase.y + offset.y,
    entry,
    label:     entry ? entry.label : 'Wandering',
    arrivedAt: null,
  };
}

// ─────────────────────────────────────────────
// MAIN UPDATE LOOP
// Called on an interval from server.js.
// Ticks the clock, resolves schedule entries, moves NPCs.
// Returns an array of { id, x, y, state, label } for broadcasting.
// ─────────────────────────────────────────────
let _lastUpdate = Date.now();

function update(npcs) {
  const now = Date.now();
  const dt  = (now - _lastUpdate) / 1000; // seconds
  _lastUpdate = now;

  tickClock();
  const { hour, minute } = getGameTime();

  const updates = [];

  for (const npc of npcs) {
    if (!npcStates[npc.id]) initNpcState(npc);

    const ns    = npcStates[npc.id];
    const entry = getActiveEntry(npc.id, hour, minute);

    // ── SCHEDULE CHANGE DETECTION ──
    if (entry && (!ns.entry || entry.action !== ns.entry.action || entry.location !== ns.entry.location)) {
      const offset  = LOCATION_OFFSETS[npc.id] || { x:0, y:0 };
      const locBase = LOCATIONS[entry.location] || { x: npc.x, y: npc.y };
      ns.targetX  = clamp(locBase.x + offset.x, WORLD_MIN, WORLD_MAX_X);
      ns.targetY  = clamp(locBase.y + offset.y, WORLD_MIN, WORLD_MAX_Y);
      ns.state    = entry.state;
      ns.entry    = entry;
      ns.label    = entry.label;
      ns.arrivedAt = null;
    }

    // ── MOVEMENT ──
    const moved = stepToward(npc.x, npc.y, ns.targetX, ns.targetY, NPC_SPEED, dt);
    npc.x = moved.x;
    npc.y = moved.y;

    if (moved.arrived && ns.arrivedAt === null) {
      ns.arrivedAt = now;
      // Switch to the entry's resting state on arrival
      if (ns.entry) ns.state = ns.entry.state;
    }

    // ── IDLE MICRO-WANDER ──
    // NPCs that have been idle at their target for >10s drift slightly
    if (ns.arrivedAt !== null && ns.state === 'idle' && (now - ns.arrivedAt) > 10000) {
      const jitter = 20;
      const locBase = ns.entry ? (LOCATIONS[ns.entry.location] || { x: ns.targetX, y: ns.targetY }) : { x: ns.targetX, y: ns.targetY };
      const offset  = LOCATION_OFFSETS[npc.id] || { x:0, y:0 };
      ns.targetX = clamp(locBase.x + offset.x + (Math.random()-0.5)*jitter*2, WORLD_MIN, WORLD_MAX_X);
      ns.targetY = clamp(locBase.y + offset.y + (Math.random()-0.5)*jitter*2, WORLD_MIN, WORLD_MAX_Y);
      ns.arrivedAt = now; // reset so we don't jitter every frame
    }

    updates.push({
      id:    npc.id,
      x:     npc.x,
      y:     npc.y,
      state: ns.state,
      label: ns.label,
    });
  }

  return updates;
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

/**
 * Start the routine tick loop.
 * @param {Array}    npcs      - live NPC array from server.js (mutated in-place)
 * @param {Function} broadcast - broadcast(data) from server.js
 * @param {number}   tickMs    - how often to tick (default 500ms)
 */
function init(npcs, broadcast, tickMs = 500) {
  // Initialise states immediately
  for (const npc of npcs) initNpcState(npc);

  setInterval(() => {
    const updates = update(npcs);

    // Broadcast all NPC positions + states + game clock
    broadcast({
      type:  'routine_tick',
      time:  getGameTime(),
      npcs:  updates,
    });
  }, tickMs);

  console.log('🕐 Routine engine started — game time:', getGameTime().label);
}

/** Get the current game clock (useful for prompt injection) */
function getCurrentTime() { return getGameTime(); }

/** Get the current schedule entry for a specific NPC */
function getNpcEntry(npcId) {
  const { hour, minute } = getGameTime();
  return getActiveEntry(npcId, hour, minute);
}

/** Get the current state object for a specific NPC */
function getNpcState(npcId) { return npcStates[npcId] || null; }

module.exports = { init, getCurrentTime, getNpcEntry, getNpcState };
