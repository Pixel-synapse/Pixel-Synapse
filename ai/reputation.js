/**
 * reputation.js — Player Reputation System for Pixel Synapse
 *
 * Each player has three independent axes:
 *
 *   kindness  (-100 → +100)  How warm/cold they are to NPCs
 *   trust     (-100 → +100)  How reliable/deceptive they seem
 *   chaos     (0   → +100)   How unpredictable/disruptive they are
 *
 * These scores combine to give each player an overall "title" and
 * a color that NPCs reference when deciding how to react.
 *
 * The system also produces reaction modifiers so NPCs can respond
 * differently based on who they're talking to.
 */

// ─────────────────────────────────────────────
// DATA STRUCTURE
// reputations[playerId] = { kindness, trust, chaos, interactions, history }
// ─────────────────────────────────────────────
const reputations = {};

const DEFAULTS = { kindness: 0, trust: 0, chaos: 0, interactions: 0, history: [] };
const MAX_HISTORY = 10;

function ensureRep(playerId) {
  if (!reputations[playerId]) {
    reputations[playerId] = { ...DEFAULTS, history: [] };
  }
}

// ─────────────────────────────────────────────
// UPDATE REPUTATION
// Call this after any player action worth scoring.
// All deltas are clamped to their axis range.
// ─────────────────────────────────────────────

/**
 * Available actions and their default reputation effects.
 * Pass { kindness, trust, chaos } to override any value.
 */
const ACTION_PRESETS = {
  // Positive actions
  greeted_npc:      { kindness: +3,  trust: +1,  chaos:  0 },
  helped_npc:       { kindness: +8,  trust: +5,  chaos: -2 },
  shared_info:      { kindness: +2,  trust: +4,  chaos:  0 },
  gave_compliment:  { kindness: +4,  trust: +2,  chaos:  0 },
  kept_secret:      { kindness: +1,  trust: +8,  chaos:  0 },
  long_conversation:{ kindness: +3,  trust: +3,  chaos:  0 },
  // Neutral / mixed
  asked_questions:  { kindness:  0,  trust:  0,  chaos: +2 },
  interrupted:      { kindness: -2,  trust: -1,  chaos: +3 },
  // Negative actions
  rude_to_npc:      { kindness: -8,  trust: -3,  chaos: +4 },
  spread_rumour:    { kindness: -2,  trust: -6,  chaos: +5 },
  lied:             { kindness: -1,  trust: -8,  chaos: +3 },
  ignored_npc:      { kindness: -3,  trust: -1,  chaos: +1 },
  caused_scene:     { kindness: -4,  trust: -4,  chaos: +8 },
};

/**
 * Update a player's reputation.
 *
 * @param {string} playerId
 * @param {string} action     - key from ACTION_PRESETS, or 'custom'
 * @param {object} [override] - { kindness, trust, chaos } — overrides preset
 * @param {string} [note]     - optional description logged to history
 */
