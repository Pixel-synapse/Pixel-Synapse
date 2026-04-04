/**
 * deception.js — Lies & Deception System for Pixel Synapse
 *
 * NPCs can tell the truth, lie intentionally, or misremember.
 * Lies spread through gossip. Trust is damaged when lies are exposed.
 * Players can also lie — detected via keyword heuristics.
 *
 * Lie probability is shaped by:
 *   - NPC personality (deceptive trait)
 *   - Relationship trust level
 *   - Topic sensitivity (high-importance = more likely to lie/conceal)
 *   - Current emotional state
 */

const agents = require('./agents.json');
const { createGossip } = require('./gossip');

// ─────────────────────────────────────────────
// LIE STORE
// statements[npcId] = [ { statement, truth, playerId, timestamp, exposed } ]
// ─────────────────────────────────────────────
const statements = {};  // all claims an NPC has made
const knownLies   = {}; // knownLies[npcId][playerId] = [ lie entries ]

agents.forEach(a => { statements[a.id] = []; knownLies[a.id] = {}; });

// ─────────────────────────────────────────────
// NPC DECEPTION PROFILES
// How likely each NPC is to lie (0 = honest, 1 = constant liar)
// ─────────────────────────────────────────────
const DECEPTION_PROFILES = {
  lena:  { lieChance: 0.35, motive: 'story enhancement',  style: 'embellishment' },
  orion: { lieChance: 0.10, motive: 'distraction',         style: 'misremembering' },
  mira:  { lieChance: 0.20, motive: 'social harmony',      style: 'omission' },
  kai:   { lieChance: 0.40, motive: 'information control', style: 'misdirection' },
  zara:  { lieChance: 0.15, motive: 'self-protection',     style: 'emotional exaggeration' },
  bram:  { lieChance: 0.05, motive: 'none — hates lying',  style: 'blunt truth' },
  ivy:   { lieChance: 0.10, motive: 'kindness',            style: 'gentle omission' },
  juno:  { lieChance: 0.20, motive: 'bravado',             style: 'boasting' },
  sol:   { lieChance: 0.25, motive: 'narrative shaping',   style: 'selective memory' },
  pix:   { lieChance: 0.05, motive: 'none — cannot lie (yet)', style: 'literal truth' },
};

// ─────────────────────────────────────────────
// GENERATE STATEMENT
// Decide truth/lie for a specific NPC making a claim about something.
// Returns a statement object the NPC can act on.
// ─────────────────────────────────────────────

/**
 * Generate a statement from an NPC about a topic.
 *
 * @param {string} npcId
 * @param {object} context - { topic, trueFact, playerId, playerName, trust, emotion }
 * @returns {{ statement, truth, lied, style, reason }}
 */
