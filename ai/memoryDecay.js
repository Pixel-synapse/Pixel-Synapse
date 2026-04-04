/**
 * memoryDecay.js — Memory Decay System for Pixel Synapse
 *
 * Wraps and extends memory.js with time-based decay.
 * Low-importance memories fade; high-importance persist.
 * Decayed memories can be "misremembered" — NPC reconstructs
 * a plausible but incorrect version, feeding the deception system.
 *
 * Importance scale (0–10):
 *   0–2  trivial (weather chat, small talk)
 *   3–5  notable (shared info, first meeting)
 *   6–8  significant (secrets, emotional moments)
 *   9–10 unforgettable (betrayal, confession, life events)
 *
 * Decay rates (game-minutes to 50% retention):
 *   importance 0–2  →  30 min  (forgotten quickly)
 *   importance 3–5  →  120 min
 *   importance 6–8  →  480 min
 *   importance 9–10 →  never decays
 */

const { memories } = require('./memory'); // we extend the existing store

// ─────────────────────────────────────────────
// IMPORTANCE HEURISTICS
// Assigned when a memory is first stored.
// ─────────────────────────────────────────────
const HIGH_IMPORTANCE_KEYWORDS = [
  'secret', 'love', 'hate', 'betray', 'lie', 'lied', 'truth',
  'danger', 'die', 'kill', 'afraid', 'promise', 'always', 'never',
  'forgive', 'sorry', 'hurt', 'trust', 'betray', 'confess',
];
const MED_IMPORTANCE_KEYWORDS = [
  'remember', 'important', 'help', 'name', 'from', 'looking for',
  'first', 'friend', 'money', 'job', 'house', 'family',
];

/**
 * Score a memory's importance (0–10) based on its content.
 */
function scoreImportance(playerMessage, npcReply, emotion, isFirst) {
  if (isFirst) return 6; // first meeting is always notable

  let score = 2; // base
  const text = `${playerMessage} ${npcReply}`.toLowerCase();

  for (const kw of HIGH_IMPORTANCE_KEYWORDS) {
    if (text.includes(kw)) { score = Math.min(10, score + 2); }
  }
  for (const kw of MED_IMPORTANCE_KEYWORDS) {
    if (text.includes(kw)) { score = Math.min(10, score + 1); }
  }

  // Emotional moments stick
  if (['sad', 'excited', 'suspicious', 'nervous'].includes(emotion)) score = Math.min(10, score + 1);
  if (emotion === 'happy') score = Math.min(10, score + 0.5);

  return Math.round(score);
}

// ─────────────────────────────────────────────
// DECAY RATE
// Returns fraction of memory strength remaining at gameMinute.
// Uses exponential decay: S(t) = e^(-λt) where λ = ln(2)/halfLife
// ─────────────────────────────────────────────
function halfLifeForImportance(importance) {
  if (importance >= 9) return Infinity;
  if (importance >= 6) return 480;
  if (importance >= 3) return 120;
  return 30;
}

function decayStrength(importance, minutesElapsed) {
  const halfLife = halfLifeForImportance(importance);
  if (!isFinite(halfLife)) return 1.0;
  return Math.exp(-(Math.LN2 / halfLife) * minutesElapsed);
}

// ─────────────────────────────────────────────
// ADD DECAY-AWARE MEMORY
// Extends the existing addMemory by scoring importance
// and stamping a gameMinute timestamp.
// ─────────────────────────────────────────────

let _currentGameMinute = 480; // updated by server each tick

function setGameMinute(gm) { _currentGameMinute = gm; }
function getGameMinute()   { return _currentGameMinute; }

/**
 * Add a memory entry with importance scoring and decay timestamp.
 * Call this INSTEAD of memory.addMemory when decay is desired.
 */
function addDecayMemory(npcId, playerId, interaction) {
  if (!memories[npcId]) memories[npcId] = {};
  if (!memories[npcId][playerId]) {
    memories[npcId][playerId] = {
      shortTerm: [], longTerm: [],
      interactionCount: 0,
      firstMet: new Date().toISOString(),
    };
  }

  const mem = memories[npcId][playerId];
  const isFirst = mem.interactionCount === 0;
  const importance = scoreImportance(
    interaction.playerMessage, interaction.npcReply,
    interaction.emotion, isFirst
  );

  const entry = {
    timestamp:   new Date().toISOString(),
    gameMinute:  _currentGameMinute,
    playerName:  interaction.playerName || 'Unknown',
    playerSaid:  interaction.playerMessage,
    iReplied:    interaction.npcReply,
    emotion:     interaction.emotion || 'neutral',
    importance,
    strength:    1.0,    // starts at full strength, decayed on read
    distorted:   false,
  };

  mem.shortTerm.push(entry);
  if (mem.shortTerm.length > 12) mem.shortTerm.shift();
  mem.interactionCount++;

  // High-importance → long-term
  if (importance >= 5) {
    mem.longTerm.push({ ...entry, reason: isFirst ? 'first_meeting' : 'high_importance' });
    if (mem.longTerm.length > 15) mem.longTerm.shift();
  }
}

// ─────────────────────────────────────────────
// DECAY MEMORY
// Recalculates strength for all memories and marks
// low-strength ones as candidates for distortion or pruning.
// ─────────────────────────────────────────────

/**
 * Apply decay to all memories for a specific NPC.
 * Mutates the store in-place.
 * @param {string} npcId
 */
