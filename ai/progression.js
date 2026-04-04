/**
 * progression.js — XP & Level System for Pixel Synapse
 *
 * Players earn XP from every meaningful action. XP fills a bar;
 * when full the player levels up and optionally unlocks features.
 *
 * Three skill paths (player chooses emphasis through play):
 *   Social   — better relationships, persuasion, gossip resistance
 *   Economic — better job pay, shop discounts, market access
 *   Political — stronger vote influence, faction rep multiplier
 *
 * XP sources & amounts:
 *   Chatting with NPC          +5
 *   Completing a job           +20
 *   Buying an item             +3
 *   Discovering a secret       +50
 *   Influencing an NPC vote    +15
 *   Voting in an election      +10
 *   Resolving a drama event    +30
 *   Faction standing gain      +8
 */

// ─────────────────────────────────────────────
// LEVEL TABLE
// xpRequired = XP needed to reach this level FROM level - 1
// ─────────────────────────────────────────────
const LEVEL_TABLE = [
  { level: 1,  xpRequired: 0,    title: 'Newcomer',     color: '#888780' },
  { level: 2,  xpRequired: 100,  title: 'Acquaintance', color: '#aabbff' },
  { level: 3,  xpRequired: 250,  title: 'Regular',      color: '#44aaff' },
  { level: 4,  xpRequired: 500,  title: 'Friend',       color: '#44ff88' },
  { level: 5,  xpRequired: 1000, title: 'Trusted',      color: '#ffcc44' },
  { level: 6,  xpRequired: 2000, title: 'Influencer',   color: '#ff8844' },
  { level: 7,  xpRequired: 3500, title: 'Veteran',      color: '#ce93d8' },
  { level: 8,  xpRequired: 5500, title: 'Legend',       color: '#f06292' },
];

// ─────────────────────────────────────────────
// UNLOCKS BY LEVEL
// ─────────────────────────────────────────────
const LEVEL_UNLOCKS = {
  2: { feature: 'persuasion_basic',  label: 'Persuasion I',       desc: 'Unlock NPC vote influence'            },
  3: { feature: 'better_jobs',       label: 'Better Work',        desc: '+20% job pay'                         },
  4: { feature: 'gossip_source',     label: 'Gossip Network',     desc: 'NPCs share more gossip with you'      },
  5: { feature: 'shop_discount',     label: 'Loyal Customer',     desc: '10% off all shop prices'              },
  6: { feature: 'persuasion_adv',   label: 'Persuasion II',      desc: 'Double vote influence chance'         },
  7: { feature: 'secret_sense',     label: 'Secret Sense',       desc: 'NPC secrets trigger at lower thresholds' },
  8: { feature: 'faction_champion', label: 'Faction Champion',   desc: '+50% faction reputation gains'        },
};

// ─────────────────────────────────────────────
// XP REWARDS TABLE
// ─────────────────────────────────────────────
const XP_REWARDS = {
  npc_chat:            5,
  job_complete:        20,
  shop_purchase:       3,
  secret_discovered:   50,
  vote_cast:           10,
  vote_influenced:     15,
  drama_resolved:      30,
  faction_gain:        8,
  relationship_milestone: 25,
  first_meeting:       10,
};

// ─────────────────────────────────────────────
// STORE
// progressions[playerId] = { xp, level, xpToNext, unlocks, history, skillPoints }
// ─────────────────────────────────────────────
const progressions = {};

function ensureProgress(playerId) {
  if (!progressions[playerId]) {
    progressions[playerId] = {
      xp:          0,
      level:       1,
      xpToNext:    LEVEL_TABLE[1]?.xpRequired || 100,
      xpThisLevel: 0,           // XP earned since last level-up
      unlocks:     new Set(),   // feature keys
      history:     [],
      skillPoints: 0,
      skills:      { social: 0, economic: 0, political: 0 },
    };
  }
}

function getProgress(playerId) {
  ensureProgress(playerId);
  const p = progressions[playerId];
  return {
    xp:          p.xp,
    level:       p.level,
    xpToNext:    p.xpToNext,
    xpThisLevel: p.xpThisLevel,
    xpPct:       p.xpToNext > 0 ? Math.round((p.xpThisLevel / p.xpToNext) * 100) : 100,
    title:       LEVEL_TABLE.find(l => l.level === p.level)?.title || 'Newcomer',
    color:       LEVEL_TABLE.find(l => l.level === p.level)?.color || '#888780',
    unlocks:     [...p.unlocks],
    skills:      { ...p.skills },
    skillPoints: p.skillPoints,
  };
}

function hasUnlock(playerId, feature) {
  ensureProgress(playerId);
  return progressions[playerId].unlocks.has(feature);
}

