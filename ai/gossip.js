/**
 * gossip.js — NPC Gossip System for Pixel Synapse
 *
 * Gossip is information NPCs learn about players through interaction.
 * It spreads organically between NPCs over time, and can be distorted
 * as it passes through each personality.
 *
 * Design principles:
 *  - Max 5 gossip items per NPC (oldest evicted first)
 *  - Gossip spreads on a slow timer (every ~30s real time)
 *  - Each NPC has a distortion style matching their personality
 *  - Gossip context injected into prompts so NPCs feel "in the loop"
 */

const agents = require('./agents.json');

// ─────────────────────────────────────────────
// DATA STRUCTURE
//
// gossipStore[npcId] = [
//   {
//     id:         string,          // unique gossip ID
//     subject:    string,          // playerId or playerName
//     claim:      string,          // the gossip text
//     truth:      string,          // original true claim (before distortion)
//     distorted:  boolean,         // has this been altered?
//     origin:     string,          // npcId who first created this
//     hops:       number,          // how many NPCs it's passed through
//     seenAt:     number,          // timestamp
//   }
// ]
// ─────────────────────────────────────────────
const MAX_GOSSIP_PER_NPC = 5;
const gossipStore = {};

agents.forEach(a => { gossipStore[a.id] = []; });

// ─────────────────────────────────────────────
// PERSONALITY DISTORTION STYLES
// Each NPC warps gossip through their own lens
// ─────────────────────────────────────────────
const DISTORTION_STYLES = {
  lena:  (claim) => `I heard — and I'm still verifying this — that ${claim}`,
  orion: (claim) => {
    // Orion sometimes swaps the subject's action for something mechanical
    const swaps = [' talked' , ' walked', ' said'];
    const alts  = [' calculated', ' recalibrated', ' hypothesised'];
    let c = claim;
    swaps.forEach((s, i) => { c = c.replace(s, alts[i]); });
    return c;
  },
  mira:  (claim) => `Between you and me — and please don't spread this — ${claim}`,
  kai:   (claim) => {
    // Kai makes it sound more sinister
    return claim
      .replace('kind', 'suspiciously kind')
      .replace('friendly', 'strategically friendly')
      .replace('helped', 'interfered');
  },
  zara:  (claim) => `I wrote a song about it, but basically — ${claim}`,
  bram:  (claim) => `POTENTIAL THREAT ALERT: ${claim} — I'm keeping an eye on this.`,
  ivy:   (claim) => `Like a flower in unexpected soil — ${claim}`,
  juno:  (claim) => `${claim} — I bet they can't back it up though!`,
  sol:   (claim) => `Reminds me of a traveller I once knew. Anyway — ${claim}`,
  pix:   (claim) => `[GOSSIP_MODULE_ACTIVE] Claim: "${claim}" — probability of accuracy: unknown.`,
};

// ─────────────────────────────────────────────
// CREATE GOSSIP
// Called when a player does something noteworthy during interaction.
// The server calls this after saving memory.
// ─────────────────────────────────────────────

let _gossipCounter = 0;

/**
 * Create a new gossip item and add it to the originating NPC's store.
 *
 * @param {string} originNpcId  - which NPC witnessed/created this
 * @param {string} playerId     - player this is about
 * @param {string} playerName   - display name of the player
 * @param {string} claim        - the true observation (1 sentence)
 */
function createGossip(originNpcId, playerId, playerName, claim) {
  if (!gossipStore[originNpcId]) return;

  const item = {
    id:        `g${++_gossipCounter}`,
    subject:   playerName,
    playerId,
    claim,
    truth:     claim,
    distorted: false,
    origin:    originNpcId,
    hops:      0,
    seenAt:    Date.now(),
  };

  _addToStore(originNpcId, item);
  console.log(`[gossip] ${originNpcId} created: "${claim.slice(0, 60)}…"`);
}

function _addToStore(npcId, item) {
  if (!gossipStore[npcId]) return;
  // Avoid exact duplicates
  if (gossipStore[npcId].some(g => g.id === item.id)) return;
  gossipStore[npcId].push(item);
  // Keep only the most recent MAX_GOSSIP_PER_NPC items
  if (gossipStore[npcId].length > MAX_GOSSIP_PER_NPC) {
    gossipStore[npcId].shift();
  }
}

// ─────────────────────────────────────────────
// DISTORT A GOSSIP ITEM
// Applies the receiving NPC's personality lens.
// Distortion compounds with each hop.
// ─────────────────────────────────────────────
function distort(npcId, item) {
  const style = DISTORTION_STYLES[npcId];
  if (!style || item.hops === 0) return item.claim; // originator doesn't distort
  try {
    return style(item.claim);
  } catch {
    return item.claim;
  }
}

// ─────────────────────────────────────────────
// SPREAD GOSSIP
// Called on a timer. Picks random NPC pairs and
// transfers gossip from one to the other with distortion.
// ─────────────────────────────────────────────
const NPC_IDS = agents.map(a => a.id);

