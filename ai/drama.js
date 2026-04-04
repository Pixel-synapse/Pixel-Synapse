/**
 * drama.js — Drama Escalation System for Pixel Synapse
 *
 * Gossip and betrayal accumulate into "drama pressure" on each NPC.
 * When pressure crosses a threshold, a public drama event fires,
 * affecting relationships, factions, and gossip simultaneously.
 *
 * Drama stages (by dramaLevel 0–100):
 *   0–24   Quiet      — nothing visible
 *   25–49  Rumour     — NPC becomes slightly cagey
 *   50–74  Suspicion  — NPC openly guarded, terse dialogue
 *   75–89  Conflict   — NPC confronts player next interaction
 *   90–100 Public Drama — broadcast town event, faction fallout
 */

const agents = require('./agents.json');
const { createGossip } = require('./gossip');
const { updateRelationship } = require('./relationships');
const { updateFactionRepFromNpc } = require('./factions');

// ─────────────────────────────────────────────
// DRAMA STORE
// dramaPressure[npcId] = { level, stage, history, lastEventAt }
// ─────────────────────────────────────────────
const dramaPressure = {};

agents.forEach(a => {
  dramaPressure[a.id] = {
    level:       0,      // 0–100
    stage:       'quiet',
    history:     [],     // [{ reason, amount, ts }]
    lastEventAt: 0,      // game-minute of last public event
  };
});

// ─────────────────────────────────────────────
// STAGE THRESHOLDS
// ─────────────────────────────────────────────
const STAGES = [
  { name: 'quiet',    min: 0,  label: 'Quiet',       color: '#556677' },
  { name: 'rumour',   min: 25, label: 'Rumour',       color: '#ffcc44' },
  { name: 'suspicion',min: 50, label: 'Suspicion',    color: '#ff8844' },
  { name: 'conflict', min: 75, label: 'Conflict',     color: '#ff4444' },
  { name: 'drama',    min: 90, label: 'Public Drama', color: '#f06292' },
];

function getStageForLevel(level) {
  let stage = STAGES[0];
  for (const s of STAGES) { if (level >= s.min) stage = s; }
  return stage;
}

// ─────────────────────────────────────────────
// DRAMA SOURCES — how much each event adds
// ─────────────────────────────────────────────
const DRAMA_SOURCES = {
  gossip_received:  +5,
  lie_detected:     +12,
  betrayal:         +25,
  relationship_collapse: +20,
  rumour_spread:    +8,
  npc_accused:      +15,
  player_was_kind:  -6,   // kindness relieves drama
  long_talk:        -3,
  helped:           -8,
};

// ─────────────────────────────────────────────
// INCREASE / DECREASE DRAMA
// ─────────────────────────────────────────────

/**
 * Add drama pressure to an NPC.
 * @param {string} npcId
 * @param {string} reason    — key from DRAMA_SOURCES or 'custom'
 * @param {number} [amount]  — override default amount
 * @param {string} [note]    — descriptive note for history
 * @returns {{ level, stage, crossed }} — whether a threshold was just crossed
 */
function increaseDrama(npcId, reason, amount, note = '') {
  const dp = dramaPressure[npcId];
  if (!dp) return null;

  const prevStage = dp.stage;
  const delta     = amount ?? (DRAMA_SOURCES[reason] ?? 5);
  dp.level        = Math.max(0, Math.min(100, dp.level + delta));
  dp.stage        = getStageForLevel(dp.level).name;

  dp.history.push({ reason, amount: delta, note, ts: Date.now() });
  if (dp.history.length > 20) dp.history.shift();

  const crossed = prevStage !== dp.stage;
  if (crossed) {
    console.log(`[drama] ${npcId}: ${prevStage} → ${dp.stage} (level ${dp.level})`);
  }

  return { level: dp.level, stage: dp.stage, crossed, prevStage };
}

/**
 * Convenience: reduce drama when player does something positive.
 */
function relieveDrama(npcId, reason) {
  return increaseDrama(npcId, reason);  // DRAMA_SOURCES has negative values for positive actions
}

// ─────────────────────────────────────────────
// CHECK DRAMA THRESHOLD
// Call after every interaction. Returns the current state.
// ─────────────────────────────────────────────

/**
 * @param {string} npcId
 * @returns {{ stage, level, shouldFire: boolean }}
 */
function checkDramaThreshold(npcId) {
  const dp = dramaPressure[npcId];
  if (!dp) return { stage: 'quiet', level: 0, shouldFire: false };
  return {
    stage:      dp.stage,
    level:      dp.level,
    shouldFire: dp.stage === 'drama' && (Date.now() - dp.lastEventAt) > 60000,
  };
}

// ─────────────────────────────────────────────
// TRIGGER DRAMA EVENT
// Fires a public confrontation — broadcast to all clients.
// Applies relationship and faction fallout.
// ─────────────────────────────────────────────

