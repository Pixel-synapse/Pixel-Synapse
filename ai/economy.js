/**
 * economy.js — Economy System for Pixel Synapse
 *
 * Simple but dynamic economy:
 *   - Players earn coins via jobs
 *   - NPCs run shops with dynamic prices
 *   - Prices respond to demand and politics
 *   - Economy affects NPC dialogue and relationships
 *
 * Currency: coins (integer, no fractional)
 */

const agents = require('./agents.json');
const { createGossip } = require('./gossip');
const { updateRelationship } = require('./relationships');

// ─────────────────────────────────────────────
// PLAYER WALLETS
// ─────────────────────────────────────────────
const wallets = {}; // playerId → { coins, earnedTotal, spentTotal, jobHistory }

function ensureWallet(playerId) {
  if (!wallets[playerId]) {
    wallets[playerId] = { coins: 50, earnedTotal: 0, spentTotal: 0, jobHistory: [] };
  }
}

function getBalance(playerId) {
  ensureWallet(playerId);
  return wallets[playerId].coins;
}

function addCoins(playerId, amount, reason = '') {
  ensureWallet(playerId);
  wallets[playerId].coins       += Math.round(amount);
  wallets[playerId].earnedTotal += Math.round(Math.max(0, amount));
  return wallets[playerId].coins;
}

function deductCoins(playerId, amount) {
  ensureWallet(playerId);
  const actual = Math.min(amount, wallets[playerId].coins);
  wallets[playerId].coins     -= actual;
  wallets[playerId].spentTotal += actual;
  return actual;
}

// ─────────────────────────────────────────────
// SHOP CATALOGUE
// Each NPC that runs a shop has items with base prices.
// ─────────────────────────────────────────────
const SHOPS = {
  mira: {
    npcId:    'mira',
    name:     "Mira's Café",
    items: [
      { id: 'coffee',     name: 'Coffee',          basePrice: 5,  demand: 0, stock: 99 },
      { id: 'pastry',     name: 'Pastry',           basePrice: 8,  demand: 0, stock: 20 },
      { id: 'gossip_tip', name: 'Gossip Tip',       basePrice: 15, demand: 0, stock: 5  },
      { id: 'kind_words', name: 'Kind Word (+rep)', basePrice: 12, demand: 0, stock: 99 },
    ],
    politicsModifier: 1.0,
  },
  orion: {
    npcId:    'orion',
    name:     "Orion's Workshop",
    items: [
      { id: 'gadget',       name: 'Mystery Gadget',     basePrice: 30, demand: 0, stock: 3  },
      { id: 'blueprint',    name: 'Blueprint Fragment',  basePrice: 20, demand: 0, stock: 8  },
      { id: 'component',    name: 'Spare Component',     basePrice: 10, demand: 0, stock: 15 },
    ],
    politicsModifier: 1.0,
  },
  ivy: {
    npcId:    'ivy',
    name:     "Ivy's Garden Stall",
    items: [
      { id: 'seed',       name: 'Rare Seed',         basePrice: 8,  demand: 0, stock: 10 },
      { id: 'herb',       name: 'Healing Herb',       basePrice: 12, demand: 0, stock: 15 },
      { id: 'flower',     name: 'Pressed Flower',     basePrice: 6,  demand: 0, stock: 20 },
    ],
    politicsModifier: 1.0,
  },
  zara: {
    npcId:    'zara',
    name:     "Zara's Busking Corner",
    items: [
      { id: 'song_request', name: 'Song Request',        basePrice: 10, demand: 0, stock: 99 },
      { id: 'sheet_music',  name: 'Sheet Music',         basePrice: 18, demand: 0, stock: 5  },
      { id: 'inspiration',  name: 'Inspiration (+mood)', basePrice: 8,  demand: 0, stock: 99 },
    ],
    politicsModifier: 1.0,
  },
};

// ─────────────────────────────────────────────
// DYNAMIC PRICING
// Price = basePrice × (1 + demand * 0.1) × politicsModifier
// Demand increases when bought, slowly decays back to 0.
// ─────────────────────────────────────────────
const DEMAND_DECAY_RATE = 0.05; // per game hour

function getCurrentPrice(shopId, itemId) {
  const shop = SHOPS[shopId];
  if (!shop) return null;
  const item = shop.items.find(i => i.id === itemId);
  if (!item) return null;
  const price = Math.round(item.basePrice * (1 + item.demand * 0.1) * shop.politicsModifier);
  return Math.max(1, price);
}

function tickDemandDecay() {
  for (const shop of Object.values(SHOPS)) {
    for (const item of shop.items) {
      item.demand = Math.max(0, item.demand - DEMAND_DECAY_RATE);
    }
  }
}

/**
 * Called by politics.js when an election result modifies the economy.
 * @param {number} modifier  e.g. +0.15 or -0.10
 * @param {string} reason
 */
