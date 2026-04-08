/**
 * main.js — Pixel Synapse Phaser 3 Client
 *
 * GUI systems:
 *  - Dialogue box: slides up from bottom, avatar + name + role + emotion dot/label
 *  - NPC badges: HTML overlays on #bubble-layer, name + live emotion tag per NPC
 *  - Chat bubbles: world-space HTML divs, synced to camera each frame, auto-dismiss
 *  - Reputation: 5-level system (hostile→beloved), pip bar in HUD, per-NPC tracking
 *
 * Sprite systems:
 *  - Array-based 16×16 sprites via drawSprite()
 *  - Player: 4 directional textures, direction switches on key input
 *  - NPCs: unique color overrides, 4-frame walk animation
 *  - Objects: table, chair, tree placed on world canvas
 *
 * Style guide:
 *  - 24-color palette as PAL object + CSS :root vars
 *  - Tiles: grass, road, cobble, wall, water, path, interior
 *  - 400ms idle bob ±1px, camera lerp 0.09, integer pixel rounding
 */

// ─────────────────────────────────────────────
// PALETTE (mirrors CSS :root vars)
// ─────────────────────────────────────────────
const PAL = {
  // ── UI / system ──
  void:        '#1a1a2e',
  panel:       '#1a1a2e',
  border:      '#3060d0',
  blue:        '#3878f8',
  nameLt:      '#f8f8f8',
  dialogue:    '#e8e8e8',
  you:         '#f8d030',
  online:      '#78c850',
  danger:      '#f83030',
  interact:    '#58a8f8',
  eprompt:     '#f8f858',
  muted:       '#a0a0b0',

  // ── GBA Pokémon grass palette ──
  grassDark:   '#50a830',  // dark grass shadow
  grassBase:   '#68c040',  // main grass green
  grassMid:    '#80d858',  // mid grass highlight
  grassBright: '#98f070',  // bright tuft
  treeDark:    '#287818',  // tree shadow
  trunk:       '#c07030',  // tree trunk brown

  // ── Path / ground ──
  sqPave:      '#e0c878',  // bright sand/path
  stoneEdge:   '#b8a050',  // path edge
  cobble:      '#d0b860',  // path mid
  darkStone:   '#a09050',  // dark path

  // ── Water ──
  fountain:    '#3898f8',  // water bright blue
  water:       '#70b8ff',  // water highlight

  // ── Buildings ──
  wallDark:    '#c02020',  // red roof dark
  wallMid:     '#e83030',  // red roof main
  roofTrim:    '#f86060',  // red roof highlight
  wallBlue:    '#2848c0',  // blue roof
  wallGreen:   '#289048',  // green accent
};


// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const WORLD_W         = 800;
const WORLD_H         = 800;
const PLAYER_SPEED    = 140;
const TILE_SIZE       = 16;
const NPC_INTERACT_DIST = 55;
const SEND_INTERVAL   = 80;
const CAM_LERP        = 0.09;   // style guide: 0.08–0.12
const BOB_PERIOD      = 400;    // ms for idle bob cycle
const BOB_AMOUNT      = 1;      // ±1px per style guide

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}`;
let ws     = null;
let myId   = null;
let myName = 'Connecting...';

// ─────────────────────────────────────────────
// GAME STATE
// ─────────────────────────────────────────────
const gameState = {
  players: {},
  npcs: [],
  npcSprites: {},
  mySprite: null,
  myX: 300, myY: 300,
  activeNpcId: null,
  dialogueOpen: false,
  scene: null,
  interactKey: null,
  cursors: null,
  wasd: null,
  currentTownId: 'pixel_synapse',
  mobileInput: { x: 0, y: 0 },
};

// ─────────────────────────────────────────────
// COLOR HELPERS
// ─────────────────────────────────────────────
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#',''), 16);
  return { r: (n>>16)&255, g: (n>>8)&255, b: n&255 };
}
function darkenHex(hex, amt) {
  const {r,g,b} = hexToRgb(hex);
  return `rgb(${Math.max(0,r-amt)},${Math.max(0,g-amt)},${Math.max(0,b-amt)})`;
}
function lightenHex(hex, amt) {
  const {r,g,b} = hexToRgb(hex);
  return `rgb(${Math.min(255,r+amt)},${Math.min(255,g+amt)},${Math.min(255,b+amt)})`;
}

// ─────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────
function showToast(msg, duration = 2000) {
  UISystem.showNotification(msg, '#8899cc', duration);
}

// ─────────────────────────────────────────────
// SPRITE ARRAYS + COLOR MAP
// Every character, NPC, and object is defined as
// a 16×16 array of single-char color keys.
// _ = transparent, K = outline black
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// GBA POKÉMON-STYLE SPRITE SYSTEM
// Bright palette · big head · 16×16 canvas · scale=2 display
// 2-3 tone shading per region — matches FireRed/LeafGreen style
// ─────────────────────────────────────────────
const SPRITE_COLORS = {
  K: '#181018',  // near-black outline
  S: '#f8c888',  // skin light (warm peach)
  s: '#d88048',  // skin shadow
  H: '#e82020',  // hat red (player)
  h: '#a01010',  // hat shadow
  B: '#3060e0',  // shirt blue (player)
  b: '#1838a0',  // shirt shadow
  I: '#80a8f8',  // shirt highlight
  T: '#383878',  // pants dark blue
  t: '#202050',  // pants shadow
  P: '#e03820',  // NPC shirt (overridden per NPC)
  p: '#901808',  // NPC shirt shadow
  Y: '#606060',  // NPC pants grey
  y: '#404040',  // NPC pants shadow
  E: '#181018',  // eye detail
  G: '#50b020',  // leaf bright
  g: '#287810',  // leaf dark
  L: '#78d838',  // leaf highlight
  R: '#c07030',  // trunk
  r: '#804010',  // trunk shadow
  W: '#f0e8d0',  // furniture light
  w: '#c0a870',  // furniture mid
  _: null,       // transparent
};

// ── PLAYER DOWN ──
const SPR_PLAYER_DOWN = [
  '____KKKKKKKK____',
  '___KHHHHHHhhK___',
  '___KHHHHHHhhK___',
  '___KKKKKKKKhK___',
  '___KSSeSSeSSK___',
  '___KSSSSssSSK___',
  '___KSSSssSSsK___',
  '__KKKBBBBBBKkK__',
  '__KBBBBBBBBBbK__',
  '__KBBIBBBIBBbK__',
  '__KBBBBBBBBBbK__',
  '__KKKBBBBBBKkK__',
  '____KTTKKTtK____',
  '____KTTKKTtK____',
  '____KttKKttK____',
  '____KKKK_KKK____',
];
const SPR_PLAYER_DOWN_B = SPR_PLAYER_DOWN.map((row, y) => {
  if (y===12) return '____KTtKKTTK____';
  if (y===13) return '____KTtKKTTK____';
  if (y===14) return '____KttKKttK____';
  if (y===15) return '___KKKK__KKKK___';
  return row;
});

// ── PLAYER UP ──
const SPR_PLAYER_UP = [
  '____KKKKKKKK____',
  '___KHHHHHHhhK___',
  '___KHHHHHHhhK___',
  '___KKKKKKKKhK___',
  '___KSSSSssSSK___',
  '___KSSSSssSSK___',
  '___KSSSSssSSK___',
  '__KKKBBBBBBKkK__',
  '__KBBBBBBBBBbK__',
  '__KBBIBBBIBBbK__',
  '__KBBBBBBBBBbK__',
  '__KKKBBBBBBKkK__',
  '____KTTKKTtK____',
  '____KTTKKTtK____',
  '____KttKKttK____',
  '____KKKK_KKK____',
];
const SPR_PLAYER_UP_B = SPR_PLAYER_UP.map((row, y) => {
  if (y===12) return '____KTtKKTTK____';
  if (y===13) return '____KTtKKTTK____';
  if (y===14) return '____KttKKttK____';
  if (y===15) return '___KKKK__KKKK___';
  return row;
});

// ── PLAYER RIGHT ──
const SPR_PLAYER_RIGHT = [
  '_____KKKKKK_____',
  '____KHHHHhhK____',
  '____KHHHHhhK____',
  '____KKKKKKhK____',
  '____KSSeSsK_____',
  '____KSSSssK_____',
  '____KSSssKK_____',
  '___KKBBBBBbK____',
  '__KBBBBBBBBbK___',
  '__KBIBBBBBbK____',
  '__KBBBBBBBbK____',
  '___KKBBBBKkK____',
  '____KTTKttK_____',
  '____KTTKttK_____',
  '____KttK_KK_____',
  '____KKKK________',
];
const SPR_PLAYER_RIGHT_B = SPR_PLAYER_RIGHT.map((row, y) => {
  if (y===12) return '____KttKTTK_____';
  if (y===13) return '____KttKTTK_____';
  if (y===14) return '____KTTK_KK_____';
  if (y===15) return '____KKKK________';
  return row;
});
const SPR_PLAYER_LEFT   = SPR_PLAYER_RIGHT.map(r => r.split('').reverse().join(''));
const SPR_PLAYER_LEFT_B = SPR_PLAYER_RIGHT_B.map(r => r.split('').reverse().join(''));

// ── NPC BASE (shirt P/p overridden per NPC via colorOverrides) ──
const SPR_NPC_IDLE = [
  '____KKKKKKKK____',
  '___KSSSSSSssK___',
  '___KSSSSSSssK___',
  '___KSSSSSSssK___',
  '___KSSeSSeSSK___',
  '___KSSSSssSSK___',
  '___KSSSssSSsK___',
  '__KKKPPPPPPKkK__',
  '__KPPPPPPPPPpK__',
  '__KPPPPPPPPPpK__',
  '__KPPPPPPPPPpK__',
  '__KKKPPPPPPKkK__',
  '____KYYKKYyK____',
  '____KYYKKYyK____',
  '____KyyKKyyK____',
  '____KKKK_KKK____',
];
const SPR_NPC_WALK_A = SPR_NPC_IDLE.map((row, y) => {
  if (y===12) return '____KYyKKYYK____';
  if (y===13) return '____KYyKKYYK____';
  if (y===14) return '____KYyK_KyK____';
  if (y===15) return '____KKKK_KKK____';
  return row;
});
const SPR_NPC_WALK_B = SPR_NPC_IDLE.map((row, y) => {
  if (y===12) return '____KYYKKYyK____';
  if (y===13) return '____KYYKKYyK____';
  if (y===14) return '____KyK__KYK____';
  if (y===15) return '____KKK__KKK____';
  return row;
});

// ── OBJECTS ──
const SPR_TREE = [
  '____KKKKKK______',
  '___KGGGGGgK_____',
  '__KGGLGGLGgK____',
  '_KGGGGGGGGGgK___',
  '_KGLGGGGGLGgK___',
  'KGGGGGGGGGGGgK__',
  'KGGLGGGGGLGGgK__',
  'KGGGGGGGGGGGGK__',
  '_KKGGGGGGGKK____',
  '____KRRRRK______',
  '____KRRRrK______',
  '____KRrrRK______',
  '____KrRRrK______',
  '____KKKKKK______',
  '________________',
  '________________',
];
const SPR_TABLE = [
  '________________',
  '__KKKKKKKKKKKK__',
  '__KWWWWWWWWWwK__',
  '__KwWWWWWWWWwK__',
  '__KKKKKKKKKKKK__',
  '____KRRK_KRRK___',
  '____KRRK_KRRK___',
  '____KrRK_KrRK___',
  '____KKKK_KKKK___',
  '________________',
  '________________',
  '________________',
  '________________',
  '________________',
  '________________',
  '________________',
];
const SPR_CHAIR = [
  '___KKKKKKK______',
  '___KRRRRRrK_____',
  '___KRRRRRrK_____',
  '___KrRRRRrK_____',
  '___KKKKKKKKK____',
  '___KWWWWWWwK____',
  '___KwWWWWWwK____',
  '___KKKKKKKK_____',
  '___KRK___KRK____',
  '___KRK___KRK____',
  '___KrK___KrK____',
  '___KKK___KKK____',
  '________________',
  '________________',
  '________________',
  '________________',
];

const NPC_WALK_FRAMES = [SPR_NPC_IDLE, SPR_NPC_WALK_A, SPR_NPC_IDLE, SPR_NPC_WALK_B];




/**
 * Draw any sprite array onto a canvas context at (ox, oy) scaled by S.
 * Transparent pixels (_) are skipped.
 */
function drawSprite(ctx, grid, ox, oy, S, colorOverrides) {
  ctx.imageSmoothingEnabled = false;
  const cols = colorOverrides || {};
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      const k = row[x];
      if (k === '_') continue;
      const hex = cols[k] || SPRITE_COLORS[k];
      if (!hex) continue;
      ctx.fillStyle = hex;
      ctx.fillRect((ox + x) * S, (oy + y) * S, S, S);
    }
  }
}

/**
 * Build a color-override map so any NPC's shirt/pants
 * use their unique color while keeping skin/outline the same.
 */
function npcColorOverrides(color) {
  // Override the shirt (P/p) with this NPC's unique color.
  // Everything else (skin, pants, outline) stays as defined in SPRITE_COLORS.
  return {
    P: color,
    p: darkenHex(color, 35),
  };
}

function updateHUD() {
  document.getElementById('hud-name').textContent = myName.toUpperCase();
  const count = Object.keys(gameState.players).length + 1;
  document.getElementById('hud-online').textContent = `● ${count} ONLINE`;
}

function updatePlayerList() {
  const el = document.getElementById('pl-entries');
  const repIcon = playerRep?.icon || '○';
  const repColor = playerRep?.color || '#888780';
  let html = `<div class="pl-entry pl-me" style="color:${repColor}">▸ ${myName} <span style="font-size:10px">${repIcon}</span></div>`;
  for (const [,p] of Object.entries(gameState.players)) {
    const icon = p.repTitle ? (p.repColor ? `<span style="color:${p.repColor};font-size:10px">●</span>` : '') : '';
    html += `<div class="pl-entry" style="color:${p.color}99">· ${p.name || '???'} ${icon}</div>`;
  }
  el.innerHTML = html;
}

// ─────────────────────────────────────────────
// MINIMAP
// ─────────────────────────────────────────────
function drawMinimap() {
  const canvas = document.getElementById('minimap-canvas');
  const ctx = canvas.getContext('2d');
  const sx = 100/WORLD_W, sy = 100/WORLD_H;

  ctx.fillStyle = '#05050f';
  ctx.fillRect(0,0,100,100);

  // Map zones
  ctx.fillStyle = PAL.grassDark;  ctx.fillRect(5,5,22,22);   // park
  ctx.fillStyle = PAL.wallBlue;   ctx.fillRect(62,5,22,18);  // NE buildings
  ctx.fillStyle = PAL.wallGreen;  ctx.fillRect(5,62,20,18);  // SW buildings
  ctx.fillStyle = PAL.wallMid;    ctx.fillRect(62,62,25,20); // SE buildings
  ctx.fillStyle = PAL.sqPave;     ctx.fillRect(35,35,30,30); // town square
  ctx.fillStyle = PAL.fountain;   ctx.fillRect(46,46,8,8);   // fountain

  // Roads
  ctx.fillStyle = '#221e18';
  ctx.fillRect(47,0,6,100);
  ctx.fillRect(0,47,100,6);

  // ── Transit Hub — east edge at tile 44–50, row 22–28 ──
  // Road connector from main horizontal road to station (tile col 44–50, row 25)
  ctx.fillStyle = '#2a2218';
  ctx.fillRect(90, 47, 10, 6); // extension of horizontal road to east edge
  // Station building footprint
  ctx.fillStyle = '#241824';
  ctx.fillRect(90, 43, 10, 14);
  ctx.fillStyle = '#3a2050';
  ctx.fillRect(90, 43, 10, 3);   // roof strip
  // Portal glow dot (animated-ish — always visible purple)
  const phase = (Date.now() / 500) % (Math.PI * 2);
  const gAlpha = 0.6 + Math.sin(phase) * 0.3;
  ctx.fillStyle = `rgba(170, 102, 255, ${gAlpha.toFixed(2)})`;
  ctx.fillRect(94, 52, 3, 4);    // portal position
  // Label dot
  ctx.fillStyle = '#aa66ff';
  ctx.fillRect(92, 50, 1, 1);

  // NPCs
  for (const npc of gameState.npcs) {
    ctx.fillStyle = npc.color || '#ffffff';
    ctx.fillRect(Math.floor(npc.x*sx)-1, Math.floor(npc.y*sy)-1, 3,3);
  }
  // Other players
  for (const p of Object.values(gameState.players)) {
    ctx.fillStyle = p.color || PAL.interact;
    ctx.fillRect(Math.floor(p.x*sx)-1, Math.floor(p.y*sy)-1, 3,3);
  }
  // Local player (white, 4×4)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(Math.floor(gameState.myX*sx)-2, Math.floor(gameState.myY*sy)-2, 4,4);
}

// ─────────────────────────────────────────────
// EMOTION COLOR MAP
// ─────────────────────────────────────────────
const EMOTION_COLORS = {
  happy:      PAL.online,
  curious:    PAL.interact,
  nervous:    '#ffaa44',
  suspicious: PAL.danger,
  excited:    PAL.eprompt,
  sad:        '#4466aa',
  neutral:    PAL.muted,
  glitchy:    '#00ffcc',
  idle:       PAL.muted,
};

// ─────────────────────────────────────────────
// REPUTATION SYSTEM (client-side display)
// The server is authoritative — we just render what it sends.
// Updated on 'init', 'npc_reply', and 'reputation_update' messages.
// ─────────────────────────────────────────────

// Current player reputation received from server
let playerRep = { title: 'STRANGER', color: '#888780', icon: '○', kindness: 0, trust: 0, chaos: 0 };

/**
 * Apply a reputation object from the server and update all HUD elements.
 * @param {object} rep  - { title, color, icon, kindness, trust, chaos }
 */
function applyReputation(rep) {
  if (!rep) return;
  playerRep = rep;
  UISystem.updateReputation(rep.color || '#888780', `${rep.icon||'○'} ${rep.title||'STRANGER'}`, rep);
  // Update Phaser name tag color to reflect rep
  if (gameState.scene?.myNameTag) {
    gameState.scene.myNameTag.setStyle({ color: rep.color || PAL.you });
  }
}

function updateGameClock(time) {
  const t    = time?.hour !== undefined ? time : (time?.time || time);
  const hour = t?.hour ?? 8;
  UISystem.updateGameClock(t?.label ?? '08:00', hour < 6 || hour >= 20);
}

// Shims kept for backward compatibility
function updateRepHUD() { applyReputation(playerRep); }
function gainRep()      { /* server is authoritative */ }
function setThinking(on) { UISystem.setThinking(on); }

let playerFactions = {};

function applyFactions(factions) {
  if (!factions) return;
  playerFactions = factions;
  const el = document.getElementById('faction-status');
  if (!el) return;
  el.innerHTML = Object.entries(factions)
    .map(([,f]) => `<span style="color:${f.color};font-size:5px;letter-spacing:1px;">${f.label}</span>`)
    .join('<span style="color:#334;margin:0 3px">·</span>');
}

// ─────────────────────────────────────────────
// EVENT BANNER
// ─────────────────────────────────────────────
let activeEvent = null;

function applyEvent(ev) {
  activeEvent = ev;
  if (!ev) { UISystem.hideEventBanner(); return; }
  UISystem.showEventBanner(ev.label, ev.description);
}

// ─────────────────────────────────────────────
// HOUSE HUD
// ─────────────────────────────────────────────
let houseState = null;

function applyHouse(house) {
  if (!house) return;
  houseState = house;
  const el = document.getElementById('house-status');
  if (!el) return;
  el.textContent = `⌂ ${house.itemCount || 0} items · warmth ${house.warmth || 0}`;
  el.style.color = house.warmth > 50 ? '#ffcc44' : '#556677';
}

// ─────────────────────────────────────────────
// ECONOMY HUD
// ─────────────────────────────────────────────
let walletState = { coins: 50 };

function applyWallet(wallet) {
  if (!wallet) return;
  walletState = wallet;
  const el = document.getElementById('wallet-status');
  if (el) {
    el.textContent = `◈ ${wallet.coins} coins`;
    el.style.color = wallet.coins >= 100 ? '#ffcc44' : wallet.coins >= 20 ? '#aabbff' : '#ff8844';
  }
}

function applyEconomy(data) {
  if (data?.wallet) applyWallet(data.wallet);
}

// ─────────────────────────────────────────────
// POLITICS HUD
// ─────────────────────────────────────────────
let openIssues = [];

function applyPolitics(issues) {
  if (!issues) return;
  openIssues = issues;
  const el = document.getElementById('politics-status');
  if (!el) return;
  if (!issues.length) {
    el.textContent = '';
    return;
  }
  const top = issues[0];
  el.textContent = `▸ VOTE: ${top.name}`;
  el.style.color = '#ce93d8';
  el.title = top.description || '';
}

// ─────────────────────────────────────────────
// RELATIONSHIP COLLAPSE VISUAL
// ─────────────────────────────────────────────
function applyRelationshipCollapse(msg) {
  const colors = {
    breakup:     '#f06292',
    betrayal:    '#ff4444',
    enemy:       '#ffaa44',
    fear_rupture:'#ff8844',
  };
  const color = colors[msg.subtype] || '#ffaa44';
  UISystem.showNotification(msg.message || 'A relationship changed.', color, 5000);

  // Update NPC badge emotion
  if (msg.npcId) {
    const emotion = msg.subtype === 'betrayal' ? 'suspicious'
      : msg.subtype === 'breakup' ? 'sad'
      : msg.subtype === 'fear_rupture' ? 'nervous'
      : 'neutral';
    updateNpcEmotionBadge(msg.npcId, emotion);
  }
}

// ─────────────────────────────────────────────
// NPC RELATIONSHIP BADGE
// ─────────────────────────────────────────────
function applyNpcRelationship(rel) {
  if (!rel || !rel.npcId) return;
  const relEmotion = rel.state === 'lover' || rel.state === 'admirer' ? 'happy'
    : rel.state === 'enemy' || rel.state === 'terrified' ? 'suspicious'
    : rel.state === 'wary' ? 'nervous' : 'neutral';
  UISystem.showNpcEmotion(rel.npcId, relEmotion);
  updateRelPanel();
}

// ─────────────────────────────────────────────
// RELATIONSHIP STATUS PANEL
// Small panel (top-right) showing bonds with all NPCs
// ─────────────────────────────────────────────
const _relCache = {}; // npcId → { state, label, color }

function updateRelPanel() {
  const el = document.getElementById('rel-entries');
  if (!el) return;
  const entries = Object.entries(_relCache)
    .filter(([, v]) => v.state !== 'neutral')
    .slice(0, 6);
  if (entries.length === 0) {
    document.getElementById('rel-panel').style.display = 'none';
    return;
  }
  document.getElementById('rel-panel').style.display = 'block';
  el.innerHTML = entries.map(([npcId, v]) => {
    const npc = gameState.npcs.find(n => n.id === npcId);
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
      <span style="color:${npc?.color||'#aabbff'}">${npc?.name||npcId}</span>
      <span style="color:${v.color};font-size:4px;">${v.label}</span>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────
// SHOP OVERLAY — BUY + WORK (JOBS)
// ─────────────────────────────────────────────
let _currentShopNpcId = null;
let _currentShopData  = null;
let _shopTab          = 'buy';

function openShop(npcId) {
  _currentShopNpcId = npcId;
  _shopTab = 'buy';
  ws.send(JSON.stringify({ type: 'shop_get', npcId }));
}

function closeShop() {
  document.getElementById('shop-overlay').style.display = 'none';
  _currentShopNpcId = null;
  _currentShopData  = null;
}

function switchShopTab(tab) {
  _shopTab = tab;
  document.getElementById('shop-buy-panel').style.display  = tab === 'buy'  ? 'block' : 'none';
  document.getElementById('shop-work-panel').style.display = tab === 'work' ? 'block' : 'none';
  document.querySelectorAll('.shop-tab').forEach(b => b.classList.remove('active-tab'));
  document.getElementById(`tab-${tab}`).classList.add('active-tab');
}

function renderShop(data) {
  _currentShopData = data;
  const overlay = document.getElementById('shop-overlay');
  overlay.style.display = 'block';

  const npc = gameState.npcs.find(n => n.id === _currentShopNpcId);
  document.getElementById('shop-title').textContent = data.shop?.name || npc?.name || 'SHOP';
  document.getElementById('shop-wallet').textContent = `◈ ${data.wallet?.coins ?? walletState.coins} coins`;

  // ── BUY items ──
  const itemsEl = document.getElementById('shop-items');
  const items   = data.shop?.items || [];
  if (items.length === 0) {
    itemsEl.innerHTML = '<div style="font-size:5px;color:#556677;padding:8px;">Nothing for sale right now.</div>';
  } else {
    itemsEl.innerHTML = items.map(item => {
      const canAfford = (data.wallet?.coins ?? walletState.coins) >= item.currentPrice;
      const inStock   = item.stock > 0;
      return `<div class="shop-row">
        <div>
          <div class="shop-row-name">${item.name}</div>
          ${item.description ? `<div class="shop-row-meta">${item.description}</div>` : ''}
        </div>
        <div style="display:flex;gap:10px;align-items:center;">
          <span class="shop-row-meta">${item.stock === 99 ? '∞' : item.stock + ' left'}</span>
          <span class="shop-row-price">◈${item.currentPrice}</span>
          <button class="shop-btn" onclick="doBuy('${item.id}')"
            ${!canAfford || !inStock ? 'disabled' : ''}>
            ${!inStock ? 'OUT' : !canAfford ? 'POOR' : 'BUY'}
          </button>
        </div>
      </div>`;
    }).join('');
  }

  // ── WORK jobs ──
  const jobsEl = document.getElementById('shop-jobs');
  const jobs   = data.jobs || [];
  if (jobs.length === 0) {
    jobsEl.innerHTML = '<div style="font-size:5px;color:#556677;padding:8px;">No work available right now.</div>';
  } else {
    const busyWithJob = _activeJob !== null;
    jobsEl.innerHTML = jobs.map(job => {
      const secs     = Math.round((JOB_DURATIONS[job.id] || 8000) / 1000);
      const onCd     = job.cooldownLeft > 0;
      const canWork  = job.available && !onCd && !busyWithJob;
      const timeText = onCd
        ? `${job.cooldownLeft}m cooldown`
        : `~${secs}s · +◈${job.pay}`;
      return `<div class="shop-row">
        <div>
          <div class="shop-row-name">${job.name}</div>
          <div class="shop-row-meta">${timeText}</div>
        </div>
        <div style="display:flex;align-items:center;">
          <button class="shop-btn work-btn" onclick="doWork('${job.id}')"
            ${canWork ? '' : 'disabled'}
            style="${canWork ? '' : 'opacity:0.4;'}">
            ${busyWithJob ? 'BUSY' : onCd ? 'WAIT' : 'WORK'}
          </button>
        </div>
      </div>`;
    }).join('');
  }

  switchShopTab(_shopTab);
}

function doBuy(itemId) {
  if (!_currentShopNpcId) return;
  ws.send(JSON.stringify({ type: 'shop_buy', shopId: _currentShopNpcId, itemId }));
}

// ─────────────────────────────────────────────
// JOB TIMER SYSTEM
// Client-side countdown drives the world-space progress bar.
// When the bar fills, we send job_do to the server for validation + reward.
// ─────────────────────────────────────────────

// Duration for each job id in milliseconds (must match server economy.js pay table)
const JOB_DURATIONS = {
  serve_coffee:   8000,
  clean_cafe:    10000,
  deliver_msg:   15000,
  fetch_parts:   12000,
  test_gadget:   20000,
  tend_garden:    8000,
  collect_herbs: 12000,
  play_music:    10000,
  escort:        15000,
  patrol:        10000,
  race_errand:   12000,
};

// Current active job state — null when not working
let _activeJob = null;  // { id, name, npcId, durationMs, startTime, pay, completed }

/**
 * Start a client-side job timer. Closes the shop overlay so the
 * world-space progress bar is visible above the player sprite.
 */
function startJobTimer(jobId, jobName, npcId, pay) {
  if (_activeJob) {
    UISystem.showNotification('Finish your current job first!', '#ffaa44', 2000);
    return;
  }
  const duration = JOB_DURATIONS[jobId] || 8000;
  _activeJob = {
    id:         jobId,
    name:       jobName || jobId,
    npcId,
    durationMs: duration,
    startTime:  Date.now(),
    pay,
    completed:  false,
  };
  closeShop(); // hide shop so bar is unobstructed
  UISystem.showNotification(`▸ Job started: ${jobName || jobId}`, '#44aaff', 2200);
}

/**
 * Called by the Phaser update loop when progress hits 100%.
 * Sends job_do to server; server validates and returns economy_earned.
 */
function completeJob() {
  if (!_activeJob) return;
  const job  = _activeJob;
  _activeJob = null;
  ws.send(JSON.stringify({ type: 'job_do', npcId: job.npcId, jobId: job.id }));
}

/**
 * doWork — called by the WORK button in the shop overlay.
 * Reads job metadata from current shop data, starts the timer.
 */
function doWork(jobId) {
  if (!_currentShopNpcId) return;
  if (_activeJob) {
    UISystem.showNotification('Already working — wait for it to finish!', '#ffaa44', 2000);
    return;
  }
  const job  = (_currentShopData?.jobs || []).find(j => j.id === jobId);
  const name = job?.name || jobId;
  const pay  = job?.pay  || 0;
  startJobTimer(jobId, name, _currentShopNpcId, pay);
}

document.getElementById('shop-close').addEventListener('click', closeShop);

// ─────────────────────────────────────────────
// VOTE OVERLAY
// Shows the current open town issue for voting
// ─────────────────────────────────────────────
let _currentVoteIssue = null;

function openVote(issue) {
  if (!issue) return;
  _currentVoteIssue = issue;
  document.getElementById('vote-overlay').style.display = 'block';
  document.getElementById('vote-title').textContent = issue.name.toUpperCase();
  document.getElementById('vote-desc').textContent  = issue.description || '';

  const yes = issue.tally?.yes || 0;
  const no  = issue.tally?.no  || 0;
  const tot = Math.max(1, yes + no);
  document.getElementById('vote-tally').innerHTML = `
    <div style="flex:1;font-size:5px;">
      <div style="color:#44ff88;margin-bottom:4px;">YES: ${yes}</div>
      <div style="background:#1a1a2a;height:6px;"><div style="background:#44ff88;height:100%;width:${Math.round(yes/tot*100)}%;"></div></div>
    </div>
    <div style="flex:1;font-size:5px;">
      <div style="color:#ff4444;margin-bottom:4px;">NO: ${no}</div>
      <div style="background:#1a1a2a;height:6px;"><div style="background:#ff4444;height:100%;width:${Math.round(no/tot*100)}%;"></div></div>
    </div>`;
}

function closeVote() {
  document.getElementById('vote-overlay').style.display = 'none';
  _currentVoteIssue = null;
}

function castVote(side) {
  if (!_currentVoteIssue) return;
  ws.send(JSON.stringify({ type: 'politics_vote', issueId: _currentVoteIssue.id, side }));
  UISystem.showNotification(`Voted ${side.toUpperCase()} on "${_currentVoteIssue.name}"`, side === 'yes' ? '#44ff88' : '#ff4444', 2500);
  closeVote();
}

// Wire politics-status click to open vote overlay
document.getElementById('politics-status')?.addEventListener('click', () => {
  if (openIssues.length > 0) openVote(openIssues[0]);
  else ws.send(JSON.stringify({ type: 'politics_get' }));
});

// ─────────────────────────────────────────────
// DIALOGUE ACTION BUTTONS
// Contextual buttons that appear inside dialogue:
//   SHOP (if NPC runs a shop), VOTE (if issue active)
// ─────────────────────────────────────────────
const SHOP_NPCS = ['mira', 'orion', 'ivy', 'zara'];

function updateDialogueActions(npcId) {
  const el = document.getElementById('dialogue-actions');
  if (!el) return;
  const btns = [];

  // Shop button
  if (SHOP_NPCS.includes(npcId)) {
    btns.push(`<button class="action-btn" onclick="openShopFromDialogue()">⚑ SHOP</button>`);
  }

  // Vote button
  if (openIssues.length > 0) {
    btns.push(`<button class="action-btn" onclick="openVote(openIssues[0])">◈ VOTE</button>`);
  }

  el.innerHTML = btns.join('');
  el.style.display = btns.length > 0 ? 'flex' : 'none';
}

function openShopFromDialogue() {
  if (gameState.activeNpcId) openShop(gameState.activeNpcId);
}

// ─────────────────────────────────────────────
// NPC INTERACTION TYPE ROUTER
// Maps each NPC id to its primary interaction type.
// shop    → opens buy/sell panel
// job     → opens work panel
// vote    → opens vote overlay
// default → opens dialogue
// ─────────────────────────────────────────────
const NPC_INTERACTION_TYPES = {
  mira:  'shop',   // Café — buy coffee, work shifts
  orion: 'shop',   // Workshop — buy parts, test gadgets
  ivy:   'shop',   // Garden stall — buy plants/herbs
  zara:  'shop',   // Busking corner — buy songs/inspiration
  sol:   'vote',   // Retired adventurer / de-facto Mayor
  bram:  'job',    // Guard — offer patrol jobs
  juno:  'job',    // Racer — delivery race jobs
  lena:  'default',
  kai:   'default',
  pix:   'default',
};

function getNpcInteractionType(npcId) {
  return NPC_INTERACTION_TYPES[npcId] || 'default';
}

// Get a context-aware prompt label for the interact key
function getInteractLabel(npcId, nearZone) {
  if (nearZone === 'vote')   return '[E] VOTE';
  if (nearZone === 'trade')  return '[E] TRADE';
  if (nearZone === 'travel') return '[E] TRAVEL';
  const type = getNpcInteractionType(npcId);
  if (type === 'shop') return '[E] SHOP';
  if (type === 'job')  return '[E] WORK';
  if (type === 'vote') return '[E] VOTE';
  return '[E] TALK';
}

// ─────────────────────────────────────────────
// WORLD-ZONE ENTRY POINTS
// ─────────────────────────────────────────────

/** Open vote overlay from Town Hall zone or Sol interaction */
function openVoteFromWorld() {
  if (openIssues.length > 0) {
    openVote(openIssues[0]);
  } else {
    // Request latest issues from server then open
    ws.send(JSON.stringify({ type: 'politics_get' }));
    UISystem.showNotification('No active votes right now', '#556677', 2000);
  }
}

/** Open trade panel from Market zone */
function openTradeFromWorld() {
  openShop('ivy');
}

// ═════════════════════════════════════════════════════════════════
// TOWN TRAVEL SYSTEM
// ═════════════════════════════════════════════════════════════════

let _travelData     = null;  // { towns, currentTown } from server
let _travelSelected = null;  // id of highlighted town in menu

/** Open travel menu — requests town list from server first */
// ─────────────────────────────────────────────
// TOWNS — embedded fallback data
// Mirrors ai/towns.json (minus the npcs array).
// Used to render the travel menu instantly without
// waiting for a server round-trip.
// ─────────────────────────────────────────────
const TOWNS_FALLBACK = [
  {
    id:'pixel_synapse', name:'Pixel Synapse', subtitle:'The Town Where It All Began',
    description:'A cozy pixel town buzzing with artists, hackers, and café regulars.',
    mapType:'city', color:'#4455cc', icon:'🏘',
    economy:'moderate', economyLabel:'Thriving',
    populationLabel:'48 residents', politicsLabel:'Active voting',
    worldMapX:50, worldMapY:45,
    culture:{ friendliness:65, honesty:60, wealth:55, chaos:40, labels:['Lively','Friendly','Political'] },
  },
  {
    id:'neon_docks', name:'Neon Docks', subtitle:'Where the Network Never Sleeps',
    description:'A bustling harbour district. High prices but lucrative jobs.',
    mapType:'industrial', color:'#00E5FF', icon:'⚓',
    economy:'high', economyLabel:'Expensive',
    populationLabel:'120 residents', politicsLabel:'Merchant council',
    worldMapX:82, worldMapY:38,
    culture:{ friendliness:30, honesty:40, wealth:80, chaos:55, labels:['Competitive','Wealthy','Cutthroat'] },
  },
  {
    id:'verdant_hollow', name:'Verdant Hollow', subtitle:"Nature's Last Stronghold",
    description:'A quiet village deep in the forest. Cheap goods, honest people.',
    mapType:'village', color:'#81C784', icon:'🌿',
    economy:'low', economyLabel:'Affordable',
    populationLabel:'22 residents', politicsLabel:'Consensus vote',
    worldMapX:25, worldMapY:70,
    culture:{ friendliness:85, honesty:80, wealth:25, chaos:10, labels:['Calm','Honest','Close-knit'] },
  },
  {
    id:'iron_gate', name:'Iron Gate', subtitle:'Order Above All Else',
    description:'A heavily guarded fortress-town. Strict laws, military economy.',
    mapType:'city', color:'#8D6E63', icon:'🏰',
    economy:'military', economyLabel:'Tax-funded',
    populationLabel:'65 residents', politicsLabel:'Watch authority',
    worldMapX:60, worldMapY:72,
    culture:{ friendliness:25, honesty:75, wealth:60, chaos:15, labels:['Strict','Orderly','Military'] },
  },
  {
    id:'glitch_city', name:'Glitch City', subtitle:'Reality is a Suggestion Here',
    description:'A chaotic anarchic tech-district. Wild politics, maximum drama.',
    mapType:'chaotic', color:'#00ffcc', icon:'⚡',
    economy:'volatile', economyLabel:'Volatile ±30%',
    populationLabel:'? residents', politicsLabel:'No rules',
    worldMapX:75, worldMapY:20,
    culture:{ friendliness:45, honesty:20, wealth:35, chaos:95, labels:['Chaotic','Deceptive','Experimental'] },
  },
];

/** Open the travel menu — renders IMMEDIATELY from embedded data, then
 *  fires travel_get so the server can confirm the player's current town. */
function openTravelMenu() {
  console.log('[travel] openTravelMenu called — currentTown:', gameState.currentTownId);

  const overlay = document.getElementById('travel-overlay');
  if (!overlay) { console.error('[travel] #travel-overlay not found in DOM'); return; }

  // Show overlay immediately
  overlay.style.display = 'block';

  // Build the data object we need for renderTravelMenu
  // Use cached server data if available, otherwise fall back to embedded constant.
  const towns      = _travelData?.towns?.length ? _travelData.towns : TOWNS_FALLBACK;
  const currentTown= gameState.currentTownId || 'pixel_synapse';

  console.log('[travel] Rendering', towns.length, 'towns — current:', currentTown);
  _renderTownList(towns, currentTown);

  // Also ask server for authoritative current-town (updates header only if different)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'travel_get' }));
  }
}

/** Close and reset travel menu */
function closeTravelMenu() {
  const el = document.getElementById('travel-overlay');
  if (el) el.style.display = 'none';
  _travelSelected = null;
}

/**
 * Render the town list into the overlay.
 * Accepts either a raw towns array or the { towns, currentTown } object
 * that comes from the server's travel_data message.
 */
function renderTravelMenu(dataOrArray) {
  // Normalise: accept both array and { towns, currentTown } shapes
  const towns      = Array.isArray(dataOrArray) ? dataOrArray
                   : (dataOrArray.towns || TOWNS_FALLBACK);
  const currentTown= Array.isArray(dataOrArray) ? (gameState.currentTownId || 'pixel_synapse')
                   : (dataOrArray.currentTown || gameState.currentTownId || 'pixel_synapse');

  _travelData = { towns, currentTown };

  // Make overlay visible (renderTravelMenu may be called before openTravelMenu)
  const overlay = document.getElementById('travel-overlay');
  if (overlay && overlay.style.display !== 'block') overlay.style.display = 'block';

  console.log('[travel] renderTravelMenu —', towns.length, 'towns, current:', currentTown);
  _renderTownList(towns, currentTown);
}

/** Internal — writes the town rows into #travel-list */
function _renderTownList(towns, currentTown) {
  const listEl = document.getElementById('travel-list');
  const curEl  = document.getElementById('travel-current');
  if (!listEl) { console.error('[travel] #travel-list element not found'); return; }

  // Current-town header
  const cur = towns.find(t => t.id === currentTown);
  if (curEl) {
    curEl.innerHTML = cur
      ? `<span style="color:${cur.color || '#aabbff'};">${cur.icon || '◈'} Currently in: ${cur.name}</span>`
      : '';
  }

  // Guard: if no towns, show a message rather than a blank panel
  if (!towns.length) {
    listEl.innerHTML = '<div style="font-size:5px;color:#ff4444;padding:10px 0;">No towns found — check server connection.</div>';
    return;
  }

  listEl.innerHTML = towns.map(town => {
    const isCurrent  = town.id === currentTown;
    const isSelected = town.id === _travelSelected;
    const col        = town.color  || '#aabbff';
    const border     = isSelected  ? `2px solid ${col}`
                     : isCurrent   ? `1px solid ${col}44`
                     : '1px solid #1a1a2a';
    const bg         = isSelected  ? `${col}18`
                     : isCurrent   ? '#0d0d1a'
                     : '#0a0a14';

    const ecoLabel   = town.economyLabel   || town.economy || '—';
    const popLabel   = town.populationLabel|| '—';
    const polLabel   = town.politicsLabel  || '—';
    const ecoColor   = town.economy === 'high'     ? '#ff8844'
                     : town.economy === 'low'      ? '#44ff88'
                     : town.economy === 'volatile' ? '#ffcc44'
                     : '#aabbff';

    // Culture labels row
    const cultureRow = town.culture?.labels?.length
      ? `<div style="font-size:4px;color:${col}88;margin-top:2px;">${town.culture.labels.join(' · ')}</div>`
      : '';

    return `
      <div class="travel-row${isCurrent ? ' travel-row-current' : ''}"
           id="trow-${town.id}"
           onclick="selectTown('${town.id}')"
           style="background:${bg};border:${border};padding:10px 12px;cursor:${isCurrent ? 'default' : 'pointer'};display:flex;align-items:center;gap:12px;">
        <div style="font-size:22px;flex-shrink:0;width:28px;text-align:center;line-height:1;">${town.icon || '◈'}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:7px;color:${isCurrent ? col + 'aa' : col};letter-spacing:1px;margin-bottom:3px;">
            ${town.name}${isCurrent ? ' ◀' : ''}
          </div>
          <div style="font-size:5px;color:#556677;margin-bottom:3px;">${town.subtitle || ''}</div>
          <div style="font-size:5px;color:#aabbff;line-height:1.6;">${town.description || ''}</div>
          ${cultureRow}
        </div>
        <div style="flex-shrink:0;display:flex;flex-direction:column;gap:3px;align-items:flex-end;min-width:88px;">
          <div style="font-size:4px;color:${ecoColor};">◈ ${ecoLabel}</div>
          <div style="font-size:4px;color:#aabbff;">👥 ${popLabel}</div>
          <div style="font-size:4px;color:#ce93d8;">⚖ ${polLabel}</div>
          ${!isCurrent
            ? `<button class="travel-btn"
                 onclick="event.stopPropagation();travelTo('${town.id}')"
                 style="margin-top:4px;background:${col}22;border:1px solid ${col};color:${col};
                        padding:3px 10px;font-family:'Press Start 2P',monospace;font-size:5px;cursor:pointer;">
                 TRAVEL ▸
               </button>`
            : `<div style="font-size:4px;color:#334;margin-top:4px;">[ HERE ]</div>`}
        </div>
      </div>`;
  }).join('');
}

/** Highlight a town row on click */
function selectTown(townId) {
  if (!townId || townId === (gameState.currentTownId || 'pixel_synapse')) return;
  _travelSelected = townId;
  const towns      = _travelData?.towns || TOWNS_FALLBACK;
  const currentTown= _travelData?.currentTown || gameState.currentTownId || 'pixel_synapse';
  _renderTownList(towns, currentTown);
}

/** Initiate travel to a town — fade out → server request → teleport → fade in */
function travelTo(townId) {
  if (!townId || (gameState.currentTownId === townId)) return;
  closeTravelMenu();
  _doTravelFade(townId);
}

/** Handles the full fade-out → travel → fade-in sequence */
function _doTravelFade(townId) {
  const container = document.getElementById('game-container');
  let fadeEl = document.getElementById('travel-fade');
  if (!fadeEl) {
    fadeEl = document.createElement('div');
    fadeEl.id = 'travel-fade';
    fadeEl.style.cssText = [
      'position:absolute','inset:0','background:#000',
      'opacity:0','z-index:400','pointer-events:all',
      'transition:opacity 0.35s ease-in',
    ].join(';');
    container.appendChild(fadeEl);
  }
  UISystem.showNotification('Boarding transit…', '#aa66ff', 1500);
  requestAnimationFrame(() => { fadeEl.style.opacity = '1'; });

  setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'travel_to', townId }));
    } else {
      // No server — perform fully client-side switch using embedded data
      _clientSwitchTown(townId);
    }
  }, 380);
}

/** Called on travel_result — teleport player and fade back in */
function applyTravelResult(msg) {
  if (!msg.ok) {
    UISystem.showNotification(msg.error || 'Travel failed', '#ff4444', 2500);
    _doTravelFadeIn();
    return;
  }

  const town    = msg.town;
  const mapType = msg.mapType || town.mapType || 'city';
  gameState.currentTownId = town.id;

  console.log(`Switched to Town: ${town.name} (mapType: ${mapType})`);

  // ── 1. Redraw the world map canvas for this town's mapType ──
  if (gameState.scene && gameState.worldSprite) {
    drawTownMap(mapType, gameState.scene, gameState.worldSprite);
  }

  // ── 2. Destroy all town-specific world objects (labels, markers) ──
  if (gameState.worldObjects) {
    for (const obj of gameState.worldObjects) {
      if (obj && obj.destroy) obj.destroy();
    }
  }
  gameState.worldObjects = [];

  // ── 3. Spawn world labels appropriate to this town ──
  if (gameState.scene) {
    spawnTownWorldObjects(gameState.scene, town);
  }

  // ── 4. Teleport player to this town's spawn ──
  const sx = msg.spawnX ?? town.spawnX ?? 400;
  const sy = msg.spawnY ?? town.spawnY ?? 400;
  if (gameState.mySprite) {
    gameState.mySprite.setPosition(sx, sy);
    gameState.myX = sx;
    gameState.myY = sy;
    // Reset camera immediately to new position
    if (gameState.scene?.cameras?.main) {
      gameState.scene.cameras.main.centerOn(sx, sy);
    }
  }

  // ── 5. Destroy old NPC sprites and spawn town NPCs ──
  if (msg.npcs && gameState.scene) {
    for (const [, data] of Object.entries(gameState.npcSprites)) {
      if (data.sprite) data.sprite.destroy();
    }
    // Clear all HTML badges
    for (const npcId of Object.keys(gameState.npcSprites)) {
      UISystem.clearBadge(npcId);
    }
    gameState.npcSprites = {};
    gameState.npcs = msg.npcs;
    for (const npc of gameState.npcs) {
      if (npc) gameState.scene.spawnNPC(npc);
    }
  }

  // ── 6. Apply progression XP ──
  if (msg.progression) applyProgression(msg.progression);

  // ── 7. Cache and display culture ──
  if (msg.culture) {
    gameState.currentCulture = msg.culture;
    _showCultureWelcome(town, msg.culture);
  }

  // ── 8. Update status bar badge ──
  _applyTownBadge(town);

  // ── 9. Notification + fade back in ──
  _doTravelFadeIn();
}

function _doTravelFadeIn() {
  const fadeEl = document.getElementById('travel-fade');
  if (!fadeEl) return;
  setTimeout(() => {
    fadeEl.style.transition = 'opacity 0.5s ease-out';
    fadeEl.style.opacity    = '0';
    setTimeout(() => { fadeEl.style.pointerEvents = 'none'; }, 520);
  }, 80);
}

/** Update the HUD status bar with the current town name and color */
function _applyTownBadge(town) {
  const el = document.getElementById('current-town-badge');
  if (!el || !town) return;
  el.textContent = `${town.icon} ${town.name}`;
  el.style.color = town.color;
  el.title       = town.description || '';
}

/**
 * Show culture welcome — a brief, distinctive toast sequence.
 * "Welcome to Glitch City ⚡" then "Chaotic · Deceptive · Experimental"
 */
function _showCultureWelcome(town, culture) {
  const labels  = culture.labels || [];
  const summary = labels.join(' · ');

  // Line 1: town name with icon
  UISystem.showNotification(
    `${town.icon}  Welcome to ${town.name}`,
    town.color,
    2800
  );

  // Line 2: culture labels — delayed so they don't overlap
  if (summary) {
    setTimeout(() => {
      UISystem.showNotification(summary, town.color + 'cc', 3500);
    }, 2000);
  }

  // Culture stat bar — brief overlay in top-centre
  _showCultureBrief(town, culture);
}

/**
 * Flash a compact culture card at the top of the screen for ~4 seconds.
 */
function _showCultureBrief(town, culture) {
  let card = document.getElementById('culture-card');
  if (!card) {
    card = document.createElement('div');
    card.id = 'culture-card';
    card.style.cssText = [
      'position:absolute', 'top:54px', 'left:50%', 'transform:translateX(-50%)',
      'background:#080810', `border:1px solid ${town.color}`,
      'padding:8px 14px', 'z-index:210',
      "font-family:'Press Start 2P',monospace",
      'pointer-events:none', 'opacity:0',
      'transition:opacity 0.3s',
      'min-width:280px', 'text-align:center',
    ].join(';');
    document.getElementById('game-container').appendChild(card);
  }

  // Culture bars
  const bars = [
    { label: 'Friendliness', val: culture.friendliness, col: '#44ff88' },
    { label: 'Honesty',      val: culture.honesty,      col: '#44aaff' },
    { label: 'Wealth',       val: culture.wealth,       col: '#ffcc44' },
    { label: 'Chaos',        val: culture.chaos,        col: '#ff4444' },
  ];

  card.style.borderColor = town.color;
  card.innerHTML = `
    <div style="font-size:6px;color:${town.color};letter-spacing:2px;margin-bottom:6px;">
      ${town.icon || '◈'} ${town.name.toUpperCase()}
    </div>
    <div style="font-size:4px;color:#556677;margin-bottom:8px;">${town.subtitle || ''}</div>
    ${bars.map(b => `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
        <span style="font-size:4px;color:${b.col};width:68px;text-align:right;">${b.label}</span>
        <div style="flex:1;height:4px;background:#1a1a2a;">
          <div style="width:${b.val}%;height:100%;background:${b.col};"></div>
        </div>
        <span style="font-size:4px;color:#334;width:24px;">${b.val}</span>
      </div>`).join('')}
  `;

  // Fade in, then out after 4s
  requestAnimationFrame(() => { card.style.opacity = '1'; });
  clearTimeout(card._hideTimer);
  card._hideTimer = setTimeout(() => {
    card.style.opacity = '0';
    setTimeout(() => card.remove(), 350);
  }, 4000);
}

function showChatBubble(worldX, worldY, text, durationMs = 2500) {
  return UISystem.showBubble(worldX, worldY, text, durationMs);
}

function updateBubblePositions(cam) {
  UISystem.syncBubbles(cam);
  UISystem.syncBadges(cam);
  UISystem.syncRepDot(gameState.scene);
}

function openDialogue(npc, initialText) {
  gameState.dialogueOpen = true;
  gameState.activeNpcId  = npc.id;
  UISystem.showDialogue(npc, initialText, 'idle');
  document.getElementById('dialogue-input').value = '';
  document.getElementById('dialogue-input').focus();
  updateDialogueActions(npc.id);
}

function closeDialogue() {
  UISystem.hideDialogue();
  gameState.dialogueOpen = false;
  gameState.activeNpcId  = null;
}

function setDialogueText(text, emotion) {
  UISystem.updateDialogueText(text, emotion);
}

function setEmotionUI(emotion) {
  UISystem.updateDialogueText(document.getElementById('dialogue-text')?.textContent || '', emotion);
}

function createNpcBadge(npc) {
  UISystem.createNpcBadge(npc);
  // Bind sprite ref once spawned
  const data = gameState.npcSprites[npc.id];
  if (data?.sprite) UISystem.bindNpcSprite(npc.id, data.sprite);
}

function updateNpcStateBadge(npcId, state, label) {
  UISystem.updateNpcBadge(npcId, state, label);
  // Also bind sprite in case it wasn't ready at badge creation
  const data = gameState.npcSprites[npcId];
  if (data?.sprite) UISystem.bindNpcSprite(npcId, data.sprite);
}

function updateNpcEmotionBadge(npcId, emotion) {
  UISystem.showNpcEmotion(npcId, emotion);
}

function updateNpcBadgePositions() { /* now handled in updateBubblePositions → UISystem.syncBadges */ }

// ─────────────────────────────────────────────
// SECRET REVEAL
// Called when server sends secret_reveal message
// ─────────────────────────────────────────────
function handleSecretReveal(npcId, secretText) {
  const npc = gameState.npcs.find(n => n.id === npcId);
  if (!npc) return;
  setTimeout(() => {
    UISystem.showSecretReveal(npc.name, npc.color, secretText, () => {
      UISystem.updateDialogueText(secretText, 'sad');
    });
  }, 400);
}

function sendDialogueMessage() {
  const input = document.getElementById('dialogue-input');
  const msg   = input.value.trim();
  if (!msg || !gameState.activeNpcId) return;
  input.value = '';
  UISystem.setThinking(true);
  UISystem.updateDialogueText('...', 'neutral');

  // Show player's message as chat bubble above their own sprite
  UISystem.showBubble(gameState.myX, gameState.myY, msg, 2500, PAL.you);

  ws.send(JSON.stringify({ type: 'npc_interact', npcId: gameState.activeNpcId, message: msg }));
}

document.getElementById('dialogue-send').addEventListener('click', sendDialogueMessage);
document.getElementById('dialogue-close').addEventListener('click', closeDialogue);
document.getElementById('dialogue-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  sendDialogueMessage();
  if (e.key === 'Escape') closeDialogue();
  e.stopPropagation();
});

// ─────────────────────────────────────────────
// TILE DRAWING HELPERS
// All tiles are 16×16 pixels drawn per style guide.
// Each uses exactly 3 shades of the same hue.
// ─────────────────────────────────────────────

/** Draw a 16×16 grass tile at canvas pixel (px,py) */
// ─────────────────────────────────────────────
// GBA POKÉMON TILE DRAWING FUNCTIONS
// Each tile is 16×16px — displayed at 16px
// World canvas is 800×800, TILE_SIZE=16
// Colours match classic FireRed/LeafGreen GBA palette
// ─────────────────────────────────────────────

/** Bright GBA grass tile (3 tones, grass tufts) */
function drawGrassTile(ctx, px, py) {
  // Base fill
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = (x * 3 + y * 5) % 7;
      ctx.fillStyle = v < 3 ? '#68c040' : v < 5 ? '#80d858' : '#50a830';
      ctx.fillRect(px + x, py + y, 1, 1);
    }
  }
  // Bright tuft accents
  ctx.fillStyle = '#98f070';
  [[2,1],[6,4],[12,2],[4,9],[10,7],[1,13],[14,11],[8,14],[11,5],[3,12]]
    .forEach(([tx, ty]) => ctx.fillRect(px + tx, py + ty, 1, 2));
  // Dark shadow roots
  ctx.fillStyle = '#50a830';
  [[2,3],[6,6],[12,4],[4,11],[10,9]].forEach(([tx,ty]) => ctx.fillRect(px+tx,py+ty,1,1));
}

/** GBA-style sandy path tile */
function drawRoadTile(ctx, px, py) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = (x * 2 + y * 3) % 5;
      ctx.fillStyle = v < 2 ? '#e0c878' : v < 4 ? '#d0b860' : '#c8a850';
      ctx.fillRect(px + x, py + y, 1, 1);
    }
  }
  // Edge highlight (top)
  ctx.fillStyle = '#f0d890';
  for (let x = 0; x < 16; x++) ctx.fillRect(px + x, py, 1, 1);
  // Edge shadow (bottom)
  ctx.fillStyle = '#b09040';
  for (let x = 0; x < 16; x++) ctx.fillRect(px + x, py + 15, 1, 1);
}

/** GBA cobblestone town square tile */
function drawCobbleTile(ctx, px, py) {
  ctx.fillStyle = '#c0b070';
  ctx.fillRect(px, py, 16, 16);
  // Stone blocks
  const stones = [[1,1,6,5],[8,1,6,5],[1,7,4,5],[6,7,8,5],[1,13,6,2],[8,13,6,2]];
  stones.forEach(([sx, sy, sw, sh]) => {
    ctx.fillStyle = '#d8c880';
    ctx.fillRect(px+sx, py+sy, sw, sh);
    ctx.fillStyle = '#e8d890';  // top highlight
    ctx.fillRect(px+sx, py+sy, sw, 1);
    ctx.fillStyle = '#a09060';  // left shadow
    ctx.fillRect(px+sx, py+sy, 1, sh);
  });
}

/** GBA house wall tile (warm cream + window) */
function drawWallTile(ctx, px, py) {
  // Warm cream wall
  ctx.fillStyle = '#f0e8c0';
  ctx.fillRect(px, py, 16, 16);
  // Shadow on left/bottom
  ctx.fillStyle = '#d8d0a8';
  for (let y = 0; y < 16; y++) { ctx.fillRect(px, py+y, 1, 1); ctx.fillRect(px+y, py+15, 1, 1); }
  // Highlight top/right
  ctx.fillStyle = '#fffff0';
  for (let x = 0; x < 16; x++) ctx.fillRect(px+x, py, 1, 1);
}

/** GBA water tile (bright blue with wave highlights) */
function drawWaterTile(ctx, px, py) {
  // Base blue
  ctx.fillStyle = '#3898f8';
  ctx.fillRect(px, py, 16, 16);
  // Darker mid
  ctx.fillStyle = '#2878d8';
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 16; y++) {
      if ((x + y * 2) % 5 === 0) ctx.fillRect(px+x, py+y, 1, 1);
    }
  }
  // Bright wave highlights
  ctx.fillStyle = '#70c8ff';
  [[2,2],[8,4],[12,1],[4,8],[10,10],[6,13],[14,7]].forEach(([x,y]) => ctx.fillRect(px+x, py+y, 2, 1));
  // White sparkle
  ctx.fillStyle = '#c8f0ff';
  [[3,2],[9,4],[5,8],[11,10]].forEach(([x,y]) => ctx.fillRect(px+x, py+y, 1, 1));
}

/** GBA dirt path tile (for vertical roads) */
function drawPathTile(ctx, px, py) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const n = (x * 7 + y * 11) % 11;
      ctx.fillStyle = n < 5 ? '#c8a858' : n < 8 ? '#b89848' : '#a08838';
      ctx.fillRect(px + x, py + y, 1, 1);
    }
  }
}

/** GBA interior floor tile */
function drawInteriorTile(ctx, px, py) {
  ctx.fillStyle = '#e8d8b0';
  ctx.fillRect(px, py, 16, 16);
  ctx.fillStyle = '#d8c8a0';
  for (let y = 0; y < 16; y += 4) {
    const off = (y % 8 === 0) ? 0 : 4;
    for (let x = off; x < 16; x += 8) ctx.fillRect(px+x, py+y, 7, 3);
  }
  ctx.fillStyle = '#c0b090';
  ctx.fillRect(px, py, 16, 1);
  ctx.fillRect(px, py, 1, 16);
}

function createTextures(scene) {
  const worldGfx = scene.textures.createCanvas('worldmap', WORLD_W, WORLD_H);
  const ctx = worldGfx.getContext();

  // ── BASE GROUND: grass tiles ──
  for (let ty=0; ty<WORLD_H/TILE_SIZE; ty++) {
    for (let tx=0; tx<WORLD_W/TILE_SIZE; tx++) {
      drawGrassTile(ctx, tx*TILE_SIZE, ty*TILE_SIZE);
    }
  }

  // ── MAIN ROADS (cross) ──
  // Vertical road
  for (let ty=0; ty<WORLD_H/TILE_SIZE; ty++) {
    drawRoadTile(ctx, 24*TILE_SIZE, ty*TILE_SIZE);
    drawRoadTile(ctx, 25*TILE_SIZE, ty*TILE_SIZE);
  }
  // Horizontal road
  for (let tx=0; tx<WORLD_W/TILE_SIZE; tx++) {
    drawRoadTile(ctx, tx*TILE_SIZE, 24*TILE_SIZE);
    drawRoadTile(ctx, tx*TILE_SIZE, 25*TILE_SIZE);
  }

  // ── TOWN SQUARE (cobble) ──
  for (let ty=17; ty<32; ty++) {
    for (let tx=17; tx<32; tx++) {
      drawCobbleTile(ctx, tx*TILE_SIZE, ty*TILE_SIZE);
    }
  }
  // Square border
  ctx.strokeStyle = PAL.stoneEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(17*TILE_SIZE+1, 17*TILE_SIZE+1, 15*TILE_SIZE-2, 15*TILE_SIZE-2);

  // ── FOUNTAIN (water tiles in center) ──
  for (let ty=22; ty<26; ty++) {
    for (let tx=22; tx<26; tx++) {
      drawWaterTile(ctx, tx*TILE_SIZE, ty*TILE_SIZE);
    }
  }
  // Fountain rim
  ctx.strokeStyle = PAL.cobble;
  ctx.lineWidth = 2;
  ctx.strokeRect(22*TILE_SIZE, 22*TILE_SIZE, 4*TILE_SIZE, 4*TILE_SIZE);
  // Sparkles
  ctx.fillStyle = PAL.water;
  for (let i=0;i<10;i++) {
    ctx.fillRect(
      22*TILE_SIZE+16 + Math.cos(i*0.63)*14,
      22*TILE_SIZE+16 + Math.sin(i*0.63)*14,
      2,2
    );
  }

  // ── PARK (NW corner, grass + trees) ──
  // Extra dark grass underneath
  for (let ty=1; ty<12; ty++) {
    for (let tx=1; tx<12; tx++) {
      ctx.fillStyle = PAL.grassDark;
      ctx.fillRect(tx*TILE_SIZE, ty*TILE_SIZE, TILE_SIZE, TILE_SIZE);
      drawGrassTile(ctx, tx*TILE_SIZE, ty*TILE_SIZE);
    }
  }
  // Trees (trunk + canopy)
  const trees = [[3,3],[7,2],[5,7],[9,5],[2,9],[10,8],[6,4]];
  trees.forEach(([tx,ty]) => {
    const px=tx*TILE_SIZE, py=ty*TILE_SIZE;
    // Trunk
    ctx.fillStyle = PAL.trunk;
    ctx.fillRect(px+6,py+10,4,6);
    ctx.fillStyle = darkenHex(PAL.trunk,20);
    ctx.fillRect(px+6,py+10,1,6);
    // Canopy layers
    ctx.fillStyle = PAL.treeDark;
    ctx.fillRect(px+1,py+1,14,12);
    ctx.fillStyle = PAL.grassMid;
    ctx.fillRect(px+3,py+2,10,9);
    ctx.fillStyle = PAL.grassBright;
    ctx.fillRect(px+5,py+3,6,5);
    // Highlight
    ctx.fillStyle = '#3d7a1a';
    ctx.fillRect(px+5,py+3,2,2);
    // Outline
    ctx.strokeStyle = PAL.grassDark;
    ctx.lineWidth=1;
    ctx.strokeRect(px+1,py+1,14,12);
  });

  // ── BUILDINGS ──
  // Each building is tagged with its purpose so world labels can reference them.
  // Coordinates are in tile units; pixel = tile * TILE_SIZE.
  //
  //   NE building  (tiles 35–41, 3–8)   → Orion's Workshop
  //   SW building  (tiles 3–8,  35–39)  → Mira's Café
  //   SE building  (tiles 37–44, 37–43) → Market / Trade Hall
  //   N  building  (tiles 19–23, 3–7)   → Town Hall (Mayor Sol)
  //
  const buildings = [
    { x:35, y:3,  w:7, h:6, wall: PAL.wallMid,   roof: PAL.wallDark,  win:'#22334455', label:'WORKSHOP' },
    { x:3,  y:35, w:6, h:5, wall: PAL.wallBlue,  roof: '#100f1a',     win:'#33224455', label:'CAFÉ'     },
    { x:37, y:37, w:8, h:7, wall: PAL.wallGreen, roof: '#0f1a0f',     win:'#22443355', label:'MARKET'   },
    { x:19, y:3,  w:5, h:5, wall: '#242414',     roof: '#2a2000',     win:'#33332255', label:'TOWN HALL'},
  ];
  buildings.forEach((b, bi) => {
    const px=b.x*TILE_SIZE, py=b.y*TILE_SIZE, bw=b.w*TILE_SIZE, bh=b.h*TILE_SIZE;
    // Wall — interior floor tiles
    for (let ty=0;ty<b.h;ty++) for (let tx=0;tx<b.w;tx++)
      drawWallTile(ctx, px+tx*TILE_SIZE, py+ty*TILE_SIZE);
    // Roof strip
    ctx.fillStyle = b.roof;
    ctx.fillRect(px, py, bw, TILE_SIZE+8);
    ctx.fillStyle = lightenHex(b.roof,15);
    ctx.fillRect(px, py, bw, 4);
    // Accent stripe on Town Hall (gold-ish)
    if (bi === 3) {
      ctx.fillStyle = '#443300';
      ctx.fillRect(px, py+TILE_SIZE+2, bw, 3);
    }
    // Windows
    for (let wi=0;wi<Math.min(3,b.w-1);wi++) {
      ctx.fillStyle = b.win;
      ctx.fillRect(px+8+wi*20, py+22, 12,9);
      ctx.fillStyle = '#aaccff0a';
      ctx.fillRect(px+8+wi*20, py+22, 6,4);
    }
    // Door
    ctx.fillStyle = '#1a1008';
    ctx.fillRect(px+bw/2-5, py+bh-18, 10,18);
    ctx.fillStyle = '#a85c2855';
    ctx.fillRect(px+bw/2-5, py+bh-18, 5,18);
    // Building outline
    ctx.strokeStyle = lightenHex(b.wall,10);
    ctx.lineWidth=1;
    ctx.strokeRect(px,py,bw,bh);
  });

  // ── TOWN HALL SIGN BOARD ──
  // A small coloured board above the Town Hall door so it's unmistakable.
  {
    const tx = 19*TILE_SIZE, ty = 3*TILE_SIZE;
    const bw = 5*TILE_SIZE;
    ctx.fillStyle = '#2a2000';
    ctx.fillRect(tx + bw/2 - 20, ty - 8, 40, 8);
    ctx.strokeStyle = '#886600';
    ctx.lineWidth = 1;
    ctx.strokeRect(tx + bw/2 - 20, ty - 8, 40, 8);
    ctx.fillStyle = '#ffcc44';
    ctx.font = '5px "Press Start 2P"';
    ctx.textAlign = 'center';
    ctx.fillText('TOWN HALL', tx + bw/2, ty - 2);
  }

  // ── CAFÉ SIGN ──
  {
    const tx = 3*TILE_SIZE, ty = 35*TILE_SIZE;
    const bw = 6*TILE_SIZE;
    ctx.fillStyle = '#0d1020';
    ctx.fillRect(tx + bw/2 - 22, ty - 8, 44, 8);
    ctx.strokeStyle = '#3344aa';
    ctx.lineWidth = 1;
    ctx.strokeRect(tx + bw/2 - 22, ty - 8, 44, 8);
    ctx.fillStyle = '#E8A598';
    ctx.font = '5px "Press Start 2P"';
    ctx.textAlign = 'center';
    ctx.fillText("MIRA'S CAFÉ", tx + bw/2, ty - 2);
  }

  // ── MARKET SIGN ──
  {
    const tx = 37*TILE_SIZE, ty = 37*TILE_SIZE;
    const bw = 8*TILE_SIZE;
    ctx.fillStyle = '#0d1a0d';
    ctx.fillRect(tx + bw/2 - 22, ty - 8, 44, 8);
    ctx.strokeStyle = '#224422';
    ctx.lineWidth = 1;
    ctx.strokeRect(tx + bw/2 - 22, ty - 8, 44, 8);
    ctx.fillStyle = '#81C784';
    ctx.font = '5px "Press Start 2P"';
    ctx.textAlign = 'center';
    ctx.fillText('MARKET', tx + bw/2, ty - 2);
  }

  // ── PATH TILES in side alleys ──
  for (let i=0;i<WORLD_W/TILE_SIZE;i++) {
    drawPathTile(ctx, i*TILE_SIZE, 13*TILE_SIZE);
    drawPathTile(ctx, 13*TILE_SIZE, i*TILE_SIZE);
  }

  // ── BORDER WALLS ──
  for (let tx=0;tx<WORLD_W/TILE_SIZE;tx++) {
    drawWallTile(ctx, tx*TILE_SIZE, 0);
    drawWallTile(ctx, tx*TILE_SIZE, (WORLD_H/TILE_SIZE-1)*TILE_SIZE);
  }
  for (let ty=1;ty<WORLD_H/TILE_SIZE-1;ty++) {
    drawWallTile(ctx, 0, ty*TILE_SIZE);
    drawWallTile(ctx, (WORLD_W/TILE_SIZE-1)*TILE_SIZE, ty*TILE_SIZE);
  }

  // ── SIGN ──
  ctx.fillStyle = PAL.panel;
  ctx.fillRect(336,240,128,24);
  ctx.strokeStyle = PAL.border;
  ctx.lineWidth=1;
  ctx.strokeRect(336,240,128,24);
  ctx.fillStyle = PAL.nameLt;
  ctx.font = '7px "Press Start 2P"';
  ctx.textAlign='center';
  ctx.fillText('PIXEL SYNAPSE', 400, 255);

  // ── OBJECTS: tables, chairs, trees scattered around the world ──
  // Tables inside buildings (near building positions)
  const tableSpots = [
    [36,5],[38,5],[40,5],[37,7],[39,7],  // NE building area
    [4,36],[5,36],[4,38],                 // SW building area
    [38,39],[40,39],[38,41],[40,41],      // SE building area
    [20,4],[21,4],[22,5],                 // N building area
  ];
  tableSpots.forEach(([tx,ty]) => {
    drawSprite(ctx, SPR_TABLE, tx*TILE_SIZE, ty*TILE_SIZE, 1);
  });

  // Chairs near tables
  const chairSpots = [
    [36,6],[39,6],[37,8],
    [4,37],[5,37],
    [39,40],[41,40],
    [20,5],[22,4],
  ];
  chairSpots.forEach(([tx,ty]) => {
    drawSprite(ctx, SPR_CHAIR, tx*TILE_SIZE, ty*TILE_SIZE, 1);
  });

  // Extra standalone trees scattered outside park
  const extraTrees = [[15,15],[30,5],[5,30],[40,15],[15,40],[28,10],[10,28]];
  extraTrees.forEach(([tx,ty]) => {
    drawSprite(ctx, SPR_TREE, tx*TILE_SIZE, ty*TILE_SIZE, 1);
  });

  // ── TRAIN STATION — east edge of map (tiles 44–49, 22–28) ──
  // The station is the travel hub. Platform + building + tracks + portal glow.
  {
    const S = TILE_SIZE;

    // ── Platform base (stone) ──
    for (let ty = 23; ty <= 27; ty++) {
      for (let tx = 44; tx <= 49; tx++) {
        const px = tx*S, py = ty*S;
        ctx.fillStyle = '#2a2820';
        ctx.fillRect(px, py, S, S);
        ctx.fillStyle = '#3a3530';
        ctx.fillRect(px+1, py+1, S-2, S-2);
      }
    }

    // ── Station building (tiles 44–48, 23–25) ──
    ctx.fillStyle = '#241824';           // dark purple-grey wall
    ctx.fillRect(44*S, 23*S, 5*S, 3*S);
    ctx.fillStyle = '#1a0f2a';           // darker roof strip
    ctx.fillRect(44*S, 23*S, 5*S, S);
    ctx.fillStyle = '#2e1a4a';           // roof highlight
    ctx.fillRect(44*S, 23*S, 5*S, 4);

    // Roof trim stripe
    ctx.fillStyle = '#6644aa';
    ctx.fillRect(44*S, 23*S+3, 5*S, 3);

    // Windows — two purple-lit windows
    ctx.fillStyle = '#44224488';
    ctx.fillRect(44*S+6,  23*S+10, 10, 8);
    ctx.fillRect(44*S+22, 23*S+10, 10, 8);
    ctx.fillStyle = '#bb88ff33';
    ctx.fillRect(44*S+6,  23*S+10, 5, 4);
    ctx.fillRect(44*S+22, 23*S+10, 5, 4);

    // Door
    ctx.fillStyle = '#1a0a2a';
    ctx.fillRect(44*S+36, 25*S+2, 8, S-2);
    ctx.fillStyle = '#6644aa44';
    ctx.fillRect(44*S+36, 25*S+2, 4, S-2);

    // Building outline
    ctx.strokeStyle = '#6644aa';
    ctx.lineWidth = 1;
    ctx.strokeRect(44*S, 23*S, 5*S, 3*S);

    // ── Train tracks — two lines running east-west across bottom of station ──
    for (let tx = 42; tx <= 50; tx++) {
      const px = tx * S;
      // Rail ties (wood sleepers)
      ctx.fillStyle = '#3a2810';
      ctx.fillRect(px, 27*S+4, S, 4);
      ctx.fillRect(px, 27*S+10, S, 4);
      // Rails
      ctx.fillStyle = '#7a7068';
      ctx.fillRect(px, 27*S+5, S, 2);
      ctx.fillRect(px, 27*S+11, S, 2);
    }

    // ── PORTAL / ARRIVAL GATE — glowing archway at tile 46, y=26 ──
    // This is the actual travel interaction point (center ~736, 424)
    const gx = 46*S + S/2;  // 736+8 = 744
    const gy = 26*S;        // 416

    // Portal arch base — two pillars
    ctx.fillStyle = '#2a1a3a';
    ctx.fillRect(gx-12, gy, 6, 24);
    ctx.fillRect(gx+6,  gy, 6, 24);
    ctx.fillStyle = '#6644aa';
    ctx.fillRect(gx-12, gy, 6, 4);
    ctx.fillRect(gx+6,  gy, 6, 4);

    // Portal arch top bar
    ctx.fillStyle = '#3a2050';
    ctx.fillRect(gx-12, gy-4, 24, 5);
    ctx.fillStyle = '#aa66ff';
    ctx.fillRect(gx-12, gy-4, 24, 2);

    // Portal inner glow (two layers — will shimmer via Phaser graphics on top)
    ctx.fillStyle = '#3a1a5a88';
    ctx.fillRect(gx-6, gy, 12, 20);
    ctx.fillStyle = '#7a44aa44';
    ctx.fillRect(gx-4, gy+2, 8, 16);

    // Station sign above building
    ctx.fillStyle = '#1a0f2a';
    ctx.fillRect(44*S + 4, 22*S + 2, 5*S - 8, 10);
    ctx.strokeStyle = '#6644aa';
    ctx.lineWidth = 1;
    ctx.strokeRect(44*S + 4, 22*S + 2, 5*S - 8, 10);
    ctx.fillStyle = '#bb88ff';
    ctx.font = '5px "Press Start 2P"';
    ctx.textAlign = 'center';
    ctx.fillText('TRANSIT HUB', 44*S + 5*S/2, 22*S + 10);

    // Platform edge line
    ctx.fillStyle = '#ffcc4455';
    ctx.fillRect(44*S, 26*S + S - 2, 6*S, 2);
  }

  worldGfx.refresh();

  // ── PLAYER SPRITE — 4 direction textures × 2 walk frames each ──
  const playerFrames = {
    player_down:    SPR_PLAYER_DOWN,
    player_up:      SPR_PLAYER_UP,
    player_right:   SPR_PLAYER_RIGHT,
    player_left:    SPR_PLAYER_LEFT,
    player_down_b:  SPR_PLAYER_DOWN_B,
    player_up_b:    SPR_PLAYER_UP_B,
    player_right_b: SPR_PLAYER_RIGHT_B,
    player_left_b:  SPR_PLAYER_LEFT_B,
  };
  for (const [key, grid] of Object.entries(playerFrames)) {
    const t = scene.textures.createCanvas(key, 16, 16);
    const c = t.getContext();
    c.imageSmoothingEnabled = false;
    drawSprite(c, grid, 0, 0, 1);
    t.refresh();
  }
  console.log('[createTextures] ✓ Player textures:', Object.keys(playerFrames).join(', '));

  // ── NPC BASE SPRITE (fallback, gray) ──
  const npcTex = scene.textures.createCanvas('npc_base', 16, 16);
  const nCtx = npcTex.getContext();
  nCtx.imageSmoothingEnabled = false;
  drawSprite(nCtx, SPR_NPC_IDLE, 0, 0, 1);
  npcTex.refresh();
  console.log('[createTextures] ✓ NPC base texture ready (16×16 art, displayed at 32px via scale=2)');
  console.log('[createTextures] ✓ World map drawn:', WORLD_W + 'x' + WORLD_H, 'tile=' + TILE_SIZE + 'px');
}

// ─────────────────────────────────────────────
// WORLD OBJECT SPAWNING
// Functions that create Phaser text/graphics objects
// for a specific town layout. All objects are pushed
// into gameState.worldObjects so they can be destroyed
// cleanly when the player travels to a new town.
// ─────────────────────────────────────────────

/**
 * Helper — add a text object to the scene and register it for cleanup.
 */
function _addWorldText(scene, x, y, text, style, depth = 5) {
  const obj = scene.add.text(x, y, text, style).setDepth(depth).setOrigin(0.5, 0.5);
  gameState.worldObjects.push(obj);
  return obj;
}

/**
 * Helper — add a graphics object to the scene and register it for cleanup.
 */
function _addWorldGfx(scene, depth = 2) {
  const obj = scene.add.graphics().setDepth(depth);
  gameState.worldObjects.push(obj);
  return obj;
}

/**
 * Spawn the world labels and zone markers for the home city (Pixel Synapse).
 * Called on initial create() and on returning home via travel.
 */
function spawnCityWorldObjects(scene) {
  const WORLD_LABELS = [
    [312, 44,  'TOWN HALL',        '#ffcc44', 'Mayor Sol · Vote Here'],
    [48,  538, "MIRA'S CAFÉ",      '#E8A598', 'Shop · Jobs · Gossip' ],
    [592, 44,  "ORION'S WORKSHOP", '#FF6B35', 'Shop · Jobs'          ],
    [624, 566, 'MARKET',           '#81C784', 'Trade · Buy · Sell'   ],
    [400, 350, 'TOWN SQUARE',      '#aabbff', 'Events · Politics'    ],
    [128, 116, 'THE PARK',         '#44ff88', 'Nature · Gossip'      ],
  ];
  for (const [wx, wy, text, color, sub] of WORLD_LABELS) {
    const t = scene.add.text(wx, wy, text, {
      fontSize: '6px', fontFamily: "'Press Start 2P'",
      color, stroke: '#000000', strokeThickness: 3,
      backgroundColor: '#00000055', padding: { x: 4, y: 2 },
      align: 'center',
    }).setDepth(5).setOrigin(0.5, 1);
    gameState.worldObjects.push(t);
    if (sub) {
      const s = scene.add.text(wx, wy + 3, sub, {
        fontSize: '4px', fontFamily: "'Press Start 2P'",
        color: '#556677', stroke: '#000000', strokeThickness: 2, align: 'center',
      }).setDepth(5).setOrigin(0.5, 0);
      gameState.worldObjects.push(s);
    }
  }

  const ZONE_MARKERS = [
    [312, 96,  18, 0xffcc44, 'VOTE' ],
    [48,  580, 18, 0xe8a598, 'SHOP' ],
    [592, 96,  18, 0xff6b35, 'SHOP' ],
    [624, 608, 18, 0x81c784, 'TRADE'],
  ];
  const mgfx = _addWorldGfx(scene, 2);
  for (const [cx, cy, r, col, lbl] of ZONE_MARKERS) {
    mgfx.lineStyle(1, col, 0.5);  mgfx.strokeCircle(cx, cy, r);
    mgfx.fillStyle(col, 0.08);    mgfx.fillCircle(cx, cy, r);
    const lt = scene.add.text(cx, cy, lbl, {
      fontSize: '4px', fontFamily: "'Press Start 2P'",
      color: '#' + col.toString(16).padStart(6,'0'),
      stroke: '#000', strokeThickness: 2, alpha: 0.7,
    }).setDepth(3).setOrigin(0.5, 0.5);
    gameState.worldObjects.push(lt);
  }
}

/**
 * Spawn world labels appropriate to the given town.
 * Called after every town switch (including home).
 */
function spawnTownWorldObjects(scene, town) {
  if (!town) return;

  // Every town gets its name as a big centred label
  const nameLabel = scene.add.text(WORLD_W / 2, 30, town.name.toUpperCase(), {
    fontSize: '8px', fontFamily: "'Press Start 2P'",
    color: town.color, stroke: '#000000', strokeThickness: 4,
    backgroundColor: '#00000088', padding: { x: 6, y: 3 },
  }).setDepth(5).setOrigin(0.5, 0);
  gameState.worldObjects.push(nameLabel);

  const sub = scene.add.text(WORLD_W / 2, 52, town.subtitle || '', {
    fontSize: '4px', fontFamily: "'Press Start 2P'",
    color: '#556677', stroke: '#000000', strokeThickness: 2,
  }).setDepth(5).setOrigin(0.5, 0);
  gameState.worldObjects.push(sub);

  // Town-specific labels
  switch (town.mapType || 'city') {
    case 'city':
      spawnCityWorldObjects(scene);
      break;
    case 'docks':
      _spawnSimpleLabels(scene, [
        [200, 480, 'DOCKYARD',    '#00E5FF', 'Jobs · Trade'     ],
        [600, 200, 'WAREHOUSE',   '#00cccc', 'Storage · Market' ],
        [400, 620, 'HARBOUR',     '#00aacc', 'Fishing · Gossip' ],
        [700, 400, 'TRANSIT HUB', '#aa66ff', '[E] TRAVEL'       ],
      ]);
      _spawnZoneMarkers(scene, [
        [200, 500, 22, 0x00E5FF, 'WORK'],
        [600, 220, 22, 0x00cccc, 'SHOP'],
        [400, 640, 22, 0x00aacc, 'TALK'],
      ]);
      break;
    case 'village':
      _spawnSimpleLabels(scene, [
        [400, 600, 'VILLAGE GREEN', '#81C784', 'Community Hub'    ],
        [300, 280, 'ELDER\'S GROVE', '#66aa66', 'Ancient Wisdom'  ],
        [500, 380, 'HERB GARDEN',   '#44cc88', 'Ivy\'s Domain'   ],
        [700, 400, 'TRANSIT HUB',   '#aa66ff', '[E] TRAVEL'      ],
      ]);
      _spawnZoneMarkers(scene, [
        [400, 620, 20, 0x81C784, 'MEET'],
        [300, 300, 20, 0x66aa66, 'TALK'],
        [500, 400, 20, 0x44cc88, 'SHOP'],
      ]);
      break;
    case 'fortress':
      _spawnSimpleLabels(scene, [
        [400, 380, 'KEEP',        '#8D6E63', 'Watch HQ'          ],
        [130, 250, 'BARRACKS',    '#aa8877', 'Guard Jobs'        ],
        [620, 250, 'BARRACKS',    '#aa8877', 'Guard Jobs'        ],
        [400, 700, 'SOUTH GATE',  '#cc9966', 'Entry Point'       ],
        [700, 400, 'TRANSIT HUB', '#aa66ff', '[E] TRAVEL'        ],
      ]);
      _spawnZoneMarkers(scene, [
        [400, 400, 22, 0x8D6E63, 'HQ'  ],
        [130, 270, 22, 0xaa8877, 'WORK'],
        [620, 270, 22, 0xaa8877, 'WORK'],
      ]);
      break;
    case 'glitch':
      _spawnSimpleLabels(scene, [
        [400, 180, 'NULL SECTOR',  '#00ffcc', '??? zone'          ],
        [600, 340, 'DATA SHARD',   '#ff00cc', 'High risk, high pay'],
        [200, 440, 'VOID MARKET',  '#ccff00', 'Volatile prices'   ],
        [700, 400, 'TRANSIT HUB',  '#aa66ff', '[E] TRAVEL'        ],
      ]);
      _spawnZoneMarkers(scene, [
        [400, 200, 18, 0x00ffcc, 'TALK'],
        [600, 360, 18, 0xff00cc, 'WORK'],
        [200, 460, 18, 0xccff00, 'SHOP'],
      ]);
      break;
  }
}

/** Spawn a batch of simple floating labels and register them for cleanup */
function _spawnSimpleLabels(scene, labels) {
  for (const [wx, wy, text, color, sub] of labels) {
    const t = scene.add.text(wx, wy, text, {
      fontSize: '6px', fontFamily: "'Press Start 2P'",
      color, stroke: '#000000', strokeThickness: 3,
      backgroundColor: '#00000055', padding: { x:4, y:2 },
    }).setDepth(5).setOrigin(0.5, 1);
    gameState.worldObjects.push(t);
    if (sub) {
      const s = scene.add.text(wx, wy + 3, sub, {
        fontSize: '4px', fontFamily: "'Press Start 2P'",
        color: '#556677', stroke: '#000', strokeThickness: 2,
      }).setDepth(5).setOrigin(0.5, 0);
      gameState.worldObjects.push(s);
    }
  }
}

/** Spawn zone markers and register them for cleanup */
function _spawnZoneMarkers(scene, markers) {
  const gfx = _addWorldGfx(scene, 2);
  for (const [cx, cy, r, col, lbl] of markers) {
    gfx.lineStyle(1, col, 0.5); gfx.strokeCircle(cx, cy, r);
    gfx.fillStyle(col, 0.08);   gfx.fillCircle(cx, cy, r);
    const lt = scene.add.text(cx, cy, lbl, {
      fontSize: '4px', fontFamily: "'Press Start 2P'",
      color: '#' + col.toString(16).padStart(6,'0'),
      stroke: '#000', strokeThickness: 2, alpha: 0.7,
    }).setDepth(3).setOrigin(0.5, 0.5);
    gameState.worldObjects.push(lt);
  }
}

// ─────────────────────────────────────────────
// TOWN MAP SYSTEM
// drawTownMap(mapType) redraws the 'worldmap' canvas texture
// and refreshes the world sprite, making each town look different.
//
// Map types:
//   city     — default Pixel Synapse layout (green grass, 4 buildings)
//   docks    — steel-blue water-edge, warehouse grid, cranes
//   village  — dense forest, few small houses, earthy paths
//   fortress — grey stone, thick walls, military courtyard
//   glitch   — corrupted tiles, neon colours, fragmented layout
// ─────────────────────────────────────────────

/**
 * Redraw the worldmap canvas for the given mapType and refresh the scene.
 * Called during travel to make each town visually unique.
 *
 * @param {string}            mapType — 'city'|'docks'|'village'|'fortress'|'glitch'
 * @param {Phaser.Scene}      scene
 * @param {Phaser.GameObjects.Image} worldSprite — the image to update
 */
function drawTownMap(mapType, scene, worldSprite) {
  // Get or recreate the canvas texture
  let tex = scene.textures.get('worldmap');
  if (!tex || tex.key === '__MISSING') {
    tex = scene.textures.createCanvas('worldmap', WORLD_W, WORLD_H);
  }
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;

  // Clear
  ctx.fillStyle = '#1a3010';  // GBA dark-green void
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  switch (mapType) {
    case 'industrial':
    case 'docks':    _drawIndustrial(ctx); break;
    case 'village':  _drawVillage(ctx);    break;
    case 'fortress': _drawFortress(ctx);   break;
    case 'chaotic':
    case 'glitch':   _drawChaotic(ctx);    break;
    default:
      // 'city' — restore original grass/road layout
      _drawCity(ctx);
      break;
  }

  tex.refresh();
  if (worldSprite) worldSprite.setTexture('worldmap');
  console.log(`[travel] Map redrawn → ${mapType}`);
}

// ── INDUSTRIAL MAP — steel-blue harbour, warehouse grid, dark tones ──
function _drawIndustrial(ctx) {
  const S = TILE_SIZE;
  const W = WORLD_W / S, H = WORLD_H / S;

  // Water fills south half (rows 28–49)
  for (let ty = 28; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      drawWaterTile(ctx, tx*S, ty*S);
    }
  }
  // Stone dock platform (rows 22–27)
  for (let ty = 22; ty < 28; ty++) {
    for (let tx = 0; tx < W; tx++) {
      ctx.fillStyle = ty === 22 ? '#2a2828' : '#1e1c1c';
      ctx.fillRect(tx*S, ty*S, S, S);
      ctx.fillStyle = '#3a3535';
      ctx.fillRect(tx*S, ty*S, S, 1);
    }
  }
  // Ground (north — dark steel)
  for (let ty = 0; ty < 22; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const v = (tx + ty) % 3;
      ctx.fillStyle = v === 0 ? '#1a1c24' : v === 1 ? '#141620' : '#0e1018';
      ctx.fillRect(tx*S, ty*S, S, S);
    }
  }
  // Grid roads (every 8 tiles)
  for (let ty = 0; ty < 22; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (tx % 8 === 0 || ty % 8 === 0) drawRoadTile(ctx, tx*S, ty*S);
    }
  }
  // Warehouses — 6 chunky dark buildings
  const warehouses = [
    {x:1, y:1,  w:6, h:5, col:'#1e1a2a'}, {x:9,  y:1,  w:7, h:5, col:'#1a1e2a'},
    {x:18,y:1,  w:6, h:5, col:'#1e1a2a'}, {x:26, y:1,  w:7, h:5, col:'#242028'},
    {x:34,y:1,  w:6, h:5, col:'#1a2028'}, {x:42, y:1,  w:6, h:5, col:'#201a28'},
  ];
  warehouses.forEach(b => {
    const px=b.x*S, py=b.y*S, bw=b.w*S, bh=b.h*S;
    ctx.fillStyle = b.col;  ctx.fillRect(px, py, bw, bh);
    ctx.fillStyle = '#2e2a40'; ctx.fillRect(px, py, bw, 8);  // roof
    ctx.strokeStyle='#3a3550'; ctx.lineWidth=1; ctx.strokeRect(px,py,bw,bh);
    // Loading door
    ctx.fillStyle='#0a080e'; ctx.fillRect(px+bw/2-6, py+bh-20, 12, 20);
  });
  // Cranes (simple pixel art)
  [[8,21],[24,21],[40,21]].forEach(([tx,ty]) => {
    const px=tx*S, py=ty*S;
    ctx.fillStyle='#556677'; ctx.fillRect(px+6,py-32,3,34); // arm
    ctx.fillRect(px+6,py-32,20,3);                           // boom
    ctx.fillStyle='#ffcc44'; ctx.fillRect(px+24,py-32,2,14); // hook cable
  });
  // Dock name sign
  _drawSign(ctx, WORLD_W/2, 22*S-10, 'NEON DOCKS', '#00E5FF');
}

// ── VILLAGE MAP — dense trees, earthy paths, scattered small cottages ──
function _drawVillage(ctx) {
  const S = TILE_SIZE;
  const W = WORLD_W/S, H = WORLD_H/S;

  // Base — rich earthy ground (warm brown-green)
  for (let ty=0;ty<H;ty++) for (let tx=0;tx<W;tx++) {
    const v=(tx*3+ty*2)%5;
    ctx.fillStyle = v<2?'#1a2a0a' : v<4?'#142208' : '#0e1a06';
    ctx.fillRect(tx*S,ty*S,S,S);
  }
  // Dense tree cover — ~60% of map
  const rng = (seed) => { let x=seed; for(let i=0;i<3;i++) x=((x*1664525+1013904223)&0xffffffff)>>>0; return x/0xffffffff; };
  for (let ty=0;ty<H;ty++) for (let tx=0;tx<W;tx++) {
    if (rng(tx*100+ty*7+3)*10 < 5.5) drawSprite(ctx, SPR_TREE, tx*S, ty*S, 1);
  }
  // Winding dirt paths (warm tan)
  const pathTiles = new Set();
  // Horizontal snake path
  for (let tx=0;tx<W;tx++) {
    const ty = Math.round(25 + Math.sin(tx*0.3)*5);
    for (let dy=-1;dy<=1;dy++) { pathTiles.add(`${tx},${Math.max(0,Math.min(H-1,ty+dy))}`); }
  }
  // Vertical path
  for (let ty=0;ty<H;ty++) {
    const tx = Math.round(24 + Math.cos(ty*0.25)*4);
    for (let dx=-1;dx<=1;dx++) { pathTiles.add(`${Math.max(0,Math.min(W-1,tx+dx))},${ty}`); }
  }
  pathTiles.forEach(key => {
    const [tx,ty]=key.split(',').map(Number);
    ctx.fillStyle='#4a3820'; ctx.fillRect(tx*S,ty*S,S,S);
    ctx.fillStyle='#5a4828'; ctx.fillRect(tx*S+2,ty*S+2,S-4,S-4);
  });
  // Small cottages (5 scattered)
  const cottages = [{x:10,y:8},{x:28,y:12},{x:18,y:28},{x:38,y:20},{x:8,y:36}];
  cottages.forEach(c => {
    const px=c.x*S,py=c.y*S,bw=4*S,bh=3*S;
    ctx.fillStyle='#3a2820'; ctx.fillRect(px,py,bw,bh);
    ctx.fillStyle='#2a1810'; ctx.fillRect(px,py,bw,S+4); // thatched roof (dark)
    ctx.fillStyle='#5a3820'; ctx.fillRect(px,py,bw,3);
    ctx.fillStyle='#88441822'; ctx.fillRect(px+6,py+10,8,7); // window
    ctx.strokeStyle='#5a4030'; ctx.lineWidth=1; ctx.strokeRect(px,py,bw,bh);
  });
  // Village well in centre
  { const px=25*S,py=25*S;
    ctx.fillStyle='#2a2020'; ctx.fillRect(px-12,py-12,24,24);
    ctx.fillStyle='#3a3030'; ctx.fillRect(px-8,py-8,16,16);
    ctx.fillStyle='#1a1a2a'; ctx.fillRect(px-4,py-4,8,8);
    ctx.strokeStyle='#4a4040'; ctx.lineWidth=1; ctx.strokeRect(px-12,py-12,24,24);
  }
  _drawSign(ctx, WORLD_W/2, 40, 'VERDANT HOLLOW', '#81C784');
}

// ── FORTRESS MAP — grey stone, thick walls, military courtyard ──
function _drawFortress(ctx) {
  const S = TILE_SIZE;
  const W = WORLD_W/S, H = WORLD_H/S;

  // Ground — cold grey flagstone
  for (let ty=0;ty<H;ty++) for (let tx=0;tx<W;tx++) {
    const v=(tx+ty)%4;
    ctx.fillStyle = v<1?'#1e1e20' : v<3?'#181818' : '#141416';
    ctx.fillRect(tx*S,ty*S,S,S);
    // Flagstone lines
    if (tx%4===0||ty%4===0) { ctx.fillStyle='#0e0e10'; ctx.fillRect(tx*S,ty*S,1,S); }
  }
  // Outer walls — thick border 2 tiles wide
  for (let tx=0;tx<W;tx++) {
    for (let wt=0;wt<2;wt++) {
      drawWallTile(ctx,tx*S,wt*S); drawWallTile(ctx,tx*S,(H-1-wt)*S);
    }
  }
  for (let ty=2;ty<H-2;ty++) {
    for (let wt=0;wt<2;wt++) {
      drawWallTile(ctx,wt*S,ty*S); drawWallTile(ctx,(W-1-wt)*S,ty*S);
    }
  }
  // Battlements (crenellations) — alternating wall/gap on top edge
  for (let tx=0;tx<W;tx+=2) {
    ctx.fillStyle='#2a2a2e'; ctx.fillRect(tx*S,0,S,6);
    ctx.fillStyle='#0a0a0e'; ctx.fillRect((tx+1)*S,0,S,4);
  }
  // Interior roads (military grid — every 6 tiles)
  for (let ty=2;ty<H-2;ty++) for (let tx=2;tx<W-2;tx++) {
    if (tx%6===3||ty%6===3) drawRoadTile(ctx,tx*S,ty*S);
  }
  // Main keep (centre)
  { const kx=18*S,ky=18*S,kw=14*S,kh=14*S;
    for (let ty=18;ty<32;ty++) for (let tx=18;tx<32;tx++) drawWallTile(ctx,tx*S,ty*S);
    ctx.fillStyle='#242428'; ctx.fillRect(kx,ky,kw,kh);
    ctx.fillStyle='#1e1e22'; ctx.fillRect(kx,ky,kw,S);
    ctx.strokeStyle='#3a3a40'; ctx.lineWidth=2; ctx.strokeRect(kx,ky,kw,kh);
    // Gate
    ctx.fillStyle='#0a0a0e'; ctx.fillRect(kx+kw/2-8,ky+kh-20,16,20);
    ctx.fillStyle='#4a3010'; ctx.fillRect(kx+kw/2-6,ky+kh-18,12,16);
    // Corner towers
    [[18,18],[30,18],[18,30],[30,30]].forEach(([tx,ty]) => {
      ctx.fillStyle='#2e2e34'; ctx.fillRect(tx*S-4,ty*S-4,S+8,S+8);
      ctx.fillStyle='#1e1e24'; ctx.fillRect(tx*S,ty*S,S,S);
    });
  }
  // Barracks (left, right)
  [{x:4,y:8,w:8,h:6},{x:36,y:8,w:8,h:6}].forEach(b=>{
    const px=b.x*S,py=b.y*S,bw=b.w*S,bh=b.h*S;
    ctx.fillStyle='#242428'; ctx.fillRect(px,py,bw,bh);
    ctx.fillStyle='#1a1a1e'; ctx.fillRect(px,py,bw,8);
    ctx.strokeStyle='#3a3a40'; ctx.lineWidth=1; ctx.strokeRect(px,py,bw,bh);
    for(let i=1;i<b.w-1;i+=2){
      ctx.fillStyle='#33334422'; ctx.fillRect(px+i*S,py+12,10,8);
    }
  });
  _drawSign(ctx, WORLD_W/2, 2*S+4, 'IRON GATE', '#8D6E63');
}

// ── CHAOTIC MAP — corrupted tiles, neon fragments, broken grid ──
function _drawChaotic(ctx) {
  const S = TILE_SIZE;
  const W = WORLD_W/S, H = WORLD_H/S;
  const rng=(s)=>{ let x=s*2654435761|0; x^=x>>>16; x*=0x45d9f3b; x^=x>>>16; return (x>>>0)/0xffffffff; };

  // Base — void black with colour noise
  for (let ty=0;ty<H;ty++) for (let tx=0;tx<W;tx++) {
    const r=rng(tx*97+ty*31+1);
    if (r<0.05)      ctx.fillStyle='#0a1a1a';  // teal fragment
    else if (r<0.08) ctx.fillStyle='#1a0a1a';  // purple fragment
    else if (r<0.10) ctx.fillStyle='#001a0a';  // green fragment
    else             ctx.fillStyle='#060608';
    ctx.fillRect(tx*S,ty*S,S,S);
  }
  // Broken roads — fragmented, misaligned
  for (let ty=0;ty<H;ty++) for (let tx=0;tx<W;tx++) {
    const on = (tx+Math.round(Math.sin(ty*0.7)*3))%7===0 || (ty+Math.round(Math.cos(tx*0.5)*2))%7===0;
    if (on && rng(tx*13+ty*7)>0.3) drawRoadTile(ctx,tx*S,ty*S);
  }
  // Neon line glitches (bright horizontal scars)
  for (let i=0;i<12;i++) {
    const ty = Math.floor(rng(i*999)*H);
    const len = Math.floor(rng(i*777+1)*12)+3;
    const tx0 = Math.floor(rng(i*555+2)*(W-len));
    const cols = ['#00ffcc','#ff00cc','#ccff00','#00ccff'];
    ctx.fillStyle = cols[i%cols.length] + '44';
    ctx.fillRect(tx0*S, ty*S, len*S, 2);
    ctx.fillStyle = cols[i%cols.length] + 'aa';
    ctx.fillRect(tx0*S, ty*S, len*S, 1);
  }
  // Glitched buildings — skewed, wrong colours
  const glitchBuildings=[
    {x:5,y:5,w:6,h:5,col:'#0a2a2a'},{x:14,y:3,w:4,h:7,col:'#1a002a'},
    {x:22,y:8,w:7,h:4,col:'#002a1a'},{x:32,y:5,w:5,h:6,col:'#2a001a'},
    {x:40,y:10,w:6,h:5,col:'#0a1a2a'},{x:8,y:30,w:5,h:6,col:'#1a2a00'},
    {x:20,y:28,w:8,h:5,col:'#2a1a00'},{x:34,y:32,w:6,h:4,col:'#00182a'},
  ];
  glitchBuildings.forEach((b,i) => {
    const px=b.x*S,py=b.y*S,bw=b.w*S,bh=b.h*S;
    // Offset glitch effect
    const glx = Math.round(rng(i*3)*6-3);
    ctx.fillStyle=b.col; ctx.fillRect(px+glx,py,bw,bh);
    ctx.fillStyle='#ffffff08'; ctx.fillRect(px+glx,py,bw,3);
    // Neon border
    const nc = ['#00ffcc','#ff00cc','#ccff00','#00ccff'][i%4];
    ctx.strokeStyle=nc+'88'; ctx.lineWidth=1; ctx.strokeRect(px+glx,py,bw,bh);
    // Glitch scanlines
    for(let ly=py;ly<py+bh;ly+=3){
      ctx.fillStyle='#00000044'; ctx.fillRect(px+glx,ly,bw,1);
    }
  });
  // Error text fragments scattered on floor
  ctx.font='5px "Press Start 2P"';
  [['ERR:0x4F',80,120,'#ff004466'],['NULL',300,200,'#00ff4466'],
   ['???',500,350,'#ff44ff66'],['VOID',150,450,'#00ffff44']].forEach(([t,x,y,c])=>{
    ctx.fillStyle=c; ctx.fillText(t,x,y);
  });
  _drawSign(ctx, WORLD_W/2, 20, 'GLITCH CITY', '#00ffcc');
}

/** Draw a small sign label centred at (cx, cy) on the world canvas */
function _drawSign(ctx, cx, cy, text, color) {
  const w = text.length * 6 + 14;
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(cx - w/2, cy - 7, w, 12);
  ctx.strokeStyle = color + '88';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - w/2, cy - 7, w, 12);
  ctx.fillStyle = color;
  ctx.font = '5px "Press Start 2P"';
  ctx.textAlign = 'center';
  ctx.fillText(text, cx, cy + 2);
}

// ── CITY MAP — restores Pixel Synapse home layout ──
// Full redraw matching the original createTextures() world.
function _drawCity(ctx) {
  const S = TILE_SIZE;
  const W = WORLD_W / S, H = WORLD_H / S;

  // Grass base
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      drawGrassTile(ctx, tx*S, ty*S);
    }
  }

  // Park area (top-left)
  for (let ty = 1; ty <= 12; ty++) {
    for (let tx = 1; tx <= 12; tx++) {
      ctx.fillStyle = PAL.grassDark;
      ctx.fillRect(tx*S, ty*S, S, S);
    }
  }

  // Trees in park
  for (let ty = 2; ty <= 11; ty += 2) {
    for (let tx = 2; tx <= 11; tx += 2) {
      drawSprite(ctx, SPR_TREE, tx*S, ty*S, 1);
    }
  }

  // Vertical road (col 24–25)
  for (let ty = 0; ty < H; ty++) {
    drawRoadTile(ctx, 24*S, ty*S);
    drawRoadTile(ctx, 25*S, ty*S);
  }
  // Horizontal road (row 24–25)
  for (let tx = 0; tx < W; tx++) {
    drawRoadTile(ctx, tx*S, 24*S);
    drawRoadTile(ctx, tx*S, 25*S);
  }

  // Town square (centre)
  for (let ty = 20; ty <= 28; ty++) {
    for (let tx = 20; tx <= 28; tx++) {
      drawCobbleTile(ctx, tx*S, ty*S);
    }
  }
  // Fountain
  for (let ty = 23; ty <= 25; ty++) {
    for (let tx = 23; tx <= 25; tx++) {
      ctx.fillStyle = PAL.fountain;
      ctx.fillRect(tx*S, ty*S, S, S);
    }
  }
  ctx.fillStyle = PAL.water;
  ctx.fillRect(23*S+4, 23*S+4, 2*S-8, 2*S-8);

  // Buildings (same as createTextures)
  const buildings = [
    { x:35, y:3,  w:7, h:6, wall: PAL.wallMid,   roof: PAL.wallDark, win:'#22334455', label:'WORKSHOP' },
    { x:3,  y:35, w:6, h:5, wall: PAL.wallBlue,  roof: '#100f1a',    win:'#33224455', label:'CAFE'     },
    { x:37, y:37, w:8, h:7, wall: PAL.wallGreen, roof: '#0f1a0f',    win:'#22443355', label:'MARKET'   },
    { x:19, y:3,  w:5, h:5, wall: '#242414',     roof: '#2a2000',    win:'#33332255', label:'TOWN HALL'},
  ];
  buildings.forEach(b => {
    const px=b.x*S, py=b.y*S, bw=b.w*S, bh=b.h*S;
    for (let ty=0;ty<b.h;ty++) for (let tx=0;tx<b.w;tx++) drawWallTile(ctx, px+tx*S, py+ty*S);
    ctx.fillStyle=b.roof;  ctx.fillRect(px,py,bw,S+8);
    ctx.fillStyle=lightenHex(b.roof,15); ctx.fillRect(px,py,bw,4);
    for (let wi=0;wi<Math.min(3,b.w-1);wi++) {
      ctx.fillStyle=b.win; ctx.fillRect(px+8+wi*20,py+22,12,9);
      ctx.fillStyle='#aaccff0a'; ctx.fillRect(px+8+wi*20,py+22,6,4);
    }
    ctx.fillStyle='#1a1008'; ctx.fillRect(px+bw/2-5,py+bh-18,10,18);
    ctx.strokeStyle=lightenHex(b.wall,10); ctx.lineWidth=1; ctx.strokeRect(px,py,bw,bh);
  });

  // Path tiles
  for (let i=0;i<W;i++) {
    drawPathTile(ctx, i*S, 13*S);
    drawPathTile(ctx, 13*S, i*S);
  }

  // Border walls
  for (let tx=0;tx<W;tx++) {
    drawWallTile(ctx, tx*S, 0); drawWallTile(ctx, tx*S, (H-1)*S);
  }
  for (let ty=1;ty<H-1;ty++) {
    drawWallTile(ctx, 0, ty*S); drawWallTile(ctx, (W-1)*S, ty*S);
  }

  // Central sign
  ctx.fillStyle=PAL.panel; ctx.fillRect(336,240,128,24);
  ctx.strokeStyle=PAL.border; ctx.lineWidth=1; ctx.strokeRect(336,240,128,24);
  ctx.fillStyle=PAL.nameLt; ctx.font='7px "Press Start 2P"';
  ctx.textAlign='center'; ctx.fillText('PIXEL SYNAPSE',400,255);

  // Extra trees
  [[15,15],[30,5],[5,30],[40,15],[15,40],[28,10],[10,28]].forEach(([tx,ty])=>{
    drawSprite(ctx, SPR_TREE, tx*S, ty*S, 1);
  });

  // Train station pixel art (east edge — same as createTextures)
  const stS = S;
  for (let ty=23;ty<=27;ty++) for (let tx=44;tx<=49;tx++) {
    ctx.fillStyle='#2a2820'; ctx.fillRect(tx*stS,ty*stS,stS,stS);
    ctx.fillStyle='#3a3530'; ctx.fillRect(tx*stS+1,ty*stS+1,stS-2,stS-2);
  }
  ctx.fillStyle='#241824'; ctx.fillRect(44*stS,23*stS,5*stS,3*stS);
  ctx.fillStyle='#1a0f2a'; ctx.fillRect(44*stS,23*stS,5*stS,stS);
  ctx.fillStyle='#6644aa'; ctx.fillRect(44*stS,23*stS+3,5*stS,3);
  _drawSign(ctx, 44*stS+5*stS/2, 22*stS+10, 'TRANSIT HUB', '#bb88ff');
}

// ─────────────────────────────────────────────
// MAIN PHASER SCENE
// ─────────────────────────────────────────────
class GameScene extends Phaser.Scene {
  constructor() { super({ key: 'GameScene' }); }

  preload() {}

  create() {
    gameState.scene = this;
    createTextures(this);

    // World — store reference on gameState so travel can redraw it
    this.worldSprite = this.add.image(0,0,'worldmap').setOrigin(0,0);
    gameState.worldSprite = this.worldSprite;

    // Camera
    this.cameras.main.setBounds(0,0,WORLD_W,WORLD_H);
    this.physics.world.setBounds(0,0,WORLD_W,WORLD_H);

    // Local player — starts facing down
    gameState.mySprite = this.physics.add.sprite(gameState.myX, gameState.myY, 'player_down');
    gameState.mySprite.setCollideWorldBounds(true);
    gameState.mySprite.setScale(2);   // 16px art → 32px display
    gameState.mySprite.setDepth(10);
    console.log('[sprite] player_down loaded, scale=2, size=16→32px');
    this.cameras.main.startFollow(gameState.mySprite, true, CAM_LERP, CAM_LERP);
    this._playerDir = 'down';
    this._walkFrame = 0;
    this._walkTimer = 0;

    // Player name tag
    this.myNameTag = this.add.text(0, 0, myName, {
      fontSize: '6px', fontFamily: "'Press Start 2P'",
      color: PAL.you, stroke: '#000000', strokeThickness: 2
    }).setDepth(11).setOrigin(0.5, 1);
    gameState.scene = this; // ensure scene ref is set before applyReputation is called

    // Interact [E] prompt
    this.interactPrompt = this.add.text(0,0,'[E]',{
      fontSize: '7px', fontFamily:"'Press Start 2P'",
      color: PAL.eprompt, stroke:'#000',strokeThickness:2,
      backgroundColor:'#00000077', padding:{x:3,y:2}
    }).setDepth(20).setVisible(false);

    // Input
    gameState.cursors    = this.input.keyboard.createCursorKeys();
    gameState.wasd       = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
    gameState.interactKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    // M key — open/close world map
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M)
      .on('down', () => {
        if (document.getElementById('world-map-overlay').style.display !== 'none') {
          closeWorldMap();
        } else {
          openWorldMap();
        }
      });
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC)
      .on('down', () => {
        if (document.getElementById('world-map-overlay').style.display !== 'none') { closeWorldMap(); return; }
        if (document.getElementById('travel-overlay').style.display === 'block') { closeTravelMenu(); return; }
        if (document.getElementById('vote-overlay').style.display   === 'block') { closeVote();       return; }
        if (document.getElementById('shop-overlay').style.display   === 'block') { closeShop();       return; }
        if (gameState.dialogueOpen) closeDialogue();
      });
    gameState.interactKey.on('down', () => {
      if (document.getElementById('world-map-overlay').style.display !== 'none') { closeWorldMap(); return; }
      if (document.getElementById('travel-overlay').style.display === 'block') { closeTravelMenu(); return; }
      if (document.getElementById('vote-overlay').style.display   === 'block') { closeVote();       return; }
      if (document.getElementById('shop-overlay').style.display   === 'block') { closeShop();       return; }
      if (!gameState.dialogueOpen) this.tryInteract();
    });

    // Spawn NPCs
    for (const npc of gameState.npcs) this.spawnNPC(npc);

    // ── WORLD OBJECTS — stored so travel can destroy and rebuild them ──
    // All non-player, non-NPC scene objects that are town-specific live here.
    gameState.worldObjects = [];

    // Spawn world labels + zone markers for the home town (city)
    spawnCityWorldObjects(this);

    // Job progress bar (world-space, shown while a job is active)
    this.jobBar = this.add.graphics().setDepth(25).setVisible(false);
    this.jobBarText = this.add.text(0, 0, '', {
      fontSize: '5px', fontFamily: "'Press Start 2P'",
      color: '#44ff88', stroke: '#000', strokeThickness: 2,
    }).setDepth(26).setOrigin(0.5, 1).setVisible(false);

    // ── TRANSIT HUB PORTAL — persistent, always shown (transit exists in every town) ──
    const PORTAL_X = 752, PORTAL_Y = 430;
    this._portalPhase = 0;

    const portalGfx = this.add.graphics().setDepth(6);
    portalGfx.lineStyle(2, 0xaa66ff, 0.7);
    portalGfx.strokeCircle(PORTAL_X, PORTAL_Y, 16);
    portalGfx.lineStyle(1, 0x6644aa, 0.4);
    portalGfx.strokeCircle(PORTAL_X, PORTAL_Y, 20);
    this._portalInner    = this.add.graphics().setDepth(7);
    this._portalSparkles = this.add.graphics().setDepth(8);
    this._portalX = PORTAL_X;
    this._portalY = PORTAL_Y;

    // Persistent transit hub labels (always visible regardless of town)
    this.add.text(PORTAL_X, PORTAL_Y - 40, 'TRANSIT HUB', {
      fontSize: '6px', fontFamily: "'Press Start 2P'",
      color: '#aa66ff', stroke: '#000000', strokeThickness: 3,
      backgroundColor: '#00000077', padding: { x:4, y:2 },
    }).setDepth(9).setOrigin(0.5, 1);
    this.add.text(PORTAL_X, PORTAL_Y - 29, 'Travel Between Towns', {
      fontSize: '4px', fontFamily: "'Press Start 2P'",
      color: '#6644aa', stroke: '#000000', strokeThickness: 2,
    }).setDepth(9).setOrigin(0.5, 0);
    this.add.text(PORTAL_X, PORTAL_Y - 6, '[E] TRAVEL', {
      fontSize: '4px', fontFamily: "'Press Start 2P'",
      color: '#ffcc44', stroke: '#000000', strokeThickness: 2, alpha: 0.8,
    }).setDepth(9).setOrigin(0.5, 0.5);

    // Timers
    this.lastSendTime = 0;
    this.time.addEvent({ delay:2800, loop:true, callback:this.doNPCAmbientMove, callbackScope:this });
    this.time.addEvent({ delay:500, loop:true, callback:drawMinimap });

    // Idle bob state
    this._bobTime = 0;

    // ── INIT UI SYSTEM ──
    UISystem.init(this);

    console.log('🎮 GameScene ready');
  }

  /**
   * Spawn an NPC with style-guide sprite:
   * unique per-NPC color, drawChar16 rules, name tag, role badge
   */
  spawnNPC(npc) {
    const texKey = `npc_${npc.id}`;
    const overrides = npcColorOverrides(npc.color || '#888888');

    // Pix the robot gets a special color scheme
    if (npc.id === 'pix') {
      overrides.S = '#cfd8dc'; overrides.s = '#b0bec5';
      overrides.P = '#90a4ae'; overrides.p = '#607d8b';
      overrides.G = '#78909c'; overrides.g = '#546e7a';
    }

    if (!this.textures.exists(texKey)) {
      const t = this.textures.createCanvas(texKey, 16, 16);
      const ctx = t.getContext();
      ctx.imageSmoothingEnabled = false;
      drawSprite(ctx, SPR_NPC_IDLE, 0, 0, 1, overrides);
      t.refresh();
    }

    // Pre-build walk frame textures for this NPC
    NPC_WALK_FRAMES.forEach((grid, i) => {
      const wKey = `${texKey}_w${i}`;
      if (!this.textures.exists(wKey)) {
        const t = this.textures.createCanvas(wKey, 16, 16);
        const ctx = t.getContext();
        ctx.imageSmoothingEnabled = false;
        drawSprite(ctx, grid, 0, 0, 1, overrides);
        t.refresh();
      }
    });

    const sprite = this.physics.add.sprite(npc.x, npc.y, texKey);
    sprite.setScale(2);   // 16px art → 32px display
    sprite.setDepth(8);
    sprite.npcId = npc.id;
    sprite._walkFrame = 0;
    sprite._walkTimer = 0;
    console.log(`[sprite] NPC ${npc.id} loaded → ${texKey}, color=${npc.color||'default'}`);

    gameState.npcSprites[npc.id] = { sprite, overrides };

    // Create HTML name+emotion badge and immediately bind the sprite for position tracking
    createNpcBadge(npc);
    UISystem.bindNpcSprite(npc.id, sprite);
  }

  doNPCAmbientMove() {
    for (const npc of gameState.npcs) {
      const data = gameState.npcSprites[npc.id];
      if (!data) continue;
      // Constrain wander to reasonable bounds
      const dx = (Math.random()-0.5)*48;
      const dy = (Math.random()-0.5)*48;
      npc.x = Phaser.Math.Clamp(npc.x+dx, TILE_SIZE*2, WORLD_W-TILE_SIZE*2);
      npc.y = Phaser.Math.Clamp(npc.y+dy, TILE_SIZE*2, WORLD_H-TILE_SIZE*2);
      // Integer coords (style guide rule)
      npc.x = Math.round(npc.x);
      npc.y = Math.round(npc.y);
      this.tweens.add({
        targets: data.sprite, x: npc.x, y: npc.y,
        duration: 1800+Math.random()*1000, ease:'Sine.InOut'
      });
    }
  }

  tryInteract() {
    const px = gameState.mySprite.x, py = gameState.mySprite.y;

    // ── 1. Check proximity-zone markers first (Town Hall, Market, Transit) ──
    const ZONE_TRIGGERS = [
      { cx: 312, cy: 96,  r: 40, action: 'vote',   label: 'Town Hall' },
      { cx: 624, cy: 608, r: 40, action: 'trade',  label: 'Market'    },
      { cx: 752, cy: 430, r: 50, action: 'travel', label: 'Transit Hub' },
    ];
    for (const zone of ZONE_TRIGGERS) {
      const d = Phaser.Math.Distance.Between(px, py, zone.cx, zone.cy);
      if (d < zone.r) {
        if (zone.action === 'vote')   { openVoteFromWorld();   return; }
        if (zone.action === 'trade')  { openTradeFromWorld();  return; }
        if (zone.action === 'travel') { openTravelMenu();      return; }
      }
    }

    // ── 2. Find closest NPC ──
    let closest = null, closestDist = NPC_INTERACT_DIST;
    for (const npc of gameState.npcs) {
      const d = Phaser.Math.Distance.Between(px, py, npc.x, npc.y);
      if (d < closestDist) { closestDist = d; closest = npc; }
    }

    if (!closest) { showToast('Nothing nearby — walk closer', 1800); return; }

    // ── 3. Route by NPC type ──
    const npcType = getNpcInteractionType(closest.id);
    switch (npcType) {
      case 'shop':
        // Open shop directly, with "TALK" as a secondary option
        openShop(closest.id);
        break;
      case 'vote':
        // Sol / Mayor → Town Hall vote
        openVoteFromWorld();
        break;
      case 'job':
        // Job-giver: open dialogue with job tab pre-selected
        _shopTab = 'work';
        openShop(closest.id);
        break;
      default:
        // Regular NPC → dialogue
        openDialogue(closest, `*${closest.name} looks up at you*`);
    }
  }

  update(time) {
    if (!gameState.mySprite) return;
    const sp = gameState.mySprite;
    sp.setVelocity(0);

    // ── MOVEMENT ──
    if (!gameState.dialogueOpen) {
      const L = gameState.cursors.left.isDown  || gameState.wasd.left.isDown  || gameState.mobileInput.x < -0.2;
      const R = gameState.cursors.right.isDown || gameState.wasd.right.isDown || gameState.mobileInput.x >  0.2;
      const U = gameState.cursors.up.isDown    || gameState.wasd.up.isDown    || gameState.mobileInput.y < -0.2;
      const D = gameState.cursors.down.isDown  || gameState.wasd.down.isDown  || gameState.mobileInput.y >  0.2;

      if (L) sp.setVelocityX(-PLAYER_SPEED);
      if (R) sp.setVelocityX(PLAYER_SPEED);
      if (U) sp.setVelocityY(-PLAYER_SPEED);
      if (D) sp.setVelocityY(PLAYER_SPEED);

      // Diagonal normalize
      if ((L||R) && (U||D))
        sp.setVelocity(sp.body.velocity.x*0.707, sp.body.velocity.y*0.707);

      // ── DIRECTION SPRITE SWITCHING ──
      const moving = L||R||U||D;
      let newDir = this._playerDir;
      if (L) newDir = 'left';
      else if (R) newDir = 'right';
      else if (U) newDir = 'up';
      else if (D) newDir = 'down';

      if (newDir !== this._playerDir) {
        this._playerDir = newDir;
        sp.setTexture(`player_${newDir}`);
      }

      // ── WALK FRAME CYCLING — alternates between _a (base) and _b frames ──
      if (moving) {
        this._walkTimer += this.game.loop.delta;
        if (this._walkTimer >= 130) {
          this._walkTimer = 0;
          this._walkFrame = (this._walkFrame + 1) % 2;
          // Frame 0 = base direction, frame 1 = _b variant
          const texKey = this._walkFrame === 0
            ? `player_${this._playerDir}`
            : `player_${this._playerDir}_b`;
          sp.setTexture(texKey);
        }
        this._bobTime = 0;
      } else {
        this._walkTimer = 0;
        this._walkFrame = 0;
        sp.setTexture(`player_${this._playerDir}`); // always return to base frame when idle

        // ── IDLE BOB (±1px, 400ms) ──
        this._bobTime += this.game.loop.delta;
        const bobOffset = Math.sin(this._bobTime / (BOB_PERIOD / (2 * Math.PI))) * BOB_AMOUNT;
        sp.y += bobOffset * 0.08;
      }
    }

    // Round to integer pixels (style guide)
    sp.x = Math.round(sp.x);
    sp.y = Math.round(sp.y);
    gameState.myX = sp.x;
    gameState.myY = sp.y;

    // Name tag
    this.myNameTag.setPosition(sp.x, sp.y-20);
    if (this.myNameTag.text !== myName) this.myNameTag.setText(myName);

    // ── OTHER PLAYERS — interpolated, integer coords ──
    for (const [,p] of Object.entries(gameState.players)) {
      if (!p.sprite) continue;
      p.sprite.x = Math.round(Phaser.Math.Linear(p.sprite.x, p.x, 0.18));
      p.sprite.y = Math.round(Phaser.Math.Linear(p.sprite.y, p.y, 0.18));
      if (p.label) p.label.setPosition(p.sprite.x, p.sprite.y-14);
    }

    // ── NPC WALK ANIMATION ──
    for (const npc of gameState.npcs) {
      const data = gameState.npcSprites[npc.id];
      if (!data) continue;
      const sp2 = data.sprite;
      const vx = sp2.body ? Math.abs(sp2.body.velocity.x) : 0;
      const vy = sp2.body ? Math.abs(sp2.body.velocity.y) : 0;
      if (vx > 2 || vy > 2) {
        sp2._walkTimer = (sp2._walkTimer || 0) + this.game.loop.delta;
        if (sp2._walkTimer >= 180) {
          sp2._walkTimer = 0;
          sp2._walkFrame = ((sp2._walkFrame || 0) + 1) % NPC_WALK_FRAMES.length;
          sp2.setTexture(`npc_${npc.id}_w${sp2._walkFrame}`);
        }
      } else {
        sp2._walkFrame = 0;
        sp2.setTexture(`npc_${npc.id}_w0`);
      }
    }

    // ── INTERACT PROMPT — context-aware label ──
    let nearbyNpc = null, nearZone = null;

    // Check proximity zones first (Town Hall, Market, Transit Hub)
    const UPDATE_ZONES = [
      { cx: 312, cy: 96,  r: 50, zone: 'vote'   },
      { cx: 624, cy: 608, r: 50, zone: 'trade'  },
      { cx: 752, cy: 430, r: 55, zone: 'travel' },
    ];
    for (const z of UPDATE_ZONES) {
      if (Phaser.Math.Distance.Between(sp.x, sp.y, z.cx, z.cy) < z.r) { nearZone = z.zone; break; }
    }

    // Then check NPCs
    for (const npc of gameState.npcs) {
      if (Phaser.Math.Distance.Between(sp.x,sp.y,npc.x,npc.y) < NPC_INTERACT_DIST) { nearbyNpc=npc; break; }
    }

    const anyOverlayOpen = document.getElementById('shop-overlay').style.display === 'block'
      || document.getElementById('travel-overlay').style.display === 'block';
    if ((nearbyNpc || nearZone) && !gameState.dialogueOpen && !anyOverlayOpen) {
      const label = getInteractLabel(nearbyNpc?.id, nearZone);
      if (this.interactPrompt.text !== label) this.interactPrompt.setText(label);
      this.interactPrompt.setVisible(true);
      this.interactPrompt.setPosition(sp.x, sp.y - 36);
    } else {
      this.interactPrompt.setVisible(false);
    }

    // ── JOB PROGRESS BAR — world-space bar above player while working ──
    if (_activeJob && this.jobBar) {
      const elapsed = Date.now() - _activeJob.startTime;
      const pct     = Math.min(1, elapsed / (_activeJob.durationMs));
      const bw = 36, bh = 5;
      const bx = sp.x - bw/2, by = sp.y - 40;
      this.jobBar.clear();
      this.jobBar.fillStyle(0x0a0a1a, 0.9);  this.jobBar.fillRect(bx-1, by-1, bw+2, bh+2);
      this.jobBar.fillStyle(0x44ff88, 1.0);  this.jobBar.fillRect(bx, by, Math.round(bw*pct), bh);
      this.jobBar.lineStyle(1, 0x44aa66, 0.8); this.jobBar.strokeRect(bx-1, by-1, bw+2, bh+2);
      this.jobBar.setVisible(true);
      this.jobBarText.setText(`${_activeJob.name} (${Math.ceil((_activeJob.durationMs - elapsed)/1000)}s)`);
      this.jobBarText.setPosition(sp.x, by - 2);
      this.jobBarText.setVisible(true);

      // Check completion
      if (pct >= 1 && !_activeJob.completed) {
        _activeJob.completed = true;
        this.jobBar.setVisible(false);
        this.jobBarText.setVisible(false);
        completeJob();
      }
    } else if (this.jobBar) {
      this.jobBar.setVisible(false);
      this.jobBarText?.setVisible(false);
    }

    // ── PORTAL PULSE ANIMATION ──
    if (this._portalInner) {
      this._portalPhase = (this._portalPhase || 0) + this.game.loop.delta * 0.002;
      const pulse  = 0.4 + Math.sin(this._portalPhase * 2.5) * 0.3;
      const spark  = Math.sin(this._portalPhase * 5.0);
      const r      = Math.round(9 + Math.sin(this._portalPhase) * 3);
      const px     = this._portalX, py = this._portalY;
      this._portalInner.clear();
      this._portalInner.fillStyle(0xaa66ff, pulse * 0.5);
      this._portalInner.fillCircle(px, py, r);
      this._portalInner.fillStyle(0xffffff, pulse * 0.25);
      this._portalInner.fillCircle(px, py, Math.round(r * 0.4));

      // Orbiting sparkles
      if (this._portalSparkles) {
        this._portalSparkles.clear();
        for (let i = 0; i < 6; i++) {
          const angle = this._portalPhase * 1.8 + (i * Math.PI * 2 / 6);
          const dist  = 18 + spark * 3;
          const sx    = px + Math.cos(angle) * dist;
          const sy    = py + Math.sin(angle) * dist * 0.6;
          const alpha = 0.3 + Math.sin(angle + this._portalPhase) * 0.2;
          this._portalSparkles.fillStyle(0xdd99ff, alpha);
          this._portalSparkles.fillRect(Math.round(sx) - 1, Math.round(sy) - 1, 2, 2);
        }
      }
    }

    // ── SYNC CHAT BUBBLES + NPC BADGES + REP DOT to camera scroll ──
    updateBubblePositions(this.cameras.main);

    // ── SEND POSITION ──
    if (ws && ws.readyState===WebSocket.OPEN && time-this.lastSendTime>SEND_INTERVAL) {
      this.lastSendTime = time;
      ws.send(JSON.stringify({ type:'move', x:sp.x, y:sp.y }));
    }
  }
}

// ─────────────────────────────────────────────
// OTHER PLAYER MANAGEMENT
// ─────────────────────────────────────────────
function addOtherPlayer(id, data) {
  if (id===myId) return;
  const scene=gameState.scene;
  if (!scene) return;

  const texKey=`oplayer_${id}`;
  if (!scene.textures.exists(texKey)) {
    const t=scene.textures.createCanvas(texKey,16,16);
    const ctx=t.getContext();
    ctx.imageSmoothingEnabled=false;
    drawSprite(ctx, SPR_PLAYER_DOWN, 0, 0, 1, { H: data.color||PAL.interact, h: darkenHex(data.color||PAL.interact,25) });
    t.refresh();
  }

  const sprite=scene.physics.add.sprite(data.x,data.y,texKey);
  sprite.setScale(2);   // 16px art → 32px display
  sprite.setDepth(9);

  const label=scene.add.text(data.x,data.y-20,data.name||id,{
    fontSize:'5px', fontFamily:"'Press Start 2P'",
    color: data.color||PAL.interact, stroke:'#000000', strokeThickness:2
  }).setDepth(10).setOrigin(0.5,1);

  gameState.players[id]={...data,sprite,label};
  updatePlayerList();
  updateHUD();
}

function removeOtherPlayer(id) {
  const p=gameState.players[id];
  if (p) {
    if (p.sprite) p.sprite.destroy();
    if (p.label)  p.label.destroy();
    delete gameState.players[id];
  }
  updatePlayerList();
  updateHUD();
}

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
function connectWebSocket() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('🔌 Connected');
    showToast('Connected to server!');
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg=JSON.parse(event.data); } catch { return; }

    switch (msg.type) {
      case 'init': {
        myId=msg.id; myName=msg.name;
        document.getElementById('hud-name').textContent=myName.toUpperCase();
        if (gameState.mySprite)
          gameState.mySprite.setPosition(msg.players[myId]?.x||300, msg.players[myId]?.y||300);
        gameState.npcs=msg.npcs||[];
        if (gameState.scene)
          for (const npc of gameState.npcs)
            if (!gameState.npcSprites[npc.id]) gameState.scene.spawnNPC(npc);
        for (const [id,p] of Object.entries(msg.players||{}))
          if (id!==myId) addOtherPlayer(id,p);
        updateHUD(); updatePlayerList();
        showToast(`Welcome, ${myName}!`, 3000);
        if (msg.reputation) applyReputation(msg.reputation);
        if (msg.factions)   applyFactions(msg.factions);
        if (msg.event)      applyEvent(msg.event);
        if (msg.house)      applyHouse(msg.house);
        if (msg.economy?.wallet) applyWallet(msg.economy.wallet);
        if (msg.politics)   applyPolitics(msg.politics);
        if (msg.progression) applyProgression(msg.progression);
        if (msg.drama)      applyAllDramaLevels(msg.drama);
        startXPTrickle();
        // Fetch full progression state (unlocks, skills)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'progression_get' }));
          ws.send(JSON.stringify({ type: 'drama_get' }));
        }
        break;
      }
      case 'player_join': {
        addOtherPlayer(msg.id,msg);
        showToast(`${msg.name} joined`, 2000);
        break;
      }
      case 'player_move': {
        if (msg.id!==myId && gameState.players[msg.id]) {
          gameState.players[msg.id].x=msg.x;
          gameState.players[msg.id].y=msg.y;
        }
        break;
      }
      case 'player_leave': {
        const p=gameState.players[msg.id];
        if (p) showToast(`${p.name} left`,1500);
        removeOtherPlayer(msg.id);
        break;
      }
      case 'npc_reply': {
        setThinking(false);
        setDialogueText(msg.reply, msg.emotion);
        if (msg.reputation)   applyReputation(msg.reputation);
        if (msg.factions)     applyFactions(msg.factions);
        if (msg.wallet)       applyWallet(msg.wallet);
        if (msg.progression)  applyProgression(msg.progression);
        if (msg.drama)        applyNpcDrama(msg.drama);

        // Cache relationship state and update panel + badge
        if (msg.relationship) {
          _relCache[msg.relationship.npcId] = {
            state: msg.relationship.state,
            label: msg.relationship.label,
            color: msg.relationship.color,
          };
          applyNpcRelationship(msg.relationship);
        }

        const npcData = gameState.npcSprites[msg.npcId];
        if (npcData) {
          const npc = gameState.npcs.find(n => n.id === msg.npcId);
          if (npc) {
            const bubbleText = msg.reply.length > 40 ? msg.reply.slice(0,38)+'…' : msg.reply;
            showChatBubble(npc.x, npc.y, bubbleText, 3500);
          }
          updateNpcEmotionBadge(msg.npcId, msg.emotion);
        }
        if (msg.action==='walk_to_player' && gameState.scene) {
          const data=gameState.npcSprites[msg.npcId];
          if (data) gameState.scene.tweens.add({
            targets:data.sprite, x:gameState.myX+32, y:gameState.myY,
            duration:800, ease:'Sine.Out'
          });
        }
        break;
      }
      case 'reputation_update': {
        if (msg.reputation) applyReputation(msg.reputation);
        break;
      }
      case 'player_rep': {
        if (gameState.players[msg.id] && msg.reputation) {
          gameState.players[msg.id].repTitle = msg.reputation.title;
          gameState.players[msg.id].repColor = msg.reputation.color;
          updatePlayerList();
        }
        break;
      }
      case 'event_start': {
        applyEvent(msg.event);
        UISystem.showNotification(`${msg.event?.label || 'Event'} started!`, '#ffcc44', 3500);
        break;
      }
      case 'event_end': {
        applyEvent(null);
        UISystem.showNotification(`${msg.event?.label || 'Event'} ended`, '#888780', 2000);
        break;
      }
      case 'event_joined': {
        UISystem.showNotification(`You joined: ${msg.event?.label || 'Event'}`, '#44aaff', 2500);
        break;
      }
      case 'secret_reveal': {
        handleSecretReveal(msg.npcId, msg.secretText);
        break;
      }
      case 'house_state': {
        if (msg.house) applyHouse(msg.house);
        break;
      }
      case 'house_item_placed':
      case 'house_item_removed': {
        if (msg.house) applyHouse(msg.house);
        break;
      }
      case 'npc_visit': {
        const npc = gameState.npcs.find(n => n.id === msg.npcId);
        if (npc) showToast(`▸ ${npc.name} is visiting your house!`, 4000);
        break;
      }
      case 'house_visitor': {
        const npc = gameState.npcs.find(n => n.id === msg.npcId);
        if (msg.playerId === myId && npc) showToast(`▸ ${npc.name} dropped by!`, 3000);
        break;
      }
      case 'relationship_collapse': {
        // Cache the new degraded state
        if (msg.npcId) {
          _relCache[msg.npcId] = {
            state: msg.subtype === 'betrayal' ? 'enemy'
                 : msg.subtype === 'breakup'  ? 'cold'
                 : msg.subtype === 'fear_rupture' ? 'terrified'
                 : 'cold',
            label: msg.message || 'Relationship broke',
            color: msg.subtype === 'betrayal' ? '#ff4444' : '#ff8844',
          };
          updateRelPanel();
        }
        applyRelationshipCollapse(msg);
        break;
      }
      case 'economy_update': {
        if (msg.wallet) applyWallet(msg.wallet);
        if (msg.shops)  gameState.shops = msg.shops;
        break;
      }
      case 'economy_bought': {
        applyWallet({ coins: msg.balance });
        if (msg.progression) applyProgression(msg.progression);
        UISystem.showNotification(`Bought ${msg.itemName} for ${msg.price} coins`, '#ffcc44', 2000);
        if (_currentShopNpcId) ws.send(JSON.stringify({ type: 'shop_get', npcId: _currentShopNpcId }));
        break;
      }
      case 'economy_earned': {
        applyWallet({ coins: msg.balance });
        if (msg.progression) applyProgression(msg.progression);
        UISystem.showNotification(`+${msg.amount} coins — ${msg.jobName}`, '#44ff88', 2500);
        if (_currentShopNpcId) ws.send(JSON.stringify({ type: 'shop_get', npcId: _currentShopNpcId }));
        break;
      }
      case 'shop_data': {
        // Server sent shop inventory + jobs — render the shop overlay
        renderShop(msg);
        break;
      }
      case 'shop_error': {
        UISystem.showNotification(msg.error || 'Cannot shop right now', '#ff4444', 2500);
        break;
      }
      case 'politics_update': {
        if (msg.issues) applyPolitics(msg.issues);
        break;
      }
      case 'politics_data': {
        if (msg.issues) {
          applyPolitics(msg.issues);
          // If vote overlay is open, refresh it too
          if (_currentVoteIssue) {
            const fresh = msg.issues.find(i => i.id === _currentVoteIssue.id);
            if (fresh) openVote(fresh);
          }
        }
        break;
      }
      case 'vote_recorded': {
        UISystem.showNotification('Vote recorded!', '#ce93d8', 1800);
        break;
      }
      case 'influence_result': {
        const txt = msg.success
          ? `NPC vote changed to ${msg.newVote}!`
          : `Couldn't convince them (was: ${msg.previousVote})`;
        UISystem.showNotification(txt, msg.success ? '#44ff88' : '#ffaa44', 2500);
        break;
      }
      case 'politics_result': {
        const winSide = msg.outcome === 'yes' ? msg.sides?.yes : msg.sides?.no;
        UISystem.showNotification(
          `Vote resolved — "${msg.name}": ${winSide || msg.outcome} (${msg.yesCount}–${msg.noCount})`,
          '#ce93d8', 6000
        );
        break;
      }
      case 'lie_detected': {
        const npc = gameState.npcs.find(n => n.id === msg.npcId);
        if (npc) {
          updateNpcEmotionBadge(msg.npcId, 'suspicious');
          UISystem.showNotification(`${npc.name} doesn't believe you…`, '#ffaa44', 2500);
        }
        break;
      }
      case 'memory_status': {
        console.log('[memory decay]', msg.summary);
        break;
      }
      case 'player_chat': {
        // Another player (or self, echoed back) sent a chat message
        handlePlayerChat(msg);
        break;
      }
      case 'travel_data': {
        // Server sent town list — render the menu
        renderTravelMenu(msg);
        break;
      }
      case 'travel_result': {
        // Server confirmed travel (or rejected it) — apply and fade in
        applyTravelResult(msg);
        break;
      }
      case 'drama_event': {
        // Public confrontation — scrolling ticker + NPC badge reaction
        showDramaTicker(msg.message || `${msg.npcName} confronts you publicly!`);
        if (msg.npcId) updateNpcEmotionBadge(msg.npcId, 'suspicious');
        // Award XP visual since server already called addXP
        if (msg.progression) applyProgression(msg.progression);
        break;
      }
      case 'drama_data': {
        // Bulk drama levels — update all NPC drama badges
        if (msg.drama) applyAllDramaLevels(msg.drama);
        break;
      }
      case 'npc_memory_data': {
        // Server sent top memories for this NPC+player — render the panel
        renderMemoryPanel(msg);
        break;
      }
      case 'progression_data': {
        if (msg.progression) applyProgression(msg.progression);
        break;
      }
      case 'skill_result': {
        if (msg.progression) applyProgression(msg.progression);
        if (msg.ok) {
          UISystem.showNotification(`Invested in ${msg.path}!`, '#ce93d8', 2000);
          renderSkillPanel(msg.progression);
        } else {
          UISystem.showNotification(msg.error || 'Cannot invest', '#ff4444', 2000);
        }
        break;
      }
      case 'npc_move': {
        const npc=gameState.npcs.find(n=>n.id===msg.id);
        if (npc) { npc.x=msg.x; npc.y=msg.y; }
        const data=gameState.npcSprites[msg.id];
        if (data&&gameState.scene) {
          const dist=Phaser.Math.Distance.Between(data.sprite.x,data.sprite.y,msg.x,msg.y);
          const dur=Math.min(600, Math.max(120, dist * 12));
          gameState.scene.tweens.add({
            targets:data.sprite, x:msg.x, y:msg.y,
            duration:dur, ease:'Sine.InOut', overwrite:true,
          });
        }
        break;
      }
      case 'npc_state': {
        const npc=gameState.npcs.find(n=>n.id===msg.id);
        if (npc) {
          npc.x=msg.x; npc.y=msg.y;
          npc.state=msg.state; npc.action=msg.action; npc.label=msg.label;
        }
        updateNpcStateBadge(msg.id, msg.state, msg.label);
        break;
      }
      case 'game_time': {
        updateGameClock({ hour: msg.hour, minute: msg.minute, label: msg.label });
        break;
      }
      case 'routine_tick': {
        if (msg.time) updateGameClock(msg.time);
        for (const upd of (msg.npcs||[])) {
          const npc=gameState.npcs.find(n=>n.id===upd.id);
          if (!npc) continue;
          npc.x=upd.x; npc.y=upd.y;
          const data=gameState.npcSprites[upd.id];
          if (data&&gameState.scene) {
            const dist=Phaser.Math.Distance.Between(data.sprite.x,data.sprite.y,upd.x,upd.y);
            if (dist>2) {
              gameState.scene.tweens.add({
                targets:data.sprite, x:upd.x, y:upd.y,
                duration:480, ease:'Linear', overwrite:true,
              });
            }
          }
          updateNpcStateBadge(upd.id, upd.state, upd.label);
        }
        break;
      }
    }
  };

  ws.onclose = () => {
    showToast('Connection lost. Reconnecting...', 3000);
    setTimeout(connectWebSocket, 3000);
  };
  ws.onerror = (e) => console.error('WS error', e);
}