function spreadGossip() {
  // Pick a random "talker" that has gossip
  const talkers = NPC_IDS.filter(id => gossipStore[id]?.length > 0);
  if (talkers.length === 0) return;

  const talkerId   = talkers[Math.floor(Math.random() * talkers.length)];
  const listenerId = NPC_IDS.filter(id => id !== talkerId)[Math.floor(Math.random() * (NPC_IDS.length - 1))];

  const sourceGossip = gossipStore[talkerId];
  if (!sourceGossip || sourceGossip.length === 0) return;

  // Pick one random gossip item to share
  const original = sourceGossip[Math.floor(Math.random() * sourceGossip.length)];

  // Don't re-share if listener already has this gossip
  if (gossipStore[listenerId]?.some(g => g.id === original.id)) return;

  // Create distorted copy
  const copy = {
    ...original,
    claim:     distort(listenerId, original),
    distorted: original.hops > 0 || DISTORTION_STYLES[listenerId] !== undefined,
    hops:      original.hops + 1,
    seenAt:    Date.now(),
  };

  _addToStore(listenerId, copy);

  const talkerName   = agents.find(a => a.id === talkerId)?.name   || talkerId;
  const listenerName = agents.find(a => a.id === listenerId)?.name || listenerId;
  console.log(`[gossip] ${talkerName} → ${listenerName}: "${copy.claim.slice(0, 50)}…" (hop ${copy.hops})`);
}

// ─────────────────────────────────────────────
// EXTRACT GOSSIP FROM AI REPLY
// Heuristically parse an NPC's reply for quotable claims
// about the player to seed new gossip.
// ─────────────────────────────────────────────
const GOSSIP_TRIGGERS = [
  'told me', 'said they', 'mentioned', 'admitted', 'confessed',
  'apparently', 'rumour', 'seems like', 'I heard', 'apparently',
];

/**
 * Try to extract a gossip seed from a player's message.
 * If the message contains something quotable, create gossip.
 */
function maybeCreateFromInteraction(npcId, playerId, playerName, playerMessage, npcReply) {
  // Generate gossip from things the player said directly
  const msgLower = playerMessage.toLowerCase();

  // Interesting keywords that suggest something gossip-worthy happened
  const worthyKeywords = [
    'secret', 'love', 'hate', 'afraid', 'going to', 'plan', 'found',
    'discovered', 'stole', 'gave', 'helped', 'broke', 'lost', 'won',
    'never', 'always', 'everyone', 'nobody', 'something', 'anything',
  ];

  const isWorthy = worthyKeywords.some(kw => msgLower.includes(kw))
    || playerMessage.length > 40; // longer messages are more gossip-worthy

  if (!isWorthy) return;

  // Build a short third-person claim about the player
  const shortMsg = playerMessage.length > 60
    ? playerMessage.slice(0, 57) + '...'
    : playerMessage;

  const claim = `${playerName} said: "${shortMsg}"`;
  createGossip(npcId, playerId, playerName, claim);
}

// ─────────────────────────────────────────────
// FORMAT FOR PROMPT
// Returns a 2-4 line string of what this NPC has heard,
// suitable for injecting into the AI prompt.
// ─────────────────────────────────────────────

/**
 * Get gossip context for a specific NPC's prompt.
 * Prioritises gossip about the current player, then general town gossip.
 *
 * @param {string} npcId
 * @param {string} playerId   - current player (prioritise their gossip)
 * @param {string} playerName
 * @returns {string}
 */
function getGossipContext(npcId, playerId, playerName) {
  const items = gossipStore[npcId] || [];
  if (items.length === 0) return '';

  const lines = [];

  // About this specific player
  const aboutPlayer = items.filter(g => g.playerId === playerId || g.subject === playerName);
  if (aboutPlayer.length > 0) {
    lines.push('Things you\'ve heard about this player:');
    aboutPlayer.slice(-2).forEach(g => {
      const src = g.origin === npcId ? 'you witnessed' : `heard via the grapevine (${g.hops} hop${g.hops !== 1 ? 's' : ''})`;
      lines.push(`  - "${g.claim}" (${src}${g.distorted ? ', may be distorted' : ''})`);
    });
  }

  // General town gossip (not about current player)
  const general = items.filter(g => g.playerId !== playerId && g.subject !== playerName);
  if (general.length > 0 && lines.length < 4) {
    lines.push('Other things you\'ve heard around town:');
    general.slice(-1).forEach(g => {
      lines.push(`  - "${g.claim}"`);
    });
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

// ─────────────────────────────────────────────
// START SPREAD TIMER
// ─────────────────────────────────────────────

/**
 * Begin the gossip spreading timer.
 * @param {number} intervalMs  how often to spread (default 30s)
 */
function startGossipTimer(intervalMs = 30000) {
  setInterval(spreadGossip, intervalMs);
  console.log(`[gossip] Spread timer started (every ${intervalMs / 1000}s)`);
}

// ─────────────────────────────────────────────
// DEBUG / ADMIN
// ─────────────────────────────────────────────
function dumpGossip() {
  const out = {};
  for (const [npcId, items] of Object.entries(gossipStore)) {
    if (items.length > 0) out[npcId] = items.map(g => g.claim);
  }
  return out;
}

module.exports = {
  createGossip,
  maybeCreateFromInteraction,
  getGossipContext,
  spreadGossip,
  startGossipTimer,
  dumpGossip,
};