function applyPoliticsModifier(modifier, reason) {
  for (const shop of Object.values(SHOPS)) {
    shop.politicsModifier = Math.max(0.5, Math.min(2.0,
      shop.politicsModifier + modifier
    ));
  }
  console.log(`[economy] Politics modifier applied: ${modifier > 0 ? '+' : ''}${modifier} — "${reason}"`);
}

// ─────────────────────────────────────────────
// BUY ITEM
// ─────────────────────────────────────────────

/**
 * Player buys an item from an NPC shop.
 *
 * @returns {{ ok, item, price, balance, error, relationship_bonus }}
 */
function buyItem(playerId, playerName, shopId, itemId) {
  ensureWallet(playerId);
  const shop = SHOPS[shopId];
  if (!shop) return { ok: false, error: 'Shop not found' };

  const item = shop.items.find(i => i.id === itemId);
  if (!item) return { ok: false, error: 'Item not found' };
  if (item.stock <= 0) return { ok: false, error: 'Out of stock' };

  const price = getCurrentPrice(shopId, itemId);
  if (wallets[playerId].coins < price) {
    return { ok: false, error: `Not enough coins (need ${price}, have ${wallets[playerId].coins})` };
  }

  // Deduct coins
  deductCoins(playerId, price);

  // Update stock and demand
  if (item.stock !== 99) item.stock = Math.max(0, item.stock - 1);
  item.demand = Math.min(10, item.demand + 0.5);

  // Relationship bonus — buying from an NPC improves friendship slightly
  const relBonus = itemId === 'gossip_tip' ? 'shared_secret' : 'helped';
  updateRelationship(shop.npcId, playerId, relBonus);

  // Special item effects
  const effect = _applyItemEffect(itemId, playerId, playerName, shop.npcId);

  console.log(`[economy] ${playerName} bought "${item.name}" from ${shop.name} for ${price} coins`);

  return {
    ok:           true,
    item:         item.name,
    itemId,
    price,
    balance:      wallets[playerId].coins,
    effect,
    relationship_bonus: relBonus,
  };
}

function _applyItemEffect(itemId, playerId, playerName, npcId) {
  switch (itemId) {
    case 'gossip_tip':
      // NPC shares a piece of gossip with the player
      return { type: 'gossip', message: 'The NPC leans in and shares something they heard.' };
    case 'kind_words':
      updateRelationship(npcId, playerId, 'complimented');
      return { type: 'reputation', message: 'The kind words warm the town\'s opinion of you.' };
    case 'inspiration':
      return { type: 'mood_boost', message: 'You feel inspired.' };
    case 'gadget':
      createGossip(npcId, playerId, playerName, `${playerName} bought one of Orion's mysterious gadgets`);
      return { type: 'item', message: 'The gadget hums oddly. You\'re not sure what it does.' };
    default:
      return { type: 'item', message: `You received ${itemId}.` };
  }
}

// ─────────────────────────────────────────────
// JOBS
// Players can do small jobs for NPCs to earn coins.
// ─────────────────────────────────────────────
const JOBS = {
  mira: [
    { id: 'serve_coffee', name: 'Help serve coffee', pay: 8,  cooldownMinutes: 30, requiresFriendship: 0 },
    { id: 'clean_cafe',   name: 'Clean the café',    pay: 5,  cooldownMinutes: 20, requiresFriendship: 0 },
    { id: 'deliver_msg',  name: 'Deliver a message', pay: 12, cooldownMinutes: 60, requiresFriendship: 20 },
  ],
  orion: [
    { id: 'fetch_parts',  name: 'Fetch workshop parts', pay: 10, cooldownMinutes: 45, requiresFriendship: 0 },
    { id: 'test_gadget',  name: 'Test a gadget',         pay: 20, cooldownMinutes: 90, requiresFriendship: 30 },
  ],
  bram: [
    { id: 'patrol_west',  name: 'Help patrol the west gate', pay: 15, cooldownMinutes: 60, requiresFriendship: 10 },
    { id: 'report_odd',   name: 'Report anything odd',       pay: 6,  cooldownMinutes: 20, requiresFriendship: 0  },
  ],
  ivy: [
    { id: 'water_plants', name: 'Water the garden',     pay: 7,  cooldownMinutes: 30, requiresFriendship: 0 },
    { id: 'gather_seeds', name: 'Gather seeds from park', pay: 10, cooldownMinutes: 45, requiresFriendship: 15 },
  ],
};

// Track cooldowns: jobCooldowns[playerId][`${npcId}:${jobId}`] = gameMinuteUnlockAt
const jobCooldowns = {};

/**
 * Player earns money by doing a job for an NPC.
 *
 * @param {string} playerId
 * @param {string} playerName
 * @param {string} npcId
 * @param {string} jobId
 * @param {number} gameMinute    current game minute
 * @param {object} relationship  current relationship object
 * @returns {{ ok, earned, balance, error }}
 */