// ═════════════════════════════════════════════════════════════════
// PROGRESSION SYSTEM
// Server is authoritative. We visualise what it sends.
// ═════════════════════════════════════════════════════════════════

let _playerLevel = 1;
let _playerTitle = 'Newcomer';

/**
 * Apply a progression payload from the server.
 * Updates XP bar, level badge, and triggers level-up overlay if needed.
 */
function applyProgression(p) {
  if (!p) return;
  _playerLevel = p.level || 1;
  _playerTitle = p.title || 'Newcomer';

  // XP bar
  const pct = p.xpPct ?? (p.xpToNext > 0
    ? Math.round((p.xpThisLevel / p.xpToNext) * 100) : 100);
  const barEl = document.getElementById('bar-xp');
  const badgeEl = document.getElementById('xp-level-badge');
  if (barEl)   barEl.style.width = Math.min(100, pct) + '%';
  if (badgeEl) badgeEl.textContent = 'Lv' + _playerLevel;

  // Earned XP flash — brief glow on bar
  if (p.earned > 0 && barEl) {
    barEl.style.boxShadow = '0 0 6px #ffcc44';
    setTimeout(() => { barEl.style.boxShadow = ''; }, 600);
  }

  // Level-up?
  if (p.leveledUp && p.newLevels?.length > 0) {
    showLevelUp(p);
  }

  // Refresh skill panel if it's open
  if (document.getElementById('skill-panel').style.display !== 'none') {
    renderSkillPanel(p);
  }
}

