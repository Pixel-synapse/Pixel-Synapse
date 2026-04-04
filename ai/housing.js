/**
 * housing.js — Player Housing System for Pixel Synapse
 *
 * Each player gets a house instance with:
 *   - A 10×8 grid for item placement (world coords mapped to grid slots)
 *   - A visitor log (NPCs that have visited)
 *   - House "warmth" score that affects NPC willingness to visit
 *
 * NPC visits happen on a timer — NPCs with high friendship toward a player
 * will occasionally path to that player's house.
 */

const { getRelationship } = require('./relationships');
const agents = require('./agents.json');

// ─────────────────────────────────────────────
// GRID CONFIG
// ─────────────────────────────────────────────
const GRID_W = 10;
const GRID_H = 8;

// World-space coordinates for each player's house entrance
// Players are assigned a house slot on first connection
const HOUSE_SLOTS = [
  { x: 160, y: 700 },
  { x: 240, y: 700 },
  { x: 320, y: 700 },
  { x: 480, y: 700 },
  { x: 560, y: 700 },
  { x: 640, y: 700 },
];
let _nextSlot = 0;

// ─────────────────────────────────────────────
// AVAILABLE ITEMS
// ─────────────────────────────────────────────
const ITEM_CATALOG = {
  chair:     { label: 'Chair',       warmth: 2, w: 1, h: 1 },
  table:     { label: 'Table',       warmth: 3, w: 2, h: 1 },
  plant:     { label: 'Plant',       warmth: 4, w: 1, h: 1 },
  bookshelf: { label: 'Bookshelf',   warmth: 5, w: 1, h: 2 },
  rug:       { label: 'Cozy Rug',    warmth: 6, w: 2, h: 2 },
  lamp:      { label: 'Warm Lamp',   warmth: 3, w: 1, h: 1 },
  painting:  { label: 'Painting',    warmth: 5, w: 2, h: 1 },
  fireplace: { label: 'Fireplace',   warmth: 10, w: 2, h: 2 },
};

// ─────────────────────────────────────────────
// STORE
// houses[playerId] = { worldX, worldY, grid, items, visitors, warmth, inside }
// ─────────────────────────────────────────────
const houses = {};

function ensureHouse(playerId) {
  if (!houses[playerId]) {
    const slot = HOUSE_SLOTS[_nextSlot % HOUSE_SLOTS.length];
    _nextSlot++;
    houses[playerId] = {
      worldX:   slot.x,
      worldY:   slot.y,
      grid:     Array.from({ length: GRID_H }, () => Array(GRID_W).fill(null)),
      items:    [],      // [{ id, itemType, gridX, gridY }]
      visitors: [],      // [{ npcId, arrivedAt, leftAt }]
      warmth:   10,      // starts cold, grows with placed items
      inside:   false,   // is the player currently inside?
      insideNpcs: [],    // npcIds currently visiting
    };
  }
  return houses[playerId];
}

function recalcWarmth(playerId) {
  const house = houses[playerId];
  if (!house) return;
  let w = 5; // base
  for (const item of house.items) {
    const def = ITEM_CATALOG[item.itemType];
    if (def) w += def.warmth;
  }
  house.warmth = Math.min(100, w);
}

// ─────────────────────────────────────────────
// ENTER / EXIT HOUSE
// ─────────────────────────────────────────────
function enterHouse(playerId) {
  const house = ensureHouse(playerId);
  house.inside = true;
  return {
    ok: true,
    house: { worldX: house.worldX, worldY: house.worldY, warmth: house.warmth, items: house.items, insideNpcs: house.insideNpcs },
  };
}

function exitHouse(playerId) {
  const house = ensureHouse(playerId);
  house.inside = false;
  // NPCs that were visiting leave when the player leaves
  house.insideNpcs = [];
  return { ok: true };
}

// ─────────────────────────────────────────────
// ITEM PLACEMENT
// ─────────────────────────────────────────────
let _itemCounter = 0;

/**
 * Place an item on the house grid.
 * @returns {{ ok, error }}
 */