function decayMemory(npcId) {
  const npcMem = memories[npcId];
  if (!npcMem) return;

  for (const [playerId, mem] of Object.entries(npcMem)) {
    for (const list of [mem.shortTerm, mem.longTerm]) {
      for (const entry of list) {
        if (entry.gameMinute === undefined) continue;
        const elapsed = _currentGameMinute - entry.gameMinute;
        if (elapsed <= 0) continue;
        entry.strength = decayStrength(entry.importance || 3, elapsed);

        // Mark for potential distortion when strength drops below 0.4
        if (entry.strength < 0.4 && !entry.distorted) {
          entry.distorted = true;
          entry._originalPlayerSaid = entry.playerSaid;
          entry.playerSaid = _distortText(entry.playerSaid, entry.strength);
        }
      }
    }
  }
}

/**
 * Run decay across ALL NPCs. Call this periodically (e.g. every game hour).
 */
function decayAllMemories() {
  for (const npcId of Object.keys(memories)) {
    decayMemory(npcId);
  }
}

// ─────────────────────────────────────────────
// PRUNE MEMORY
// Remove entries whose strength has fallen below threshold.
// ─────────────────────────────────────────────

const PRUNE_THRESHOLD = 0.08; // below 8% strength → forgotten

/**
 * Remove memories too weak to recall for a specific NPC.
 */
function pruneMemory(npcId) {
  const npcMem = memories[npcId];
  if (!npcMem) return;

  for (const mem of Object.values(npcMem)) {
    mem.shortTerm = mem.shortTerm.filter(e =>
      (e.strength === undefined) || e.strength >= PRUNE_THRESHOLD
    );
    // Long-term: only prune importance < 7 entries
    mem.longTerm = mem.longTerm.filter(e =>
      (e.importance || 5) >= 7 ||
      (e.strength === undefined) ||
      e.strength >= PRUNE_THRESHOLD
    );
  }
}

// ─────────────────────────────────────────────
// DISTORT TEXT
// Simulate misremembering: swap subjects, blur details.
// ─────────────────────────────────────────────
const DISTORT_SWAPS = [
  [/gave/g, 'took'],
  [/helped/g, 'ignored'],
  [/loves?/g, 'hates'],
  [/hates?/g, 'loves'],
  [/trust/g, 'distrust'],
  [/honest/g, 'dishonest'],
  [/kind/g, 'cold'],
  [/found/g, 'lost'],
];

function _distortText(text, strength) {
  if (!text) return text;
  // More distortion the weaker the memory
  if (strength > 0.3) {
    // Mild: add uncertainty prefix
    return `I think ${text.toLowerCase()}`;
  }
  if (strength > 0.15) {
    // Moderate: swap one word pair
    const swap = DISTORT_SWAPS[Math.floor(Math.random() * DISTORT_SWAPS.length)];
    const result = text.replace(swap[0], swap[1]);
    return result !== text ? result : `something about "${text.slice(0, 20)}..."`;
  }
  // Severe: just fragments
  const words = text.split(' ');
  const fragment = words.slice(0, Math.max(2, Math.floor(words.length * strength * 3))).join(' ');
  return `Something about "${fragment}..."`;
}

// ─────────────────────────────────────────────
// SUMMARIZE MEMORY
// Returns a prompt-ready summary, respecting decay state.
// ─────────────────────────────────────────────

/**
 * Generate a summary of what an NPC currently remembers about a player.
 * Includes strength indicators and distortion warnings.
 *
 * @param {string} npcId
 * @param {string} playerId
 * @returns {string}
 */
function summarizeMemory(npcId, playerId) {
  if (!memories[npcId]?.[playerId]) {
    return 'You have never spoken to this player before.';
  }

  const mem = memories[npcId][playerId];
  const lines = [];

  lines.push(`You have met this player ${mem.interactionCount} time(s).`);

  // Strong long-term memories
  const strongLT = mem.longTerm.filter(e => (e.strength ?? 1) >= 0.4);
  if (strongLT.length > 0) {
    lines.push('\nThings you clearly remember:');
    strongLT.slice(-3).forEach(e => {
      const note = e.distorted ? ' (your memory of this feels fuzzy)' : '';
      lines.push(`  - They said: "${e.playerSaid}"${note}`);
    });
  }

  // Weak / distorted memories
  const distortedMems = mem.longTerm.filter(e => e.distorted && (e.strength ?? 1) < 0.4 && (e.strength ?? 1) >= PRUNE_THRESHOLD);
  if (distortedMems.length > 0) {
    lines.push('\nVague memories (may be inaccurate):');
    distortedMems.slice(-2).forEach(e => {
      lines.push(`  - ${e.playerSaid} (you\'re not sure you remember this right)`);
    });
  }

  // Recent short-term
  const recentST = mem.shortTerm.filter(e => (e.strength ?? 1) >= 0.3).slice(-3);
  if (recentST.length > 0) {
    lines.push('\nRecent exchange:');
    recentST.forEach(e => {
      lines.push(`  ${e.playerName}: "${e.playerSaid}"`);
      lines.push(`  You: "${e.iReplied}"`);
    });
  }

  // If everything is decayed
  if (strongLT.length === 0 && recentST.length === 0) {
    lines.push('Your memory of this player is hazy. You\'ve met before but the details are unclear.');
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────
module.exports = {
  addDecayMemory,
  decayMemory,
  decayAllMemories,
  pruneMemory,
  summarizeMemory,
  scoreImportance,
  setGameMinute,
  getGameMinute,
};