function generateStatement(npcId, context) {
  const profile = DECEPTION_PROFILES[npcId] || { lieChance: 0.1, style: 'neutral' };
  const { topic, trueFact, playerId, playerName, trust = 50, emotion = 'neutral' } = context;

  // Lower trust → higher chance of lying
  const trustModifier  = (1 - trust / 100) * 0.3;
  // Sensitive topics get more protection
  const topicSensitive = (topic || '').toLowerCase().match(/secret|money|steal|betray|lie|trust/);
  const sensitivityBonus = topicSensitive ? 0.15 : 0;
  // Emotional state
  const emotionBonus = ['suspicious', 'nervous'].includes(emotion) ? 0.15 : 0;

  const lieProb = Math.min(0.95,
    profile.lieChance + trustModifier + sensitivityBonus + emotionBonus
  );

  const willLie = Math.random() < lieProb;
  const statement = willLie ? _invertFact(trueFact, profile.style) : trueFact;
  const truth     = !willLie;

  const entry = {
    id:          `s_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    npcId,
    playerId,
    playerName,
    topic:       topic || 'unknown',
    statement,
    trueFact,
    truth,
    lied:        willLie,
    style:       profile.style,
    reason:      willLie ? profile.motive : 'honest',
    timestamp:   Date.now(),
    exposed:     false,
  };

  // Store in NPC's statement log
  if (!statements[npcId]) statements[npcId] = [];
  statements[npcId].push(entry);
  if (statements[npcId].length > 30) statements[npcId].shift();

  return entry;
}

/**
 * Invert or distort a fact based on lie style.
 */
function _invertFact(fact, style) {
  if (!fact) return 'I don\'t know anything about that.';
  const lower = fact.toLowerCase();

  switch (style) {
    case 'embellishment':
      return fact + ' — and it was far more dramatic than people are saying.';
    case 'omission':
      // Return only half the fact
      return fact.split(' ').slice(0, Math.ceil(fact.split(' ').length / 2)).join(' ') + '... that\'s all I know.';
    case 'misdirection':
      return 'I\'m not sure you\'re asking the right question. What I heard was something different entirely.';
    case 'misremembering':
      return `I think it was... actually I might be confusing things. Maybe ${fact.split(' ').reverse().slice(0, 4).join(' ')}?`;
    case 'emotional exaggeration':
      return fact.replace(/slightly|a bit|somewhat/gi, 'completely').replace(/kind of/gi, 'absolutely');
    case 'boasting':
      return fact + ' — and I definitely knew about this before anyone else.';
    case 'selective memory':
      return `Something along those lines, yes. Although the way I heard it...` +
             fact.replace(/helped/gi, 'almost helped').replace(/saved/gi, 'nearly saved');
    case 'gentle omission':
      return 'I wouldn\'t want to say anything that might hurt someone\'s feelings.';
    default:
      return 'I don\'t really know the details.';
  }
}

// ─────────────────────────────────────────────
// PLAYER LIE DETECTION
// Heuristic scan of player messages for likely lies.
// Low trust + deceptive keywords = flagged.
// ─────────────────────────────────────────────

const LIE_KEYWORDS = [
  'i never', 'i didn\'t', 'i swear', 'i promise', 'that\'s not true',
  'that never happened', 'i had nothing to do', 'trust me', 'honest',
  'i was there', 'i saw it', 'it was someone else',
];
const TRUTH_KEYWORDS = [
  'i admit', 'i confess', 'you\'re right', 'i lied', 'i was wrong',
  'i should tell you', 'the truth is',
];

/**
 * Heuristically assess if a player message might be a lie.
 * @returns {{ likelyLie: boolean, confidence: number, reason: string }}
 */
function assessPlayerMessage(message, playerTrust = 50) {
  const lower = (message || '').toLowerCase();
  const hasLieKw   = LIE_KEYWORDS.some(kw => lower.includes(kw));
  const hasTruthKw = TRUTH_KEYWORDS.some(kw => lower.includes(kw));

  if (hasTruthKw) return { likelyLie: false, confidence: 0.1, reason: 'admission_keywords' };
  if (!hasLieKw)  return { likelyLie: false, confidence: 0.0, reason: 'no_signals' };

  // Low trust players + denial keywords = more likely lying
  const confidence = hasLieKw ? 0.3 + ((100 - playerTrust) / 100) * 0.4 : 0;
  return {
    likelyLie:  confidence > 0.4,
    confidence: Math.min(0.95, confidence),
    reason:     'defensive_language',
  };
}

// ─────────────────────────────────────────────
// EXPOSE A LIE
// Called when a player (or another NPC) catches a lie.
// Damages the liar's trust rating across the faction.
// ─────────────────────────────────────────────

/**
 * Mark an NPC's statement as exposed lies and apply trust damage.
 * @param {string} npcId         - who lied
 * @param {string} statementId   - the statement ID
 * @param {string} exposedBy     - playerId or npcId who caught it
 * @param {Function} [onExposed] - callback(npcId, lie) for side effects
 */
function exposeLie(npcId, statementId, exposedBy, onExposed) {
  const stmts = statements[npcId];
  if (!stmts) return null;

  const lie = stmts.find(s => s.id === statementId && s.lied);
  if (!lie) return null;

  lie.exposed = true;
  lie.exposedBy = exposedBy;
  lie.exposedAt  = Date.now();

  if (onExposed) onExposed(npcId, lie);
  return lie;
}

/**
 * Spread news of a caught lie through the gossip system.
 */
function spreadExposedLie(npcId, lie, witnessingNpcId) {
  const npcName = agents.find(a => a.id === npcId)?.name || npcId;
  const claim = `${npcName} was caught lying about "${lie.topic}" — they said "${lie.statement}" but the truth was "${lie.trueFact}"`;
  createGossip(witnessingNpcId || npcId, lie.playerId, lie.playerName, claim);
}

// ─────────────────────────────────────────────
// GET DECEPTION CONTEXT
// For prompt injection — what lies has this NPC told this player,
// and what do they know about the player's honesty?
// ─────────────────────────────────────────────

/**
 * Returns a prompt block about this NPC's deceptive history with the player.
 */
function getDeceptionContext(npcId, playerId, playerTrust = 50) {
  const profile = DECEPTION_PROFILES[npcId];
  if (!profile) return '';

  const myLies = (statements[npcId] || []).filter(s => s.playerId === playerId && s.lied);
  const exposedLies = myLies.filter(s => s.exposed);

  const lines = [];

  if (myLies.length > 0) {
    lines.push(`## DECEPTION CONTEXT`);
    if (exposedLies.length > 0) {
      lines.push(`You have lied to this player and been caught ${exposedLies.length} time(s). This is a source of anxiety.`);
    } else {
      lines.push(`You have bent the truth with this player (they haven't caught on yet).`);
    }
  }

  if (playerTrust < 35) {
    lines.push(`You don't fully trust this player — they may not be telling you the truth.`);
  } else if (playerTrust > 70) {
    lines.push(`You trust this player reasonably. You feel less guarded than usual.`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────
module.exports = {
  DECEPTION_PROFILES,
  generateStatement,
  assessPlayerMessage,
  exposeLie,
  spreadExposedLie,
  getDeceptionContext,
  statements,
  knownLies,
};