function placeItem(playerId, itemType, gridX, gridY) {
  const house = ensureHouse(playerId);
  const def   = ITEM_CATALOG[itemType];
  if (!def) return { ok: false, error: `Unknown item: ${itemType}` };

  // Bounds check
  if (gridX < 0 || gridY < 0 || gridX + def.w > GRID_W || gridY + def.h > GRID_H) {
    return { ok: false, error: 'Out of bounds' };
  }

  // Collision check
  for (let dy = 0; dy < def.h; dy++) {
    for (let dx = 0; dx < def.w; dx++) {
      if (house.grid[gridY + dy][gridX + dx] !== null) {
        return { ok: false, error: 'Space occupied' };
      }
    }
  }

  const itemId = `item_${++_itemCounter}`;

  // Mark grid cells
  for (let dy = 0; dy < def.h; dy++) {
    for (let dx = 0; dx < def.w; dx++) {
      house.grid[gridY + dy][gridX + dx] = itemId;
    }
  }

  house.items.push({ id: itemId, itemType, gridX, gridY, label: def.label });
  recalcWarmth(playerId);

  return { ok: true, itemId, warmth: house.warmth };
}

/**
 * Remove an item from the house grid.
 */
function removeItem(playerId, itemId) {
  const house = ensureHouse(playerId);
  const idx   = house.items.findIndex(i => i.id === itemId);
  if (idx === -1) return { ok: false, error: 'Item not found' };

  const item = house.items[idx];
  const def  = ITEM_CATALOG[item.itemType];

  // Clear grid cells
  if (def) {
    for (let dy = 0; dy < def.h; dy++) {
      for (let dx = 0; dx < def.w; dx++) {
        const cy = item.gridY + dy, cx = item.gridX + dx;
        if (cy < GRID_H && cx < GRID_W) house.grid[cy][cx] = null;
      }
    }
  }

  house.items.splice(idx, 1);
  recalcWarmth(playerId);
  return { ok: true, warmth: house.warmth };
}

// ─────────────────────────────────────────────
// NPC VISIT SYSTEM
// ─────────────────────────────────────────────
const MAX_SIMULTANEOUS_VISITORS = 2;
const MIN_FRIENDSHIP_TO_VISIT   = 40;
const VISIT_DURATION_MS         = 60000; // 1 minute per visit

/**
 * Decide which NPC should visit which player right now.
 * Called periodically. Returns array of { npcId, playerId } pairs.
 */
function planNpcVisits() {
  const visits = [];

  for (const [playerId, house] of Object.entries(houses)) {
    if (!house.inside) continue; // player must be home
    if (house.insideNpcs.length >= MAX_SIMULTANEOUS_VISITORS) continue;

    // Find NPCs who like this player enough to visit
    const candidates = agents.filter(agent => {
      if (house.insideNpcs.includes(agent.id)) return false;
      const rel = getRelationship(agent.id, playerId);
      return rel.friendship >= MIN_FRIENDSHIP_TO_VISIT;
    });

    if (candidates.length === 0) continue;

    // Pick the one with highest friendship + warmth bonus
    const sorted = candidates.sort((a, b) => {
      const ra = getRelationship(a.id, playerId);
      const rb = getRelationship(b.id, playerId);
      return (rb.friendship + house.warmth * 0.3) - (ra.friendship + house.warmth * 0.3);
    });

    const visitor = sorted[0];
    house.insideNpcs.push(visitor.id);

    // Log visit
    house.visitors.push({ npcId: visitor.id, arrivedAt: Date.now(), leftAt: null });
    if (house.visitors.length > 20) house.visitors.shift();

    visits.push({ npcId: visitor.id, playerId, worldX: house.worldX, worldY: house.worldY });

    // Auto-remove after VISIT_DURATION_MS
    setTimeout(() => {
      npcLeaveHouse(visitor.id, playerId);
    }, VISIT_DURATION_MS);
  }

  return visits;
}

function npcLeaveHouse(npcId, playerId) {
  const house = houses[playerId];
  if (!house) return;
  house.insideNpcs = house.insideNpcs.filter(id => id !== npcId);
  const visit = [...house.visitors].reverse().find(v => v.npcId === npcId && !v.leftAt);
  if (visit) visit.leftAt = Date.now();
}

// ─────────────────────────────────────────────
// GET HOUSE STATE
// ─────────────────────────────────────────────
function getHouse(playerId) {
  return houses[playerId] || null;
}

function getHouseSummary(playerId) {
  const house = ensureHouse(playerId);
  return {
    worldX:     house.worldX,
    worldY:     house.worldY,
    warmth:     house.warmth,
    itemCount:  house.items.length,
    items:      house.items,
    insideNpcs: house.insideNpcs,
    visitors:   house.visitors.slice(-5), // last 5 visits
  };
}

module.exports = {
  ITEM_CATALOG,
  enterHouse,
  exitHouse,
  placeItem,
  removeItem,
  planNpcVisits,
  npcLeaveHouse,
  getHouse,
  getHouseSummary,
  ensureHouse,
  houses,
};