// ─────────────────────────────────────────────
// ADD XP
// Returns { newLevel, leveledUp, newUnlocks, xpPct }
// ─────────────────────────────────────────────

/**
 * Award XP to a player.
 * @param {string} playerId
 * @param {string} reason    — key from XP_REWARDS or 'custom'
 * @param {number} [amount]  — override default
 * @returns {{ xp, level, leveledUp, newUnlocks, xpPct, title, color }}
 */
function addXP(playerId, reason, amount) {
  ensureProgress(playerId);
  const p      = progressions[playerId];
  const earned = amount ?? (XP_REWARDS[reason] ?? 5);

  p.xp          += earned;
  p.xpThisLevel += earned;
  p.history.push({ reason, amount: earned, ts: Date.now() });
  if (p.history.length > 50) p.history.shift();

  // Check for level-up
  const leveledUpData = [];
  let continueChecking = true;
  while (continueChecking) {
    const nextLevel = LEVEL_TABLE.find(l => l.level === p.level + 1);
    if (nextLevel && p.xpThisLevel >= nextLevel.xpRequired) {
      p.xpThisLevel -= nextLevel.xpRequired;
      p.level++;
      p.xpToNext = LEVEL_TABLE.find(l => l.level === p.level + 1)?.xpRequired || 0;
      p.skillPoints++;

      // Apply unlock if this level has one
      const unlock = LEVEL_UNLOCKS[p.level];
      const newUnlocks = [];
      if (unlock) {
        p.unlocks.add(unlock.feature);
        newUnlocks.push(unlock);
        console.log(`[progression] ${playerId} unlocked: ${unlock.label} at level ${p.level}`);
      }

      leveledUpData.push({ level: p.level, unlocks: newUnlocks });
      console.log(`[progression] ${playerId} → Level ${p.level} (${LEVEL_TABLE.find(l=>l.level===p.level)?.title})`);
    } else {
      continueChecking = false;
    }
  }

  const info = LEVEL_TABLE.find(l => l.level === p.level) || LEVEL_TABLE[0];
  return {
    xp:         p.xp,
    level:      p.level,
    xpThisLevel:p.xpThisLevel,
    xpToNext:   p.xpToNext,
    xpPct:      p.xpToNext > 0 ? Math.round((p.xpThisLevel / p.xpToNext) * 100) : 100,
    title:      info.title,
    color:      info.color,
    leveledUp:  leveledUpData.length > 0,
    newLevels:  leveledUpData,
    earned,
  };
}

// ─────────────────────────────────────────────
// SKILL INVESTMENT
// Player can spend skill points into paths
// ─────────────────────────────────────────────
function investSkill(playerId, path) {
  ensureProgress(playerId);
  const p = progressions[playerId];
  if (!['social', 'economic', 'political'].includes(path)) return { ok: false, error: 'invalid path' };
  if (p.skillPoints < 1) return { ok: false, error: 'no skill points' };
  p.skillPoints--;
  p.skills[path]++;
  console.log(`[progression] ${playerId} invested in ${path} (now ${p.skills[path]})`);
  return { ok: true, path, value: p.skills[path] };
}

// ─────────────────────────────────────────────
// SKILL MODIFIERS
// Used by other systems to adjust values based on skill path
// ─────────────────────────────────────────────

/** Pay multiplier from economic skill */
function getEconomicBonus(playerId) {
  ensureProgress(playerId);
  const eco = progressions[playerId].skills.economic;
  return 1 + eco * 0.1; // +10% per point
}

/** Shop price discount from economic skill */
function getShopDiscount(playerId) {
  const base = hasUnlock(playerId, 'shop_discount') ? 0.10 : 0;
  const eco  = progressions[playerId]?.skills?.economic || 0;
  return base + eco * 0.02; // 2% per economic skill point
}

/** Vote influence multiplier from political skill */
function getPoliticalBonus(playerId) {
  ensureProgress(playerId);
  const pol = progressions[playerId].skills.political;
  const adv = hasUnlock(playerId, 'persuasion_adv') ? 2 : hasUnlock(playerId, 'persuasion_basic') ? 1 : 0;
  return (1 + pol * 0.15) * (adv > 0 ? 1 + adv * 0.3 : 1);
}

/** Relationship bonus from social skill */
function getSocialBonus(playerId) {
  ensureProgress(playerId);
  const soc = progressions[playerId].skills.social;
  return soc * 2; // +2 to all relationship deltas per social skill point
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────
module.exports = {
  LEVEL_TABLE,
  LEVEL_UNLOCKS,
  XP_REWARDS,
  addXP,
  getProgress,
  hasUnlock,
  investSkill,
  getEconomicBonus,
  getShopDiscount,
  getPoliticalBonus,
  getSocialBonus,
  progressions,
};
