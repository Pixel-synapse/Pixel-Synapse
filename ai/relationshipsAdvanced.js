/**
 * relationshipsAdvanced.js — Breakups & Betrayal System
 *
 * Extends relationships.js with collapse mechanics.
 * Relationships can degrade through betrayal, gossip, faction conflict,
 * or simple neglect. States shift: friend→neutral→enemy, lover→breakup→enemy.
 *
 * Breakup/betrayal events:
 *   - Broadcast to clients (dramatic dialogue shift)
 *   - Seed major gossip
 *   - Shift faction opinions
 *   - Affect other NPCs who witness it
 */

const { relationships, updateRelationship, adjustAllRelationships } = require('./relationships');
const { updateFactionReputation, NPC_FACTION }                       = require('./factions');
const { createGossip }                                               = require('./gossip');
const agents = require('./agents.json');

// ─────────────────────────────────────────────
// COLLAPSE THRESHOLDS
// ─────────────────────────────────────────────
const BREAKUP_THRESHOLDS = {
  // Romantic collapse
  loverBreakup: { romance: 15, trust: 20 },     // romance+trust both low → breakup
  // Friendship collapse
  friendFall:   { friendship: 15, trust: 15 },  // both low → enemy
  // Fear-driven rupture
  fearRupture:  { fear: 70 },                   // extreme fear → flee/hostile
  // Betrayal detection (one-shot trigger)
  betrayal:     { trust: 10 },                  // trust collapses → betrayal event
};

// Track which relationship states have already triggered collapse
// to avoid repeat events: `${npcId}:${playerId}:${eventType}`
const _triggeredEvents = new Set();

// ─────────────────────────────────────────────
// EVALUATE RELATIONSHIP SHIFT
// Check whether a relationship should collapse.
// Returns { shift: 'breakup'|'betrayal'|'enemy'|'fear_rupture'|null, reason }
// ─────────────────────────────────────────────

/**
 * Assess whether a relationship should collapse.
 * Does NOT apply the collapse — just evaluates.
 *
 * @param {string} npcId
 * @param {string} playerId
 * @returns {{ shift: string|null, reason: string }}
 */
function evaluateRelationshipShift(npcId, playerId) {
  const rel = relationships[npcId]?.[playerId];
  if (!rel) return { shift: null, reason: 'no_relationship' };

  const key = (type) => `${npcId}:${playerId}:${type}`;

  // Fear rupture — highest priority
  if (rel.fear >= BREAKUP_THRESHOLDS.fearRupture.fear && !_triggeredEvents.has(key('fear_rupture'))) {
    return { shift: 'fear_rupture', reason: `fear ${rel.fear} exceeded threshold` };
  }

  // Betrayal — trust collapse
  if (rel.trust <= BREAKUP_THRESHOLDS.betrayal.trust && rel.friendship >= 30 && !_triggeredEvents.has(key('betrayal'))) {
    return { shift: 'betrayal', reason: `trust ${rel.trust} collapsed despite established relationship` };
  }

  // Romantic breakup
  if (rel.romance >= 20 &&
      rel.romance <= BREAKUP_THRESHOLDS.loverBreakup.romance &&
      rel.trust   <= BREAKUP_THRESHOLDS.loverBreakup.trust &&
      !_triggeredEvents.has(key('breakup'))) {
    return { shift: 'breakup', reason: 'romance and trust both collapsed' };
  }

  // Friendship collapse
  if (rel.friendship <= BREAKUP_THRESHOLDS.friendFall.friendship &&
      rel.trust      <= BREAKUP_THRESHOLDS.friendFall.trust &&
      !_triggeredEvents.has(key('friend_fall'))) {
    return { shift: 'enemy', reason: 'friendship and trust both collapsed' };
  }

  return { shift: null, reason: 'stable' };
}

// ─────────────────────────────────────────────
// TRIGGER BREAKUP
// Romantic relationship ends. Bitterness follows.
// ─────────────────────────────────────────────

/**
 * Trigger a romantic breakup between NPC and player.
 * @returns {{ message: string, effects: object }}
 */
function triggerBreakup(npcId, playerId, playerName, broadcastFn) {
  const key = `${npcId}:${playerId}:breakup`;
  _triggeredEvents.add(key);

  const rel = relationships[npcId]?.[playerId];
  if (rel) {
    rel.romance    = 0;
    rel.friendship = Math.max(0, rel.friendship - 20);
    rel.fear       = Math.min(100, rel.fear + 10);
  }

  const npcName = agents.find(a => a.id === npcId)?.name || npcId;

  // Seed major gossip
  createGossip(npcId, playerId, playerName,
    `${npcName} and ${playerName} broke up — it was painful to witness`);

  // Hit their faction standing
  const fid = NPC_FACTION[npcId];
  if (fid) updateFactionReputation(fid, playerId, -15);

  // Other NPCs in same faction lose a little warmth toward the player
  const allies = agents.filter(a => NPC_FACTION[a.id] === fid && a.id !== npcId);
  allies.forEach(ally => {
    updateRelationship(ally.id, playerId, 'caused_scene');
  });

  const event = {
    type:      'relationship_collapse',
    subtype:   'breakup',
    npcId,
    npcName,
    playerId,
    message:   `${npcName} ended things with ${playerName}.`,
  };

  if (broadcastFn) broadcastFn(event);
  console.log(`[breakup] ${npcName} ↔ ${playerName}`);
  return event;
}

// ─────────────────────────────────────────────
// TRIGGER BETRAYAL
// Trust collapses — NPC feels deceived and turns hostile.
// ─────────────────────────────────────────────

