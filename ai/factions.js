/**
 * factions.js — AI Faction System for Pixel Synapse
 *
 * NPCs belong to factions. Faction reputation is shared — being kind to
 * one café member improves your standing with all café members.
 * Each faction has a distinct ideology that shapes how members react.
 */

// ─────────────────────────────────────────────
// FACTION DEFINITIONS
// ─────────────────────────────────────────────
const FACTION_DEFS = {
  cafe: {
    name:      'The Café Circle',
    ideology:  'Community, warmth, gossip, and good coffee. They believe connection is everything.',
    members:   ['mira', 'sol', 'lena'],
    color:     '#E8A598',
    likes:     ['kindness', 'conversation', 'sharing'],
    dislikes:  ['rudeness', 'chaos', 'secrecy'],
  },
  hackers: {
    name:      'The Network',
    ideology:  'Information is power. They test everyone and trust no one easily.',
    members:   ['kai', 'orion', 'pix'],
    color:     '#00E5FF',
    likes:     ['intelligence', 'honesty', 'curiosity'],
    dislikes:  ['naivety', 'deception', 'authority'],
  },
  guards: {
    name:      'The Watch',
    ideology:  'Order, safety, and vigilance. The town must be protected from chaos.',
    members:   ['bram', 'juno'],
    color:     '#8D6E63',
    likes:     ['reliability', 'calm', 'respect'],
    dislikes:  ['chaos', 'liars', 'troublemakers'],
  },
  naturalists: {
    name:      'The Green',
    ideology:  'Growth, patience, and harmony. They see patterns in people like patterns in plants.',
    members:   ['ivy', 'zara'],
    color:     '#81C784',
    likes:     ['creativity', 'kindness', 'patience'],
    dislikes:  ['aggression', 'destruction', 'rushing'],
  },
};

// Reverse map: npcId → factionId
const NPC_FACTION = {};
for (const [fid, fdef] of Object.entries(FACTION_DEFS)) {
  for (const npcId of fdef.members) {
    NPC_FACTION[npcId] = fid;
  }
}

// ─────────────────────────────────────────────
// STORE
// factionRep[factionId][playerId] = number (-100 to +100)
// ─────────────────────────────────────────────
const factionRep = {};
for (const fid of Object.keys(FACTION_DEFS)) factionRep[fid] = {};

function clamp(v) { return Math.max(-100, Math.min(100, v)); }

function ensureFactionRep(factionId, playerId) {
  if (!factionRep[factionId]) factionRep[factionId] = {};
  if (factionRep[factionId][playerId] === undefined) factionRep[factionId][playerId] = 0;
}

// ─────────────────────────────────────────────
// UPDATE FACTION REPUTATION
// ─────────────────────────────────────────────
/**
 * Change a player's standing with a whole faction.
 * Also propagates a smaller echo to allied factions.
 *
 * @param {string} factionId
 * @param {string} playerId
 * @param {number} amount     positive = improve, negative = worsen
 * @param {number} [echo]     fraction propagated to allied factions (default 0.3)
 */
function updateFactionReputation(factionId, playerId, amount, echo = 0.3) {
  if (!FACTION_DEFS[factionId]) return;
  ensureFactionRep(factionId, playerId);
  factionRep[factionId][playerId] = clamp(factionRep[factionId][playerId] + amount);

  // Spread echo to other factions (weaker effect)
  // e.g. impressing the guards slightly impresses café members too
  const echoAmount = Math.round(amount * echo);
  if (echoAmount !== 0) {
    for (const otherId of Object.keys(FACTION_DEFS)) {
      if (otherId === factionId) continue;
      ensureFactionRep(otherId, playerId);
      factionRep[otherId][playerId] = clamp(factionRep[otherId][playerId] + echoAmount);
    }
  }
}

/**
 * Update faction rep when a player interacts with a specific NPC.
 * Auto-detects the NPC's faction and adjusts accordingly.
 */
function updateFactionRepFromNpc(npcId, playerId, amount) {
  const fid = NPC_FACTION[npcId];
  if (fid) updateFactionReputation(fid, playerId, amount);
}

// ─────────────────────────────────────────────
// GET FACTION REP
// ─────────────────────────────────────────────
function getFactionRep(factionId, playerId) {
  ensureFactionRep(factionId, playerId);
  return factionRep[factionId][playerId];
}

function getAllFactionReps(playerId) {
  const result = {};
  for (const fid of Object.keys(FACTION_DEFS)) {
    ensureFactionRep(fid, playerId);
    result[fid] = factionRep[fid][playerId];
  }
  return result;
}

function getNpcFaction(npcId) {
  return NPC_FACTION[npcId] || null;
}

// ─────────────────────────────────────────────
// FACTION STANDING LABEL
// ─────────────────────────────────────────────
function getFactionStanding(score) {
  if (score >= 70)  return { label: 'Champion',  color: '#44ff88' };
  if (score >= 40)  return { label: 'Respected',  color: '#aabbff' };
  if (score >= 10)  return { label: 'Friendly',   color: '#81c784' };
  if (score >= -10) return { label: 'Neutral',    color: '#888780' };
  if (score >= -40) return { label: 'Distrusted', color: '#ffaa44' };
  if (score >= -70) return { label: 'Hostile',    color: '#ff8844' };
  return                   { label: 'Enemy',      color: '#ff4444' };
}

// ─────────────────────────────────────────────
// PROMPT CONTEXT
// ─────────────────────────────────────────────
/**
 * Returns faction context for an NPC's prompt.
 * Tells the NPC their faction's opinion of this player
 * and how faction members would react.
 */
function getFactionContext(npcId, playerId) {
  const fid = NPC_FACTION[npcId];
  if (!fid) return '';

  const def   = FACTION_DEFS[fid];
  const score = getFactionRep(fid, playerId);
  const stand = getFactionStanding(score);

  const lines = [
    `## YOUR FACTION: ${def.name.toUpperCase()}`,
    `Ideology: ${def.ideology}`,
    `This player's standing with your faction: ${stand.label} (${score > 0 ? '+' : ''}${score})`,
    '',
  ];

  if (score >= 40) {
    lines.push(`Your faction speaks well of this player. You feel a baseline of goodwill.`);
  } else if (score >= 10) {
    lines.push(`Your faction has no strong opinion either way. You're open but neutral.`);
  } else if (score <= -40) {
    lines.push(`Your faction has serious reservations about this player. You're instinctively cautious.`);
  } else if (score <= -70) {
    lines.push(`Your faction considers this player an enemy. You are unfriendly, possibly openly hostile.`);
  }

  // List what the faction values, for flavour
  lines.push(`Your faction values: ${def.likes.join(', ')}. It dislikes: ${def.dislikes.join(', ')}.`);

  return lines.join('\n');
}

/**
 * Get all faction standings for a player — used for init/HUD.
 */
function getFactionSummary(playerId) {
  const result = {};
  for (const [fid, def] of Object.entries(FACTION_DEFS)) {
    const score = getFactionRep(fid, playerId);
    result[fid] = { name: def.name, color: def.color, score, ...getFactionStanding(score) };
  }
  return result;
}

module.exports = {
  FACTION_DEFS,
  NPC_FACTION,
  updateFactionReputation,
  updateFactionRepFromNpc,
  getFactionRep,
  getAllFactionReps,
  getNpcFaction,
  getFactionStanding,
  getFactionContext,
  getFactionSummary,
  factionRep, // exposed for event system
};