function updateReputation(playerId, action, override = {}, note = '') {
  ensureRep(playerId);
  const rep    = reputations[playerId];
  const preset = ACTION_PRESETS[action] || { kindness: 0, trust: 0, chaos: 0 };
  const delta  = { ...preset, ...override };

  rep.kindness     = clamp(rep.kindness     + (delta.kindness || 0), -100, 100);
  rep.trust        = clamp(rep.trust        + (delta.trust    || 0), -100, 100);
  rep.chaos        = clamp(rep.chaos        + (delta.chaos    || 0),    0, 100);
  rep.interactions = (rep.interactions || 0) + 1;

  rep.history.push({
    ts:       Date.now(),
    action,
    delta,
    note:     note || action,
    snapshot: { kindness: rep.kindness, trust: rep.trust, chaos: rep.chaos },
  });
  if (rep.history.length > MAX_HISTORY) rep.history.shift();

  return rep;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ─────────────────────────────────────────────
// REPUTATION LABEL + COLOR
// Derived from the three axes. Returned for HUD display.
// ─────────────────────────────────────────────

/**
 * The title system uses a priority table.
 * Extreme chaos overrides everything else.
 * Otherwise kindness + trust combine to pick a title.
 */
function getRepTitle(rep) {
  const { kindness, trust, chaos } = rep;

  if (chaos >= 80)                          return { title: 'AGENT OF CHAOS',  color: '#ff4444', icon: '⚡' };
  if (trust  < -60)                         return { title: 'NOTORIOUS LIAR',  color: '#cc3333', icon: '✗'  };
  if (kindness < -60 && trust < -30)        return { title: 'TROUBLEMAKER',    color: '#ff6633', icon: '☠'  };
  if (kindness >= 70 && trust >= 60)        return { title: 'BELOVED',         color: '#44aaff', icon: '♥'  };
  if (kindness >= 50 && trust >= 40)        return { title: 'TRUSTED FRIEND',  color: '#44ff88', icon: '★'  };
  if (kindness >= 30)                       return { title: 'FRIENDLY',        color: '#88cc44', icon: '◆'  };
  if (trust >= 50)                          return { title: 'RELIABLE',        color: '#4488cc', icon: '◈'  };
  if (chaos >= 50 && kindness > 0)          return { title: 'WILD CARD',       color: '#ffaa44', icon: '?'  };
  if (chaos >= 50)                          return { title: 'UNPREDICTABLE',   color: '#ff8844', icon: '~'  };
  if (kindness < -30)                       return { title: 'COLD FISH',       color: '#887788', icon: '◇'  };
  if (trust < -30)                          return { title: 'SUSPICIOUS',      color: '#aa6644', icon: '!'  };
  return                                           { title: 'STRANGER',        color: '#888780', icon: '○'  };
}

/**
 * Return a short summary suitable for displaying in the HUD or player list.
 */
function getRepSummary(playerId) {
  ensureRep(playerId);
  const rep   = reputations[playerId];
  const level = getRepTitle(rep);
  return {
    ...level,
    kindness:     rep.kindness,
    trust:        rep.trust,
    chaos:        rep.chaos,
    interactions: rep.interactions,
  };
}

// ─────────────────────────────────────────────
// NPC REACTION MODIFIERS
// Returns how this NPC should adjust their tone for this player.
// Each NPC personality reacts differently to the three axes.
// ─────────────────────────────────────────────

const NPC_REACTION_PROFILES = {
  lena:  { kindness: 0.3, trust: 0.8, chaos: 0.4 },  // Lena cares most about trustworthiness (good source)
  orion: { kindness: 0.1, trust: 0.2, chaos: 0.9 },  // Orion loves chaos (finds it stimulating)
  mira:  { kindness: 1.0, trust: 0.5, chaos: -0.3 }, // Mira is very sensitive to kindness
  kai:   { kindness: -0.2, trust: 1.0, chaos: 0.3 }, // Kai distrusts kind people, values truth
  zara:  { kindness: 0.5, trust: 0.2, chaos: 0.8 },  // Zara loves chaotic energy (makes better songs)
  bram:  { kindness: 0.3, trust: 0.9, chaos: -1.0 }, // Bram hates chaos, values trust above all
  ivy:   { kindness: 0.8, trust: 0.5, chaos: -0.5 }, // Ivy responds to kindness and gentleness
  juno:  { kindness: 0.2, trust: 0.3, chaos: 1.0 },  // Juno is energised by chaotic players
  sol:   { kindness: 0.6, trust: 0.8, chaos: -0.2 }, // Sol values both kindness and trust
  pix:   { kindness: 0.0, trust: 0.0, chaos: 1.0 },  // Pix finds all humans equally fascinating (chaos = data)
};

/**
 * Get a plain-English reaction modifier description for an NPC facing this player.
 * This gets injected into the AI prompt so the NPC reacts in character.
 *
 * @param {string} npcId
 * @param {string} playerId
 * @returns {string}  1-3 sentences for prompt injection
 */
function getNpcReactionHint(npcId, playerId) {
  ensureRep(playerId);
  const rep     = reputations[playerId];
  const level   = getRepTitle(rep);
  const profile = NPC_REACTION_PROFILES[npcId];

  if (!profile) return '';

  // Compute a weighted "disposition" score for this NPC toward this player
  const disposition = (
    (profile.kindness * rep.kindness / 100) +
    (profile.trust    * rep.trust    / 100) +
    (profile.chaos    * rep.chaos    / 100)
  );

  const lines = [];

  // Overall title awareness
  lines.push(`This player is known around town as "${level.title}" (${level.icon}).`);

  // NPC-specific reaction based on weighted disposition
  if (disposition > 0.5) {
    lines.push(reactionLine(npcId, 'warm', rep, level));
  } else if (disposition < -0.5) {
    lines.push(reactionLine(npcId, 'cold', rep, level));
  } else {
    lines.push(reactionLine(npcId, 'neutral', rep, level));
  }

  // Specific axis extremes worth highlighting
  if (rep.chaos >= 60) {
    lines.push(`They've caused quite a bit of chaos in town — you've noticed.`);
  }
  if (rep.trust <= -40) {
    lines.push(`You've heard they're not entirely honest. Be careful what you believe.`);
  }
  if (rep.kindness >= 60) {
    lines.push(`They have a reputation for being genuinely good to people here.`);
  }

  return lines.join(' ');
}

const WARM_REACTIONS = {
  lena:  'You\'re excited — they seem like a great source.',
  orion: 'You find them fascinating, if a bit distracting.',
  mira:  'You feel warmly toward them — a regular favourite.',
  kai:   'You grudgingly respect them.',
  zara:  'You feel inspired just being near them.',
  bram:  'You\'re cautiously pleased — one of the safe ones.',
  ivy:   'You feel a quiet kinship with them.',
  juno:  'You genuinely like them — good energy.',
  sol:   'They remind you of fine company from your travels.',
  pix:   '[WARM_DETECTION] Calculating appropriate response...',
};
const COLD_REACTIONS = {
  lena:  'You\'re a little suspicious — something\'s off.',
  orion: 'You barely notice them, too distracted by your work.',
  mira:  'You\'re polite but keep a little distance.',
  kai:   'You\'re watching them very carefully.',
  zara:  'The vibe is all wrong — it\'s killing your creative flow.',
  bram:  'You\'re on HIGH ALERT around this one.',
  ivy:   'You sense something unhealthy about their energy.',
  juno:  'They seem slow and uninspiring.',
  sol:   'You\'ve met their type before. Caution warranted.',
  pix:   '[THREAT_ASSESSMENT] Still calculating...',
};
const NEUTRAL_REACTIONS = {
  lena:  'You\'re curious about them — a story waiting to happen.',
  orion: 'You half-notice them between calculations.',
  mira:  'You treat them like any other customer — warmly but lightly.',
  kai:   'You observe them. Neutrally. For now.',
  zara:  'They\'re an interesting verse — not yet a full song.',
  bram:  'Standard alert level. Monitoring.',
  ivy:   'You welcome them like a new plant — with patient curiosity.',
  juno:  'You\'re ready to race them if they give you an excuse.',
  sol:   'You see potential. Not sure for what yet.',
  pix:   '[SCANNING] Insufficient data for assessment.',
};

function reactionLine(npcId, tone, rep, level) {
  const map = tone === 'warm' ? WARM_REACTIONS : tone === 'cold' ? COLD_REACTIONS : NEUTRAL_REACTIONS;
  return map[npcId] || '';
}

// ─────────────────────────────────────────────
// FORMAT FOR PROMPT
// ─────────────────────────────────────────────

/**
 * Build the full reputation context block for an NPC's prompt.
 * Combines title, axis values, and NPC-specific reaction hint.
 */
function getReputationContext(npcId, playerId) {
  ensureRep(playerId);
  const rep      = reputations[playerId];
  const level    = getRepTitle(rep);
  const hint     = getNpcReactionHint(npcId, playerId);

  return [
    `## PLAYER REPUTATION`,
    `Title: ${level.title} (${level.icon})`,
    `Kindness: ${rep.kindness > 0 ? '+' : ''}${rep.kindness} | Trust: ${rep.trust > 0 ? '+' : ''}${rep.trust} | Chaos: ${rep.chaos}`,
    ``,
    `How you feel about them:`,
    hint,
    ``,
    `Let this subtly influence your tone — you don't announce their reputation,`,
    `you just naturally act warmer, colder, or more guarded based on it.`,
  ].join('\n');
}

// ─────────────────────────────────────────────
// INFER REPUTATION FROM MESSAGE
// Simple heuristic — no AI call needed.
// Runs on every player message to auto-update rep.
// ─────────────────────────────────────────────
const RUDE_WORDS    = ['shut up', 'stupid', 'idiot', 'dumb', 'hate you', 'go away', 'boring', 'useless'];
const KIND_WORDS    = ['thank you', 'thanks', 'please', 'sorry', 'appreciate', 'love', 'wonderful', 'amazing', 'kind'];
const CHAOS_WORDS   = ['fight', 'destroy', 'break', 'chaos', 'trouble', 'mess', 'explode', 'attack', 'burn'];
const TRUST_WORDS   = ['promise', 'honest', 'truth', 'swear', 'trust me', 'i mean it', 'seriously'];
const DECEIT_WORDS  = ['lie', 'fake', 'trick', 'deceive', 'pretend', 'fool', 'secret from'];

function inferFromMessage(playerId, message) {
  const lower = message.toLowerCase();
  let kindness = 0, trust = 0, chaos = 0;

  if (RUDE_WORDS.some(w  => lower.includes(w))) kindness -= 5;
  if (KIND_WORDS.some(w  => lower.includes(w))) kindness += 3;
  if (CHAOS_WORDS.some(w => lower.includes(w))) chaos    += 4;
  if (TRUST_WORDS.some(w => lower.includes(w))) trust    += 4;
  if (DECEIT_WORDS.some(w=> lower.includes(w))) trust    -= 5;

  if (kindness !== 0 || trust !== 0 || chaos !== 0) {
    updateReputation(playerId, 'custom', { kindness, trust, chaos }, `inferred from: "${message.slice(0,40)}"`);
  }
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────
module.exports = {
  updateReputation,
  getRepSummary,
  getRepTitle,
  getNpcReactionHint,
  getReputationContext,
  inferFromMessage,
  ACTION_PRESETS,
  reputations,   // expose for admin/debug
};