// Legacy stub — kept so old call sites don't break (server now drives XP)
function bumpXP(amt) { /* no-op: server is authoritative */ }
function startXPTrickle() { /* no-op */ }

// ─────────────────────────────────────────────
// LEVEL-UP OVERLAY
// ─────────────────────────────────────────────

function showLevelUp(p) {
  const overlay = document.getElementById('levelup-overlay');
  if (!overlay) return;

  document.getElementById('lu-level').textContent = p.level;
  document.getElementById('lu-title').textContent  = p.title?.toUpperCase() || '';

  // Show the most recent unlock
  const latestLevel = p.newLevels?.[p.newLevels.length - 1];
  const unlocks     = latestLevel?.unlocks || [];
  const unlockEl    = document.getElementById('lu-unlock');
  if (unlocks.length > 0) {
    document.getElementById('lu-unlock-label').textContent = unlocks[0].label || '';
    document.getElementById('lu-unlock-desc').textContent  = unlocks[0].desc  || '';
    unlockEl.style.display = 'block';
  } else {
    unlockEl.style.display = 'none';
  }

  overlay.style.display = 'block';
  overlay.style.opacity = '0';
  overlay.style.transition = 'opacity 0.35s';
  requestAnimationFrame(() => requestAnimationFrame(() => { overlay.style.opacity = '1'; }));
}