// Drama event templates by NPC — in-character flavour
const DRAMA_EVENTS = {
  lena:  (playerName) => `Lena storms into the square: "I have RECEIPTS, ${playerName}. This goes in print."`,
  orion: (playerName) => `Orion surfaces from his workshop, dishevelled: "You BROKE something important, ${playerName}!"`,
  mira:  (playerName) => `Mira sets down the coffee pot and looks at ${playerName} very, very calmly. The café goes silent.`,
  kai:   (playerName) => `Kai appears from nowhere: "I told you. I told you. And now everyone will know, ${playerName}."`,
  zara:  (playerName) => `Zara begins playing a very pointed song, eyes fixed on ${playerName}. It's clearly about them.`,
  bram:  (playerName) => `Bram puts his hand on his weapon: "HALT, ${playerName}. You are not leaving until we talk."`,
  ivy:   (playerName) => `Ivy pulls ${playerName} aside with iron gentleness: "Something has died here. Between us."`,
  juno:  (playerName) => `Juno blocks the road, arms crossed: "You and me. NOW. We settle this with a race or we settle it here."`,
  sol:   (playerName) => `Sol rises from his bench: "I've seen this before, ${playerName}. Sit down. We end this today."`,
  pix:   (playerName) => `Pix emits a piercing beep: "[ALERT] Integrity violation detected. ${playerName}: EXPLAIN."`,
};

/**
 * Fire a public drama event.
 * @param {string} npcId
 * @param {string} playerId
 * @param {string} playerName
 * @param {Function} broadcastFn  — server broadcast function
 * @returns {object} event payload
 */
function triggerDramaEvent(npcId, playerId, playerName, broadcastFn) {
  const dp = dramaPressure[npcId];
  if (!dp) return null;

  dp.lastEventAt = Date.now();
  dp.level       = Math.max(0, dp.level - 30); // event releases some pressure
  dp.stage       = getStageForLevel(dp.level).name;
  dp.history.push({ reason: 'drama_event_fired', amount: -30, note: `public drama with ${playerName}`, ts: Date.now() });

  const agent     = agents.find(a => a.id === npcId);
  const npcName   = agent?.name || npcId;
  const template  = DRAMA_EVENTS[npcId] || ((pn) => `${npcName} confronts ${pn} publicly!`);
  const message   = template(playerName);

  // Relationship and faction fallout
  updateRelationship(npcId, playerId, 'caused_scene');
  updateFactionRepFromNpc(npcId, playerId, -10);

  // Seed major gossip from this confrontation
  createGossip(npcId, playerId, playerName,
    `There was a public confrontation between ${npcName} and ${playerName} in the square`);

  const event = {
    type:     'drama_event',
    npcId,
    npcName,
    playerId,
    playerName,
    message,
    stage:    'drama',
    level:    dp.level,
  };

  if (broadcastFn) broadcastFn(event);
  console.log(`[drama] PUBLIC EVENT: ${npcName} vs ${playerName}`);
  return event;
}

// ─────────────────────────────────────────────
// GET DRAMA CONTEXT (for AI prompt)
// ─────────────────────────────────────────────

/**
 * Returns a prompt block reflecting this NPC's current drama state.
 * Higher drama → more guarded / confrontational tone guidance.
 */
function getDramaContext(npcId) {
  const dp = dramaPressure[npcId];
  if (!dp || dp.level < 25) return '';

  const stage = getStageForLevel(dp.level);
  const toneMap = {
    rumour:    'You have heard things about this player. You are slightly guarded.',
    suspicion: 'You suspect this player is not being fully honest. Your tone is clipped and watchful.',
    conflict:  'You are ready to confront this player. You are barely holding it together.',
    drama:     'You are at your limit. You will not let this pass without being said.',
  };

  return [
    `## DRAMA TENSION`,
    `Current tension level: ${stage.label} (${dp.level}/100)`,
    toneMap[dp.stage] || '',
    `This overrides your normal warmth — let the tension show in your reply.`,
  ].join('\n');
}

// ─────────────────────────────────────────────
// GET DRAMA SUMMARY (for client UI)
// ─────────────────────────────────────────────
function getDramaSummary(npcId) {
  const dp = dramaPressure[npcId];
  if (!dp) return { level: 0, stage: 'quiet', label: 'Quiet', color: '#556677' };
  const stageInfo = getStageForLevel(dp.level);
  return { level: dp.level, stage: dp.stage, label: stageInfo.label, color: stageInfo.color };
}

function getAllDramaLevels() {
  return Object.fromEntries(
    Object.entries(dramaPressure).map(([id, dp]) => [id, getDramaSummary(id)])
  );
}

// ─────────────────────────────────────────────
// AUTO-DECAY: drama slowly fades when nothing happens
// Call every real minute or game-hour.
// ─────────────────────────────────────────────
function decayDrama() {
  for (const [npcId, dp] of Object.entries(dramaPressure)) {
    if (dp.level > 0) {
      dp.level = Math.max(0, dp.level - 1); // slow bleed
      dp.stage = getStageForLevel(dp.level).name;
    }
  }
}

module.exports = {
  DRAMA_SOURCES,
  STAGES,
  increaseDrama,
  relieveDrama,
  checkDramaThreshold,
  triggerDramaEvent,
  getDramaContext,
  getDramaSummary,
  getAllDramaLevels,
  decayDrama,
  dramaPressure,
};