/**
 * Trigger a betrayal event.
 * The NPC feels deceived — relationship turns antagonistic.
 */
function triggerBetrayal(npcId, playerId, playerName, reason, broadcastFn) {
  const key = `${npcId}:${playerId}:betrayal`;
  _triggeredEvents.add(key);

  const rel = relationships[npcId]?.[playerId];
  if (rel) {
    rel.trust      = 0;
    rel.friendship = Math.max(0, rel.friendship - 30);
    rel.fear       = Math.min(100, rel.fear + 20);
    // If they were lovers, it's now also a breakup
    if (rel.romance > 20) {
      rel.romance = 5;
      _triggeredEvents.add(`${npcId}:${playerId}:breakup`);
    }
  }

  const npcName = agents.find(a => a.id === npcId)?.name || npcId;

  // Major gossip — betrayals spread fast
  createGossip(npcId, playerId, playerName,
    `${npcName} was betrayed by ${playerName} — ${reason || 'the trust was broken'}`);

  // Faction-wide opinion drop
  const fid = NPC_FACTION[npcId];
  if (fid) updateFactionReputation(fid, playerId, -25);

  // All NPCs in same faction slightly affected
  const allies = agents.filter(a => NPC_FACTION[a.id] === fid && a.id !== npcId);
  allies.forEach(ally => {
    if (relationships[ally.id]?.[playerId]) {
      relationships[ally.id][playerId].trust = Math.max(0,
        (relationships[ally.id][playerId].trust || 20) - 15);
    }
  });

  const event = {
    type:    'relationship_collapse',
    subtype: 'betrayal',
    npcId,
    npcName,
    playerId,
    reason,
    message: `${npcName} feels betrayed by ${playerName}.`,
  };

  if (broadcastFn) broadcastFn(event);
  console.log(`[betrayal] ${npcName} ↦ ${playerName}: ${reason}`);
  return event;
}

// ─────────────────────────────────────────────
// TRIGGER FEAR RUPTURE
// NPC is so afraid they become hostile and avoidant.
// ─────────────────────────────────────────────
function triggerFearRupture(npcId, playerId, playerName, broadcastFn) {
  const key = `${npcId}:${playerId}:fear_rupture`;
  _triggeredEvents.add(key);

  const rel = relationships[npcId]?.[playerId];
  if (rel) {
    rel.friendship = Math.max(0, rel.friendship - 25);
    rel.trust      = Math.max(0, rel.trust - 20);
  }

  const npcName = agents.find(a => a.id === npcId)?.name || npcId;
  createGossip(npcId, playerId, playerName,
    `${npcName} is genuinely afraid of ${playerName} — something went very wrong`);

  const event = {
    type:    'relationship_collapse',
    subtype: 'fear_rupture',
    npcId, npcName, playerId,
    message: `${npcName} has become afraid of and hostile toward ${playerName}.`,
  };

  if (broadcastFn) broadcastFn(event);
  return event;
}

// ─────────────────────────────────────────────
// FULL EVALUATION + AUTO-TRIGGER
// Call this after every significant interaction.
// Returns the event if something collapsed, else null.
// ─────────────────────────────────────────────

/**
 * Evaluate and auto-trigger any relationship collapse for this pair.
 * @returns {object|null} collapse event, or null
 */
function checkAndTriggerCollapse(npcId, playerId, playerName, broadcastFn) {
  const { shift } = evaluateRelationshipShift(npcId, playerId);

  switch (shift) {
    case 'breakup':      return triggerBreakup(npcId, playerId, playerName, broadcastFn);
    case 'betrayal':     return triggerBetrayal(npcId, playerId, playerName, 'trust collapsed', broadcastFn);
    case 'fear_rupture': return triggerFearRupture(npcId, playerId, playerName, broadcastFn);
    case 'enemy': {
      // Quiet drift to enemy — no dramatic event, just update and log
      const key = `${npcId}:${playerId}:friend_fall`;
      _triggeredEvents.add(key);
      const npcName = agents.find(a => a.id === npcId)?.name || npcId;
      createGossip(npcId, playerId, playerName,
        `${npcName} no longer considers ${playerName} a friend`);
      const event = { type: 'relationship_collapse', subtype: 'enemy', npcId, playerId,
        message: `${npcName} now considers ${playerName} an enemy.` };
      if (broadcastFn) broadcastFn(event);
      return event;
    }
    default: return null;
  }
}

/**
 * Get a relationship collapse context string for the prompt.
 * If a collapse has happened, the NPC should be cold/hostile.
 */
function getCollapseContext(npcId, playerId) {
  const collapsed = [
    `${npcId}:${playerId}:breakup`,
    `${npcId}:${playerId}:betrayal`,
    `${npcId}:${playerId}:friend_fall`,
    `${npcId}:${playerId}:fear_rupture`,
  ].filter(k => _triggeredEvents.has(k));

  if (collapsed.length === 0) return '';

  const type = collapsed[collapsed.length - 1].split(':')[2];
  const toneMap = {
    breakup:      'Your romantic relationship with this player ended badly. You are hurt and cold.',
    betrayal:     'This player betrayed your trust. You are hostile, guarded, and deeply hurt.',
    friend_fall:  'You no longer consider this player a friend. You are civil but detached and wary.',
    fear_rupture: 'You are frightened of this player. Keep distance. Short answers. Do not trust them.',
  };

  return `## RELATIONSHIP RUPTURE\n${toneMap[type] || 'Your relationship with this player has collapsed.'}`;
}

module.exports = {
  evaluateRelationshipShift,
  triggerBreakup,
  triggerBetrayal,
  triggerFearRupture,
  checkAndTriggerCollapse,
  getCollapseContext,
};