function closeLevelUp() {
  const el = document.getElementById('levelup-overlay');
  if (!el) return;
  el.style.transition = 'opacity 0.25s';
  el.style.opacity = '0';
  setTimeout(() => { el.style.display = 'none'; }, 260);
}

// ─────────────────────────────────────────────
// SKILL TREE PANEL
// ─────────────────────────────────────────────

function openSkillPanel() {
  ws.send(JSON.stringify({ type: 'progression_get' }));
  document.getElementById('skill-panel').style.display = 'block';
}

function closeSkillPanel() {
  document.getElementById('skill-panel').style.display = 'none';
}

function renderSkillPanel(p) {
  if (!p) return;
  const spEl = document.getElementById('skill-points-badge');
  if (spEl) spEl.textContent = (p.skillPoints || 0) + ' point' + (p.skillPoints === 1 ? '' : 's');
  const skills = p.skills || {};
  for (const path of ['social', 'economic', 'political']) {
    const el = document.getElementById(`sk-${path}-val`);
    if (el) el.textContent = skills[path] || 0;
  }
  // Grey out invest buttons when no points
  document.querySelectorAll('.skill-btn').forEach(btn => {
    btn.disabled = (p.skillPoints || 0) < 1;
    btn.style.opacity = (p.skillPoints || 0) < 1 ? '0.35' : '1';
  });
}

