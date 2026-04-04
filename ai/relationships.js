/**
 * relationships.js — NPC–Player Relationship System
 *
 * Each NPC tracks four axes per player:
 *   friendship  0–100  warmth and familiarity
 *   trust       0–100  reliability and honesty
 *   romance     0–100  attraction (optional, personality-gated)
 *   fear        0–100  intimidation or anxiety around this player
 *
 * Relationships affect dialogue tone injected into AI prompts,
 * and react to events, actions, and faction reputation.
 */

const agents = require('./agents.json');

// ─────────────────────────────────────────────
// STORE
// relationships[npcId][playerId] = { friendship, trust, romance, fear }
// ─────────────────────────────────────────────
const relationships = {};

agents.forEach(a => { relationships[a.id] = {}; });

const DEFAULTS = { friendship: 10, trust: 10, romance: 0, fear: 0 };

function ensure(npcId, playerId) {
  if (!relationships[npcId]) relationships[npcId] = {};
  if (!relationships[npcId][playerId]) {
    relationships[npcId][playerId] = { ...DEFAULTS };
  }
}

function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }

// ─────────────────────────────────────────────
// ACTION PRESETS
// How each player action shifts the four axes
// ─────────────────────────────────────────────
const RELATIONSHIP_ACTIONS = {
  // Positive
  gave_gift:        { friendship: +8,  trust: +3,  romance: +5,  fear: -3  },
  shared_secret:    { friendship: +5,  trust: +10, romance: +3,  fear:  0  },
  helped:           { friendship: +6,  trust: +5,  romance: +2,  fear: -5  },
  complimented:     { friendship: +4,  trust: +2,  romance: +4,  fear: -2  },
  long_talk:        { friendship: +3,  trust: +3,  romance: +1,  fear:  0  },
  visited_house:    { friendship: +5,  trust: +4,  romance: +2,  fear: -3  },
  attended_event:   { friendship: +4,  trust: +2,  romance: +2,  fear:  0  },
  // Neutral
  greeted:          { friendship: +1,  trust: +1,  romance:  0,  fear:  0  },
  // Negative
  rude:             { friendship: -6,  trust: -4,  romance: -4,  fear: +6  },
  lied:             { friendship: -3,  trust: -10, romance: -3,  fear: +3  },
  threatened:       { friendship: -8,  trust: -6,  romance: -8,  fear: +15 },
  ignored:          { friendship: -2,  trust: -1,  romance: -1,  fear:  0  },
  caused_scene:     { friendship: -5,  trust: -5,  romance: -5,  fear: +8  },
};

// ─────────────────────────────────────────────
// NPC ROMANCE GATES
// Only some NPCs allow romance to grow above 20
// ─────────────────────────────────────────────
const ROMANCE_ENABLED = new Set(['mira', 'zara', 'sol', 'lena', 'ivy']);

// ─────────────────────────────────────────────
// UPDATE RELATIONSHIP
// ─────────────────────────────────────────────
/**
 * @param {string} npcId
 * @param {string} playerId
 * @param {string} action    - key from RELATIONSHIP_ACTIONS or 'custom'
 * @param {object} [delta]   - override { friendship, trust, romance, fear }
 */
function updateRelationship(npcId, playerId, action, delta = {}) {
  ensure(npcId, playerId);
  const rel    = relationships[npcId][playerId];
  const preset = RELATIONSHIP_ACTIONS[action] || { friendship: 0, trust: 0, romance: 0, fear: 0 };
  const d      = { ...preset, ...delta };

  rel.friendship = clamp(rel.friendship + (d.friendship || 0));
  rel.trust      = clamp(rel.trust      + (d.trust      || 0));
  rel.fear       = clamp(rel.fear       + (d.fear       || 0));

  // Romance gated by NPC personality
  const romDelta = d.romance || 0;
  if (ROMANCE_ENABLED.has(npcId)) {
    rel.romance = clamp(rel.romance + romDelta);
  } else {
    rel.romance = clamp(rel.romance + Math.min(romDelta, 0)); // can only decrease
  }
}

/**
 * Bulk-update an NPC's relationship after an event outcome.
 * Used by the event system.
 */
