/**
 * events.js — Dynamic Event System for Pixel Synapse
 *
 * Events are scheduled by in-game time and trigger NPC movement,
 * relationship changes, faction rep shifts, and gossip seeding.
 *
 * Event types: concert, protest, drama, market_day, patrol_alert
 *
 * The event scheduler runs inside the server's routine tick.
 * Events broadcast to all clients via the existing broadcast() channel.
 */

const { updateRelationship, adjustAllRelationships } = require('./relationships');
const { updateFactionReputation, FACTION_DEFS }      = require('./factions');
const { createGossip }                               = require('./gossip');
const agents = require('./agents.json');

// ─────────────────────────────────────────────
// EVENT TYPE DEFINITIONS
// ─────────────────────────────────────────────
const EVENT_TYPES = {
  concert: {
    label:       'Street Concert',
    description: 'Zara performs in the plaza. Draws a crowd.',
    duration:    60,        // in-game minutes
    location:    'town_square',
    primaryNpcs: ['zara'],
    supportNpcs: ['mira', 'sol', 'lena'],
    outcomes: {
      // Applied to all participants at event end
      relationships: { attended_event: true },
      factions:      { naturalists: +8, cafe: +5 },
      gossipTemplate: (npcId, playerName) =>
        `${playerName} showed up to Zara's concert and actually seemed moved by it`,
    },
  },
  protest: {
    label:       'Town Protest',
    description: 'Bram organizes a demonstration near the east wall.',
    duration:    45,
    location:    'east_wall',
    primaryNpcs: ['bram'],
    supportNpcs: ['juno', 'kai'],
    outcomes: {
      relationships: { attended_event: true },
      factions:      { guards: +10, hackers: -5 },
      gossipTemplate: (npcId, playerName) =>
        `${playerName} was spotted at Bram's protest — either very civic-minded or very suspicious`,
    },
  },
  drama: {
    label:       'Public Drama',
    description: 'A heated argument breaks out near the fountain.',
    duration:    20,
    location:    'fountain',
    primaryNpcs: ['lena', 'kai'],
    supportNpcs: ['mira', 'bram'],
    outcomes: {
      relationships: { caused_scene: true },
      factions:      { cafe: -5, hackers: +5, guards: -5 },
      gossipTemplate: (npcId, playerName) =>
        `${playerName} was caught up in that fountain argument — looked guilty to me`,
    },
  },
  market_day: {
    label:       'Market Day',
    description: 'The market fills with vendors and chatter.',
    duration:    120,
    location:    'market',
    primaryNpcs: ['mira', 'ivy'],
    supportNpcs: ['lena', 'orion', 'sol'],
    outcomes: {
      relationships: { greeted: true },
      factions:      { cafe: +5, naturalists: +5 },
      gossipTemplate: (npcId, playerName) =>
        `${playerName} wandered through the market today, bought nothing, asked about everything`,
    },
  },
  patrol_alert: {
    label:       'Security Alert',
    description: 'Bram has spotted something suspicious. Guards on high alert.',
    duration:    30,
    location:    'town_square',
    primaryNpcs: ['bram', 'juno'],
    supportNpcs: ['kai'],
    outcomes: {
      relationships: { caused_scene: true },
      factions:      { guards: +8, hackers: -8 },
      gossipTemplate: (npcId, playerName) =>
        `${playerName} was near the square during the security alert — Bram has questions`,
    },
  },
};

// ─────────────────────────────────────────────
// DAILY SCHEDULE
// Each entry: { hour, minute, type }
// ─────────────────────────────────────────────
const DAILY_SCHEDULE = [
  { hour: 8,  minute: 0,  type: 'market_day'   },
  { hour: 11, minute: 30, type: 'concert'       },
  { hour: 14, minute: 0,  type: 'drama'         },
  { hour: 16, minute: 0,  type: 'protest'       },
  { hour: 19, minute: 0,  type: 'concert'       },
  { hour: 22, minute: 0,  type: 'patrol_alert'  },
];

// ─────────────────────────────────────────────
// ACTIVE EVENT STATE
// ─────────────────────────────────────────────
let _activeEvent = null;
let _triggeredKeys = new Set(); // prevent re-firing same event in same day

/**
 * Active event shape:
 * {
 *   type, label, description, location,
 *   startMinute, endMinute,
 *   participants: [playerId, ...],    // players nearby at event start
 *   npcParticipants: [npcId, ...],
 *   resolved: boolean
 * }
 */

function getActiveEvent() { return _activeEvent; }

function isEventActive() { return _activeEvent !== null && !_activeEvent.resolved; }

// ─────────────────────────────────────────────
// SCHEDULER TICK
// Called from server's routine engine every in-game minute.
// Returns an event broadcast payload if something started/ended, else null.
// ─────────────────────────────────────────────

/**
 * @param {number} gameMinute  0–1439
 * @param {object} players     current player positions { socketId: { x, y, name } }
 * @param {object} locations   location coord map
 * @param {Function} broadcastFn
 */