function investSkill(path) {
  ws.send(JSON.stringify({ type: 'skill_invest', path }));
}

// ═════════════════════════════════════════════════════════════════
// NPC MEMORY VISUALIZATION
// ═════════════════════════════════════════════════════════════════

// Valence → icon + color
const MEM_VALENCE = {
  positive: { icon: '😊', color: '#44ff88' },
  negative: { icon: '😠', color: '#ff4444' },
  neutral:  { icon: '💬', color: '#aabbff' },
};

/**
 * Request memory panel for the NPC the player is currently talking to.
 * Called from dialogue action buttons.
 */
function openMemoryPanel(npcId) {
  ws.send(JSON.stringify({ type: 'npc_memory_get', npcId }));
}

function closeMemoryPanel() {
  document.getElementById('memory-panel').style.display = 'none';
}

/**
 * Render the NPC memory panel from server data.
 */
function renderMemoryPanel(data) {
  const panel = document.getElementById('memory-panel');
  if (!panel) return;

  const npc = gameState.npcs.find(n => n.id === data.npcId);

  // Header
  const nameEl = document.getElementById('mem-npc-name');
  if (nameEl) {
    nameEl.textContent = (npc?.name || data.npcId).toUpperCase();
    nameEl.style.color = npc?.color || '#aabbff';
  }

  // Relationship state
  const relEl = document.getElementById('mem-rel-state');
  if (relEl && data.relationship) {
    relEl.textContent    = data.relationship.label || 'Acquaintance';
    relEl.style.color    = data.relationship.color || '#556677';
    relEl.style.borderLeft = `2px solid ${data.relationship.color || '#334'}`;
    relEl.style.paddingLeft = '6px';
  }

  // Drama tension bar
  const dramaWrap = document.getElementById('mem-drama-bar');
  const dramaFill = document.getElementById('mem-drama-fill');
  const dramaLbl  = document.getElementById('mem-drama-label');
  if (data.drama && data.drama.level > 0 && dramaWrap) {
    dramaWrap.style.display = 'block';
    dramaFill.style.width      = data.drama.level + '%';
    dramaFill.style.background = data.drama.color || '#ffcc44';
    dramaLbl.textContent       = data.drama.label || '';
    dramaLbl.style.color       = data.drama.color || '#ffcc44';
  } else if (dramaWrap) {
    dramaWrap.style.display = 'none';
  }

  // Memory entries
  const listEl = document.getElementById('mem-entries');
  if (listEl) {
    if (!data.memories || data.memories.length === 0) {
      listEl.innerHTML = `<div style="font-size:5px;color:#334;padding:4px;">No memories yet.</div>`;
    } else {
      listEl.innerHTML = data.memories.map(m => {
        const v       = MEM_VALENCE[m.valence] || MEM_VALENCE.neutral;
        const fade    = m.strength < 50 ? 0.5 + (m.strength / 100) : 1;
        const distTag = m.distorted ? `<span style="color:#ff8844;font-size:3px;margin-left:4px;">~fuzzy</span>` : '';
        return `<div style="display:flex;gap:5px;align-items:flex-start;opacity:${fade};">
          <span style="font-size:11px;flex-shrink:0;line-height:1;">${v.icon}</span>
          <div style="flex:1;">
            <div style="font-size:5px;color:${v.color};line-height:1.6;">"${m.text}"${distTag}</div>
            ${m.reply ? `<div style="font-size:4px;color:#334;margin-top:1px;font-style:italic;">→ ${m.reply.slice(0,50)}</div>` : ''}
          </div>
        </div>`;
      }).join('');
    }
  }

  // Interaction count
  const countEl = document.getElementById('mem-count');
  if (countEl) {
    countEl.textContent = data.interactionCount
      ? `${data.interactionCount} interaction${data.interactionCount !== 1 ? 's' : ''}`
      : '';
  }

  panel.style.display = 'block';
}