function earnMoney(playerId, playerName, npcId, jobId, gameMinute, relationship) {
  ensureWallet(playerId);

  const jobs = JOBS[npcId];
  if (!jobs) return { ok: false, error: 'This NPC has no jobs available.' };

  const job = jobs.find(j => j.id === jobId);
  if (!job) return { ok: false, error: 'Job not found.' };

  // Check friendship requirement
  const friendship = relationship?.friendship || 0;
  if (friendship < job.requiresFriendship) {
    return { ok: false, error: `You need at least ${job.requiresFriendship} friendship with this NPC.` };
  }

  // Check cooldown
  if (!jobCooldowns[playerId]) jobCooldowns[playerId] = {};
  const cdKey = `${npcId}:${jobId}`;
  const unlockAt = jobCooldowns[playerId][cdKey] || 0;
  if (gameMinute < unlockAt) {
    return { ok: false, error: `Job not available yet (${unlockAt - gameMinute} minutes remaining).` };
  }

  // Pay and set cooldown
  const earned = job.pay;
  addCoins(playerId, earned, `completed job: ${job.name}`);
  jobCooldowns[playerId][cdKey] = gameMinute + job.cooldownMinutes;

  wallets[playerId].jobHistory.push({
    npcId, jobId, jobName: job.name,
    earned, gameMinute,
  });
  if (wallets[playerId].jobHistory.length > 20) wallets[playerId].jobHistory.shift();

  // Slight relationship boost for working
  updateRelationship(npcId, playerId, 'helped');

  console.log(`[economy] ${playerName} earned ${earned} coins from "${job.name}" for ${npcId}`);

  return { ok: true, earned, balance: wallets[playerId].coins, jobName: job.name };
}

// ─────────────────────────────────────────────
// ECONOMY CONTEXT FOR PROMPTS
// ─────────────────────────────────────────────

/**
 * Returns a short economy context for NPC prompts.
 * NPCs are aware of their shop performance and town economy.
 */
function getEconomyContext(npcId, playerId) {
  const shop = SHOPS[npcId];
  const wallet = wallets[playerId];
  const lines = [];

  if (shop) {
    const highDemandItems = shop.items.filter(i => i.demand > 3).map(i => i.name);
    if (highDemandItems.length > 0) {
      lines.push(`## SHOP CONTEXT\nYour shop is busy. "${highDemandItems[0]}" is in high demand right now.`);
    }
    if (shop.politicsModifier < 0.9) {
      lines.push(`Recent politics have hurt prices at your shop. You're a bit worried about business.`);
    } else if (shop.politicsModifier > 1.15) {
      lines.push(`Business is booming since the last town vote.`);
    }
  }

  if (wallet) {
    if (wallet.coins < 10) {
      lines.push(`This player looks like they're short on coins — they might need a job.`);
    } else if (wallet.coins > 100) {
      lines.push(`This player seems to be doing well financially.`);
    }
  }

  return lines.join('\n');
}

/**
 * Get wallet summary for client display.
 */
function getWalletSummary(playerId) {
  ensureWallet(playerId);
  const w = wallets[playerId];
  return { coins: w.coins, earnedTotal: w.earnedTotal, spentTotal: w.spentTotal };
}

/**
 * Get shop data for client display.
 */
function getShopData(shopId) {
  const shop = SHOPS[shopId];
  if (!shop) return null;
  return {
    ...shop,
    items: shop.items.map(item => ({
      ...item,
      currentPrice: getCurrentPrice(shopId, item.id),
    })),
  };
}

function getAllShops() {
  return Object.entries(SHOPS).map(([id, shop]) => ({
    id,
    name:  shop.name,
    npcId: shop.npcId,
    items: shop.items.map(item => ({
      ...item,
      currentPrice: getCurrentPrice(id, item.id),
    })),
  }));
}

function getAvailableJobs(npcId, playerId, gameMinute, relationship) {
  const jobs = JOBS[npcId] || [];
  const friendship = relationship?.friendship || 0;
  return jobs.map(job => {
    const cdKey = `${npcId}:${job.id}`;
    const unlockAt = jobCooldowns[playerId]?.[cdKey] || 0;
    return {
      ...job,
      available:    friendship >= job.requiresFriendship && gameMinute >= unlockAt,
      cooldownLeft: Math.max(0, unlockAt - gameMinute),
    };
  });
}

module.exports = {
  SHOPS,
  JOBS,
  getBalance,
  addCoins,
  deductCoins,
  buyItem,
  earnMoney,
  applyPoliticsModifier,
  tickDemandDecay,
  getEconomyContext,
  getWalletSummary,
  getShopData,
  getAllShops,
  getAvailableJobs,
  wallets,
};