function adjustAllRelationships(npcId, action) {
  for (const playerId of Object.keys(relationships[npcId] || {})) {
    updateRelationship(npcId, playerId, action);
  }
}

// ─────────────────────────────────────────────
// RELATIONSHIP STATE LABEL
// ─────────────────────────────────────────────
/**
 * Returns a human-readable relationship state string.
 * Priority: fear > romance > enemy > friend > acquaintance > stranger
 */
function getRelationshipState(npcId, playerId) {
  ensure(npcId, playerId);
  const { friendship, trust, romance, fear } = relationships[npcId][playerId];

  if (fear >= 60)                          return { state: 'terrified',    label: 'Terrified of you',  color: '#ff4444' };
  if (fear >= 30 && trust < 30)            return { state: 'wary',         label: 'Wary of you',       color: '#ff8844' };
  if (romance >= 60 && friendship >= 50)   return { state: 'lover',        label: 'In love with you',  color: '#f06292' };
  if (romance >= 30 && friendship >= 40)   return { state: 'admirer',      label: 'Admires you',       color: '#ce93d8' };
  if (friendship >= 70 && trust >= 60)     return { state: 'best_friend',  label: 'Best friends',      color: '#44ff88' };
  if (friendship >= 50 && trust >= 40)     return { state: 'close_friend', label: 'Close friends',     color: '#81c784' };
  if (friendship >= 30)                    return { state: 'friend',       label: 'Friends',            color: '#aabbff' };
  if (friendship < 10 && trust < 10)       return { state: 'enemy',        label: 'Considers you an enemy', color: '#ff4444' };
  if (friendship < 20)                     return { state: 'cold',         label: 'Cold toward you',   color: '#888780' };
  return                                          { state: 'neutral',       label: 'Acquaintance',      color: '#556677' };
}

/**
 * Get raw relationship values for a given NPC–player pair.
 */
function getRelationship(npcId, playerId) {
  ensure(npcId, playerId);
  return { ...relationships[npcId][playerId] };
}

// ─────────────────────────────────────────────
// PROMPT CONTEXT
// ─────────────────────────────────────────────
/**
 * Returns a block of text for the NPC prompt describing how they
 * feel about this player, without being mechanical.
 */
function getRelationshipContext(npcId, playerId) {
  ensure(npcId, playerId);
  const rel   = relationships[npcId][playerId];
  const state = getRelationshipState(npcId, playerId);

  const lines = [`## YOUR RELATIONSHIP WITH THIS PLAYER`];
  lines.push(`Status: ${state.label}`);
  lines.push(`Friendship ${rel.friendship}/100 | Trust ${rel.trust}/100 | Romance ${rel.romance}/100 | Fear ${rel.fear}/100`);
  lines.push('');

  // Tone guidance based on state
  const toneMap = {
    terrified:   'You are frightened of them. Stay guarded, keep distance, short answers.',
    wary:        'You are cautious. Polite but watchful. You don\'t quite trust them yet.',
    lover:       'You are deeply fond of them. Warm, a little flustered, maybe overly attentive.',
    admirer:     'You find them attractive or fascinating. You\'re warmer than usual.',
    best_friend: 'They are one of your closest people. Open, teasing, comfortable, affectionate.',
    close_friend:'You genuinely like them. Warm, easy, happy to see them.',
    friend:      'You like them. Friendly and open.',
    enemy:       'You dislike or distrust them. Clipped, guarded, perhaps passive-aggressive.',
    cold:        'You\'re not keen on them. Civil, but not warm.',
    neutral:     'They\'re a stranger. Polite, curious, no strong feelings either way.',
  };
  const tone = toneMap[state.state] || toneMap.neutral;
  lines.push(`Tone guidance: ${tone}`);
  lines.push('Express this through body language cues, word choice, and warmth — not by announcing the numbers.');

  return lines.join('\n');
}

module.exports = {
  updateRelationship,
  adjustAllRelationships,
  getRelationshipState,
  getRelationship,
  getRelationshipContext,
  RELATIONSHIP_ACTIONS,
  relationships, // exposed for event system and debug
};