// ═════════════════════════════════════════════════════════════════
// DRAMA ESCALATION SYSTEM — CLIENT DISPLAY
// ═════════════════════════════════════════════════════════════════

// Per-NPC drama level cache for badge tinting
const _dramaCache = {};  // npcId → { level, stage, label, color }

/**
 * Update one NPC's drama level (from npc_reply drama field).
 */
function applyNpcDrama(drama) {
  if (!drama?.npcId) return;
  _dramaCache[drama.npcId] = drama;
  _tintNpcBadgeForDrama(drama.npcId, drama);
}

/**
 * Bulk-apply all drama levels (from drama_data).
 */
function applyAllDramaLevels(dramaMap) {
  for (const [npcId, d] of Object.entries(dramaMap)) {
    _dramaCache[npcId] = d;
    _tintNpcBadgeForDrama(npcId, d);
  }
}

/**
 * Tint the NPC's name badge based on drama stage.
 * Quiet → no tint; Rumour → gold; Conflict/Drama → red glow.
 */
function _tintNpcBadgeForDrama(npcId, drama) {
  // UISystem badge nameEl lives inside the bubble-layer
  const badge = document.getElementById(`npc-badge-${npcId}`);
  if (!badge) return;
  const nameEl = badge.querySelector('.name, div:first-child') || badge;
  if (drama.stage === 'quiet' || drama.level < 25) {
    nameEl.style.boxShadow = '';
    return;
  }
  const glow = drama.color || '#ffcc44';
  nameEl.style.boxShadow = `0 0 ${Math.round(drama.level / 15)}px ${glow}88`;
}