function tick(gameMinute, players, locations, broadcastFn) {
  const hour   = Math.floor(gameMinute / 60) % 24;
  const minute = gameMinute % 60;

  // Reset daily trigger keys at midnight
  if (gameMinute === 0) _triggeredKeys.clear();

  // ── CHECK FOR EVENT START ──
  for (const entry of DAILY_SCHEDULE) {
    const key = `${entry.hour}:${entry.minute}:${entry.type}`;
    if (entry.hour === hour && entry.minute === minute && !_triggeredKeys.has(key)) {
      _triggeredKeys.add(key);
      startEvent(entry.type, gameMinute, players, locations, broadcastFn);
      break;
    }
  }

  // ── CHECK FOR EVENT END ──
  if (_activeEvent && !_activeEvent.resolved && gameMinute >= _activeEvent.endMinute) {
    resolveEvent(_activeEvent, players, broadcastFn);
  }
}

// ─────────────────────────────────────────────
// START EVENT
// ─────────────────────────────────────────────
function startEvent(type, gameMinute, players, locations, broadcastFn) {
  const def = EVENT_TYPES[type];
  if (!def) return;

  const loc = locations[def.location] || { x: 400, y: 400 };

  // Find nearby players (within 200px of event location) — they're participants
  const nearby = Object.entries(players)
    .filter(([, p]) => {
      const dx = p.x - loc.x, dy = p.y - loc.y;
      return Math.sqrt(dx*dx + dy*dy) < 200;
    })
    .map(([id]) => id);

  _activeEvent = {
    type,
    label:          def.label,
    description:    def.description,
    location:       def.location,
    locationCoords: loc,
    startMinute:    gameMinute,
    endMinute:      gameMinute + def.duration,
    participants:   nearby,
    npcParticipants: [...def.primaryNpcs, ...def.supportNpcs],
    resolved:       false,
  };

  console.log(`[event] ${def.label} started at ${def.location}`);

  // Move primary NPCs to event location
  broadcastFn({
    type:        'event_start',
    event:       _activeEvent,
    npcTargets:  _activeEvent.npcParticipants.map(id => ({ id, x: loc.x, y: loc.y })),
  });
}

// ─────────────────────────────────────────────
// RESOLVE EVENT
// Apply all outcomes to participants
// ─────────────────────────────────────────────
function resolveEvent(event, players, broadcastFn) {
  event.resolved = true;
  const def = EVENT_TYPES[event.type];
  if (!def) return;

  const outcomes = def.outcomes;

  // Apply relationship changes to participants
  for (const playerId of event.participants) {
    const playerName = players[playerId]?.name || 'Someone';

    // Relationship update for each NPC at the event
    if (outcomes.relationships) {
      const action = Object.keys(outcomes.relationships)[0];
      for (const npcId of event.npcParticipants) {
        updateRelationship(npcId, playerId, action);
      }
    }

    // Faction rep changes
    if (outcomes.factions) {
      for (const [fid, amount] of Object.entries(outcomes.factions)) {
        updateFactionReputation(fid, playerId, amount);
      }
    }

    // Seed gossip from the event
    if (outcomes.gossipTemplate) {
      const originNpc = event.npcParticipants[0];
      if (originNpc) {
        const claim = outcomes.gossipTemplate(originNpc, playerName);
        createGossip(originNpc, playerId, playerName, claim);
      }
    }
  }

  console.log(`[event] ${event.label} resolved. Participants: ${event.participants.length}`);

  broadcastFn({
    type:         'event_end',
    event:        { type: event.type, label: event.label, location: event.location },
    participants: event.participants,
  });

  _activeEvent = null;
}

// ─────────────────────────────────────────────
// ADD PLAYER TO ACTIVE EVENT
// Called when a player walks into an active event zone
// ─────────────────────────────────────────────
function joinEvent(playerId) {
  if (!_activeEvent || _activeEvent.resolved) return false;
  if (!_activeEvent.participants.includes(playerId)) {
    _activeEvent.participants.push(playerId);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────
// PROMPT CONTEXT
// ─────────────────────────────────────────────
/**
 * Returns event context for the NPC prompt if an event is happening.
 */
function getEventContext() {
  if (!_activeEvent || _activeEvent.resolved) return '';
  const def = EVENT_TYPES[_activeEvent.type];
  return [
    `## CURRENT TOWN EVENT`,
    `${_activeEvent.label}: ${_activeEvent.description}`,
    `Location: ${_activeEvent.location}. ${_activeEvent.npcParticipants.length} NPCs are gathered.`,
    `If you are one of the event NPCs, you are actively participating. Reference it naturally.`,
    `If not, you may have heard about it or be curious.`,
  ].join('\n');
}

module.exports = {
  EVENT_TYPES,
  DAILY_SCHEDULE,
  tick,
  startEvent,
  resolveEvent,
  joinEvent,
  getActiveEvent,
  isEventActive,
  getEventContext,
};