/**
 * Scrolling drama ticker — shown at bottom of game area during public events.
 * Text scrolls right-to-left, then hides.
 */
function showDramaTicker(message) {
  const ticker  = document.getElementById('drama-ticker');
  const textEl  = document.getElementById('drama-ticker-text');
  if (!ticker || !textEl) return;

  textEl.textContent = `⚡ ${message} ⚡`;
  ticker.style.display = 'block';

  // Reset then animate left
  textEl.style.transition = 'none';
  textEl.style.transform  = 'translateX(820px)';

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const totalDistance = 820 + textEl.offsetWidth + 40;
    const duration      = Math.max(4000, totalDistance * 5);
    textEl.style.transition = `transform ${duration}ms linear`;
    textEl.style.transform  = `translateX(-${textEl.offsetWidth + 40}px)`;

    setTimeout(() => {
      ticker.style.display    = 'none';
      textEl.style.transition = 'none';
      textEl.style.transform  = 'translateX(820px)';
    }, duration + 100);
  }));
}

// ═════════════════════════════════════════════════════════════════
// DIALOGUE — MEMORY BUTTON
// Show "MEMORIES" action button alongside SHOP/VOTE in dialogue
// ═════════════════════════════════════════════════════════════════

// Patch updateDialogueActions to add MEMORIES and SKILLS buttons
const _origUpdateDialogueActions = updateDialogueActions;
function updateDialogueActions(npcId) {
  _origUpdateDialogueActions(npcId);
  const el = document.getElementById('dialogue-actions');
  if (!el) return;
  // Add MEMORIES button
  const memBtn = document.createElement('button');
  memBtn.className   = 'action-btn';
  memBtn.textContent = '🧠 MEM';
  memBtn.onclick     = () => openMemoryPanel(npcId);
  el.appendChild(memBtn);
  // Ensure panel is visible
  if (el.children.length > 0) el.style.display = 'flex';
}

// ═════════════════════════════════════════════════════════════════
// MOBILE CONTROLS
// Detects touch device, renders joystick + interact button overlay.
// Joystick feeds into a virtual key state that the Phaser
// update loop reads via `gameState.mobileInput`.
// ═════════════════════════════════════════════════════════════════

function isMobile() {
  return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
}

function initMobileControls() {
  if (!isMobile()) return;

  const controlsEl = document.getElementById('mobile-controls');
  if (!controlsEl) return;
  controlsEl.style.display = 'block';

  // Update controls label in HUD
  const ctrlEl = document.querySelector('.controls');
  if (ctrlEl) ctrlEl.textContent = 'TAP · E:INTERACT';

  // ── Virtual Joystick ──
  const zone = document.getElementById('joystick-zone');
  const knob = document.getElementById('joystick-knob');
  if (!zone || !knob) return;

  let joyActive = false;
  let joyOriginX = 0, joyOriginY = 0;
  const JOY_RADIUS = 44; // max knob travel in px

  function joyStart(e) {
    joyActive = true;
    const rect = zone.getBoundingClientRect();
    const cx   = rect.left + rect.width  / 2;
    const cy   = rect.top  + rect.height / 2;
    joyOriginX = cx;
    joyOriginY = cy;
    joyMove(e);
    e.preventDefault();
  }

  function joyMove(e) {
    if (!joyActive) return;
    const touch = e.touches ? e.touches[0] : e;
    const dx    = touch.clientX - joyOriginX;
    const dy    = touch.clientY - joyOriginY;
    const dist  = Math.sqrt(dx*dx + dy*dy);
    const clamp = Math.min(dist, JOY_RADIUS);
    const angle = Math.atan2(dy, dx);
    const kx    = Math.cos(angle) * clamp;
    const ky    = Math.sin(angle) * clamp;

    knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
    gameState.mobileInput.x = dx / JOY_RADIUS;
    gameState.mobileInput.y = dy / JOY_RADIUS;
    e.preventDefault();
  }

  function joyEnd(e) {
    joyActive = false;
    knob.style.transform  = 'translate(-50%, -50%)';
    gameState.mobileInput.x = 0;
    gameState.mobileInput.y = 0;
    e.preventDefault();
  }

  zone.addEventListener('touchstart', joyStart, { passive: false });
  zone.addEventListener('touchmove',  joyMove,  { passive: false });
  zone.addEventListener('touchend',   joyEnd,   { passive: false });
  zone.addEventListener('touchcancel',joyEnd,   { passive: false });
}

function mobileInteract(e) {
  e.preventDefault();
  if (document.getElementById('world-map-overlay').style.display !== 'none') { closeWorldMap(); return; }
  if (document.getElementById('travel-overlay').style.display === 'block') { closeTravelMenu(); return; }
  if (document.getElementById('vote-overlay').style.display   === 'block') { closeVote();       return; }
  if (document.getElementById('shop-overlay').style.display   === 'block') { closeShop();       return; }
  if (gameState.dialogueOpen) { sendDialogueMessage(); return; }
  if (gameState.scene) gameState.scene.tryInteract();
}

function mobileEsc(e) {
  e.preventDefault();
  if (gameState.chatOpen) { closeChat(); return; }
  if (document.getElementById('world-map-overlay').style.display !== 'none')  { closeWorldMap();   return; }
  if (document.getElementById('levelup-overlay').style.display  === 'block') { closeLevelUp();    return; }
  if (document.getElementById('travel-overlay').style.display   === 'block') { closeTravelMenu(); return; }
  if (document.getElementById('vote-overlay').style.display     === 'block') { closeVote();       return; }
  if (document.getElementById('shop-overlay').style.display     === 'block') { closeShop();       return; }
  if (document.getElementById('skill-panel').style.display      !== 'none')  { closeSkillPanel(); return; }
  if (gameState.dialogueOpen) { closeDialogue(); return; }
}

function mobileChatToggle(e) {
  e.preventDefault();
  if (gameState.chatOpen) sendChat();
  else openChat();
}

// ═════════════════════════════════════════════════════════════════
// WORLD MAP SYSTEM
// Press M to open a full-screen SVG map of all towns.
// Towns are nodes positioned by worldMapX/Y (0–100 percentage coords).
// Clicking a node shows a culture info card; clicking TRAVEL sends you.
// ═════════════════════════════════════════════════════════════════

let _wmSelected = null;  // townId currently highlighted on world map

/** Open the world map overlay and render (or refresh) it */
function openWorldMap() {
  const overlay = document.getElementById('world-map-overlay');
  if (!overlay) return;
  overlay.style.display = 'block';

  // If we already have town data from travel_get, render immediately.
  // Otherwise request it from the server first.
  if (_travelData && _travelData.towns?.length) {
    _renderWorldMap(_travelData.towns, gameState.currentTownId);
  } else {
    // Show loading state
    const nodes = document.getElementById('wm-nodes');
    if (nodes) nodes.innerHTML = '<text x="50" y="50" fill="#556677" font-size="4" font-family="monospace" text-anchor="middle">Loading…</text>';
    ws.send(JSON.stringify({ type: 'travel_get' }));
    // The travel_data WS case will call _renderWorldMap when data arrives
  }
}

/** Close the world map overlay */
function closeWorldMap() {
  const overlay = document.getElementById('world-map-overlay');
  if (overlay) overlay.style.display = 'none';
  _wmSelected = null;
  const infoEl = document.getElementById('wm-info');
  if (infoEl) infoEl.style.display = 'none';
}

/**
 * Render the SVG world map with town nodes, connection lines, and labels.
 * Called by openWorldMap() or by the travel_data WS handler when the map is open.
 *
 * @param {Array}  towns      — full towns array from towns.json via server
 * @param {string} currentId  — the town the player is currently in
 */
function _renderWorldMap(towns, currentId) {
  const linesEl = document.getElementById('wm-lines');
  const nodesEl = document.getElementById('wm-nodes');
  if (!linesEl || !nodesEl) return;

  linesEl.innerHTML = '';
  nodesEl.innerHTML = '';

  // ── Connection lines (thin, low opacity) ──
  // Connect towns in order as a rough "road network"
  const pairs = [
    ['pixel_synapse', 'neon_docks'],
    ['pixel_synapse', 'verdant_hollow'],
    ['pixel_synapse', 'iron_gate'],
    ['iron_gate',     'glitch_city'],
    ['neon_docks',    'glitch_city'],
  ];
  pairs.forEach(([a, b]) => {
    const ta = towns.find(t => t.id === a);
    const tb = towns.find(t => t.id === b);
    if (!ta || !tb) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', ta.worldMapX);
    line.setAttribute('y1', ta.worldMapY);
    line.setAttribute('x2', tb.worldMapX);
    line.setAttribute('y2', tb.worldMapY);
    line.setAttribute('stroke', '#1a1a2a');
    line.setAttribute('stroke-width', '0.5');
    line.setAttribute('stroke-dasharray', '2 2');
    linesEl.appendChild(line);
  });

  // ── Town nodes ──
  towns.forEach(town => {
    const x         = town.worldMapX;
    const y         = town.worldMapY;
    const isCurrent = town.id === currentId;
    const isSelected= town.id === _wmSelected;
    const col       = town.color || '#aabbff';
    const nodeR     = isCurrent ? 5 : 3.5;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('style', 'cursor:pointer');
    g.setAttribute('data-town', town.id);

    // Outer glow ring (current town)
    if (isCurrent) {
      const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      glow.setAttribute('cx', x); glow.setAttribute('cy', y);
      glow.setAttribute('r', '8');
      glow.setAttribute('fill', col + '18');
      glow.setAttribute('stroke', col);
      glow.setAttribute('stroke-width', '0.5');
      g.appendChild(glow);
    }

    // Selection ring
    if (isSelected && !isCurrent) {
      const sel = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      sel.setAttribute('cx', x); sel.setAttribute('cy', y);
      sel.setAttribute('r', '6');
      sel.setAttribute('fill', 'none');
      sel.setAttribute('stroke', col);
      sel.setAttribute('stroke-width', '0.6');
      sel.setAttribute('stroke-dasharray', '1.5 1');
      g.appendChild(sel);
    }

    // Main dot
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x); circle.setAttribute('cy', y);
    circle.setAttribute('r', nodeR);
    circle.setAttribute('fill', isCurrent ? col : col + '88');
    circle.setAttribute('stroke', col);
    circle.setAttribute('stroke-width', '0.8');
    g.appendChild(circle);

    // Town name label
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', y + nodeR + 4.5);
    label.setAttribute('fill', isCurrent ? col : col + 'cc');
    label.setAttribute('font-size', '3.2');
    label.setAttribute('font-family', "'Press Start 2P', monospace");
    label.setAttribute('text-anchor', 'middle');
    label.textContent = town.name;
    g.appendChild(label);

    // Map type tag
    const typeTag = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    typeTag.setAttribute('x', x);
    typeTag.setAttribute('y', y + nodeR + 8.5);
    typeTag.setAttribute('fill', '#334');
    typeTag.setAttribute('font-size', '2.2');
    typeTag.setAttribute('font-family', 'monospace');
    typeTag.setAttribute('text-anchor', 'middle');
    typeTag.textContent = (town.mapType || 'city').toUpperCase();
    g.appendChild(typeTag);

    // Current marker
    if (isCurrent) {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      marker.setAttribute('x', x + nodeR + 1.5);
      marker.setAttribute('y', y + 1);
      marker.setAttribute('fill', '#ffcc44');
      marker.setAttribute('font-size', '3');
      marker.setAttribute('font-family', 'monospace');
      marker.textContent = '◀';
      g.appendChild(marker);
    }

    // Click handler
    g.addEventListener('click', () => wmSelectTown(town.id, towns));
    g.addEventListener('mouseenter', () => wmHighlight(town.id, towns, false));

    nodesEl.appendChild(g);
  });
}

/** Select a town node — show info card */
function wmSelectTown(townId, towns) {
  _wmSelected = townId;
  const towns_ = towns || _travelData?.towns || [];
  _renderWorldMap(towns_, gameState.currentTownId);
  wmHighlight(townId, towns_, true);
}

/** Populate the info card for a given town */
function wmHighlight(townId, towns, persistent = false) {
  const town = towns.find(t => t.id === townId);
  if (!town) return;

  const infoEl  = document.getElementById('wm-info');
  const nameEl  = document.getElementById('wm-info-name');
  const subEl   = document.getElementById('wm-info-sub');
  const descEl  = document.getElementById('wm-info-desc');
  const statsEl = document.getElementById('wm-info-stats');
  const btnEl   = document.getElementById('wm-travel-btn');
  const hereEl  = document.getElementById('wm-here-badge');
  if (!infoEl) return;

  const isCurrent = town.id === gameState.currentTownId;

  infoEl.style.display   = 'block';
  infoEl.style.borderColor = town.color + '88';

  nameEl.textContent  = town.name;
  nameEl.style.color  = town.color;
  subEl.textContent   = town.subtitle || '';
  descEl.textContent  = town.description || '';

  // Culture + economy stats
  const c = town.culture || {};
  const statData = [
    { label: 'Economy',     val: town.economyLabel   || '—',    col: '#ffcc44' },
    { label: 'Politics',    val: town.politicsLabel  || '—',    col: '#ce93d8' },
    { label: 'Population',  val: town.populationLabel|| '—',    col: '#aabbff' },
    { label: 'Friendliness',val: c.friendliness != null ? c.friendliness + '/100' : '—', col: '#44ff88' },
    { label: 'Chaos',       val: c.chaos        != null ? c.chaos        + '/100' : '—', col: '#ff4444' },
  ];
  statsEl.innerHTML = statData.map(s =>
    `<div style="text-align:center;">
      <div style="font-size:4px;color:#334;">${s.label}</div>
      <div style="font-size:5px;color:${s.col};margin-top:2px;">${s.val}</div>
    </div>`
  ).join('');

  // Culture labels row
  if (c.labels?.length) {
    statsEl.innerHTML += `<div style="width:100%;text-align:center;margin-top:4px;font-size:4px;color:${town.color};">
      ${c.labels.join(' · ')}
    </div>`;
  }

  if (isCurrent) {
    btnEl.style.display  = 'none';
    hereEl.style.display = 'inline';
  } else {
    btnEl.style.display  = 'inline-block';
    hereEl.style.display = 'none';
    btnEl.style.borderColor = town.color;
    btnEl.style.color       = town.color;
  }
}

/** Travel from world map — called by TRAVEL THERE button */
function wmTravelTo() {
  if (!_wmSelected || _wmSelected === gameState.currentTownId) return;
  closeWorldMap();
  travelTo(_wmSelected);
}

// Patch travel_data handler to re-render the world map if it's open
// When travel_data arrives from server, re-render the world map too if it's open.
// This patches the travel_data WS case behaviour without changing the switch block.
const _origRenderTravelMenuForWM = renderTravelMenu;
function renderTravelMenu(dataOrArray) {
  _origRenderTravelMenuForWM(dataOrArray);
  const towns      = Array.isArray(dataOrArray) ? dataOrArray : (dataOrArray.towns || []);
  const currentTown= Array.isArray(dataOrArray) ? gameState.currentTownId : (dataOrArray.currentTown || gameState.currentTownId);
  if (document.getElementById('world-map-overlay')?.style.display !== 'none' && towns.length) {
    _renderWorldMap(towns, currentTown);
  }
}

// ═════════════════════════════════════════════════════════════════
// PLAYER CHAT SYSTEM
//
// Press T anywhere (not while dialogue open) to open the chat bar.
// Type a message and press Enter or click SEND to broadcast.
// ESC cancels without sending.
//
// Incoming messages:
//   - World-space bubble above the sender's sprite (3.5 s)
//   - Entry appended to the scrolling chat-log panel (bottom-left)
//
// The chat bar is a DOM input so the browser handles IME, paste,
// emoji, etc. Movement keys are suppressed while it's open via
// gameState.chatOpen, which the Phaser update() already checks
// through gameState.dialogueOpen — we gate on that same flag.
// ═════════════════════════════════════════════════════════════════

// Tracks whether the chat bar is currently open
gameState.chatOpen = false;

// ── DOM refs ────────────────────────────────────────────────────
const _chatBar      = document.getElementById('chat-bar');
const _chatInput    = document.getElementById('chat-input');
const _chatCount    = document.getElementById('chat-char-count');
const _chatSendBtn  = document.getElementById('chat-send-btn');
const _chatLog      = document.getElementById('chat-log');

/** Open the chat bar and focus the input */
function openChat() {
  if (gameState.chatOpen) return;
  // Don't open while an NPC dialogue is active
  if (gameState.dialogueOpen) return;
  gameState.chatOpen   = true;
  gameState.dialogueOpen = true;  // reuse the flag so movement stops
  _chatBar.style.display = 'flex';
  _chatInput.value       = '';
  _chatCount.textContent = '120';
  _chatInput.focus();
}

/** Close the chat bar without sending */
function closeChat() {
  if (!gameState.chatOpen) return;
  gameState.chatOpen     = false;
  gameState.dialogueOpen = false;
  _chatBar.style.display = 'none';
  _chatInput.blur();
}

/** Send the typed message */
function sendChat() {
  const text = _chatInput.value.trim();
  closeChat();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'player_chat', text }));
}

// ── Chat input event wiring ──────────────────────────────────────

_chatInput.addEventListener('input', () => {
  const remaining = 120 - _chatInput.value.length;
  _chatCount.textContent = remaining;
  _chatCount.style.color = remaining < 20 ? '#ff8844' : '#334';
});

_chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation();   // prevent movement keys leaking to Phaser
  if (e.key === 'Enter')  { e.preventDefault(); sendChat();  }
  if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
});

_chatSendBtn.addEventListener('click', sendChat);

// T key — open chat (wired globally so it works anywhere in the game)
// Phaser's keyboard system is also set up in GameScene.create — we
// add a native listener here so it fires before Phaser consumes it.
window.addEventListener('keydown', (e) => {
  if (e.key === 'T' || e.key === 't') {
    // Only open if no overlay is blocking the game
    const anyOverlay = gameState.dialogueOpen
      || document.getElementById('shop-overlay')?.style.display === 'block'
      || document.getElementById('travel-overlay')?.style.display === 'block'
      || document.getElementById('vote-overlay')?.style.display   === 'block'
      || document.getElementById('world-map-overlay')?.style.display !== 'none';
    if (!anyOverlay) {
      e.preventDefault();
      openChat();
    }
  }
}, true);  // capture phase so it runs before Phaser sees the key

// ── Incoming player_chat WS handler ─────────────────────────────
// This is registered once here; the WS switch-case delegates to it.

/**
 * Handle an incoming player_chat message from the server.
 * Renders a world-space bubble above the sender's sprite and
 * appends a line to the chat-log panel.
 *
 * @param {{ id, name, color, text }} msg
 */
function handlePlayerChat(msg) {
  const { id, name, color, text } = msg;
  const isMe = (id === myId);

  // ── World-space bubble ──
  // Find the world position of the sender.
  let wx, wy;
  if (isMe) {
    wx = gameState.myX;
    wy = gameState.myY;
  } else {
    const p = gameState.players[id];
    if (p) {
      // Use sprite position (already lerped) if available, else stored x/y
      wx = p.sprite ? Math.round(p.sprite.x) : p.x;
      wy = p.sprite ? Math.round(p.sprite.y) : p.y;
    }
  }
  if (wx !== undefined) {
    UISystem.showBubble(wx, wy, text, 4000, color || '#3344aa');
  }

  // ── Chat log entry ──
  const line = document.createElement('div');
  line.style.cssText = 'display:flex;gap:4px;align-items:baseline;';
  line.innerHTML = `
    <span style="color:${color || '#aabbff'};flex-shrink:0;">${_escHtml(name)}:</span>
    <span style="color:#ccdde8;word-break:break-word;">${_escHtml(text)}</span>`;
  _chatLog.appendChild(line);

  // Scroll to bottom
  const panel = document.getElementById('chat-log-panel');
  if (panel) panel.scrollTop = panel.scrollHeight;

  // Fade out the oldest entry if log gets long (keep last 30)
  const lines = _chatLog.children;
  while (lines.length > 30) lines[0].remove();
}

function _escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─────────────────────────────────────────────
// PHASER CONFIG + BOOT
// ─────────────────────────────────────────────
const config = {
  type: Phaser.AUTO,
  width: 800, height: 600,
  parent: 'game',
  backgroundColor: PAL.void,
  pixelArt: true,
  antialias: false,
  roundPixels: true,
  physics: { default:'arcade', arcade:{ gravity:{y:0}, debug:false } },
  scene: [GameScene]
};

const game = new Phaser.Game(config);
game.events.on('ready', () => {
  connectWebSocket();
  initMobileControls();
});
