/**
 * server.js — Pixel Synapse Multiplayer Server
 *
 * Active systems (10 total):
 *   routine            daily NPC schedules + movement
 *   memory             per-NPC per-player interaction memory
 *   memoryDecay        importance-scored decay + misremembering
 *   gossip             information spreading between NPCs
 *   reputation         player kindness / trust / chaos
 *   relationships      NPC–player friendship / trust / romance / fear
 *   relationshipsAdv   breakups + betrayal collapse mechanics
 *   factions           shared NPC group opinions
 *   deception          lies, misremembering, trust damage
 *   housing            player houses + NPC visits
 *   events             time-based world events
 *   politics           town issues + NPC voting
 *   economy            coins, shops, jobs, dynamic prices
 *   prompt             all context assembled into Claude prompts
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');

// ── AI systems ──
const { buildNPCPrompt }                         = require('../ai/prompt');
const { getMemory, addMemory, memories }         = require('../ai/memory');
const { addDecayMemory, decayAllMemories,
        pruneMemory, setGameMinute }             = require('../ai/memoryDecay');
const { maybeCreateFromInteraction,
        startGossipTimer, createGossip }         = require('../ai/gossip');
const { updateReputation, getRepSummary,
        inferFromMessage, ACTION_PRESETS }       = require('../ai/reputation');
const { updateRelationship, getRelationshipState,
        getRelationship }                        = require('../ai/relationships');
const { checkAndTriggerCollapse }                = require('../ai/relationshipsAdvanced');
const { updateFactionRepFromNpc,
        getFactionSummary, getNpcFaction }       = require('../ai/factions');
const { enterHouse, exitHouse, placeItem,
        removeItem, planNpcVisits,
        getHouseSummary }                        = require('../ai/housing');
const { tick: eventTick, joinEvent,
        getActiveEvent, isEventActive }          = require('../ai/events');
const { assessPlayerMessage,
        generateStatement, spreadExposedLie,
        DECEPTION_PROFILES }                     = require('../ai/deception');
const { tickPolitics, createIssue,
        playerVote, playerInfluenceVote,
        resolveElection, getOpenIssues,
        getIssue }                               = require('../ai/politics');
const { buyItem, earnMoney, getWalletSummary,
        getAllShops, getShopData,
        getAvailableJobs, tickDemandDecay,
        applyPoliticsModifier }                  = require('../ai/economy');
const { increaseDrama, relieveDrama,
        checkDramaThreshold, triggerDramaEvent,
        getDramaContext, getDramaSummary,
        getAllDramaLevels, decayDrama }           = require('../ai/drama');
const { addXP, getProgress, hasUnlock,
        investSkill, getEconomicBonus,
        getShopDiscount }                        = require('../ai/progression');
const agents    = require('../ai/agents.json');
const locations = require('../ai/locations.json');
const routine   = require('../ai/routine');
const townsData = require('../ai/towns.json');

// ── CULTURE SYSTEM ──
// Applies per-town culture modifiers to AI behaviour.
// culture.honesty   → inverse lieChance modifier
// culture.chaos     → drama pressure multiplier
// culture.friendliness → relationship delta bonus
// culture.wealth    → economy price multiplier (already via shopBonus)

/** Get the culture object for whichever town a player is currently in */
function getPlayerCulture(playerId) {
  const p      = Object.values(players).find(pl => pl._id === playerId);
  const townId = p?.townId || 'pixel_synapse';
  const town   = townsData.towns.find(t => t.id === townId);
  return town?.culture || { friendliness: 65, honesty: 60, wealth: 55, chaos: 40 };
}

/** Get NPC's town culture (NPCs absorb their town's culture) */
function getNpcCulture(npcId) {
  // Find which town this NPC currently lives in via player lookup
  // Default to pixel_synapse culture
  return { friendliness: 65, honesty: 60, wealth: 55, chaos: 40 };
}

/** Drama multiplier from chaos culture value (0→0.5×, 100→2×) */
function cultureDramaMultiplier(culture) {
  return 0.5 + (culture.chaos / 100) * 1.5;
}

/** Relationship bonus from friendliness culture (0→-5, 100→+10) */
function cultureFriendlinessBonus(culture) {
  return Math.round((culture.friendliness - 50) / 10);
}

/** Lie chance modifier from honesty culture (high honesty → fewer lies) */
function cultureHonestyModifier(culture) {
  return (100 - culture.honesty) / 100; // 0..1 — multiplied into lieChance
}

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, '../client')));

// ─────────────────────────────────────────────
// WORLD STATE
// ─────────────────────────────────────────────
const players         = {};
const playerIds       = {};
const socketByPlayerId = {};

const npcMeta = {};
agents.forEach(a => { npcMeta[a.id] = { id: a.id, name: a.name, color: a.color, role: a.role }; });

function buildNpcList() {
  return routine.getAllStates().map(rs => ({
    ...npcMeta[rs.id], x: rs.x, y: rs.y,
    state: rs.state, action: rs.action, label: rs.label,
    targetX: rs.targetX, targetY: rs.targetY,
  }));
}

// ─────────────────────────────────────────────
// BROADCAST
// ─────────────────────────────────────────────
function broadcast(data, excludeSocket = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c !== excludeSocket) c.send(msg);
  });
}

function sendToPlayer(playerId, data) {
  const ws = socketByPlayerId[playerId];
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ─────────────────────────────────────────────
// SECRET SYSTEM
// ─────────────────────────────────────────────
const _revealedSecrets = new Set();

function shouldRevealSecret(agent, rel, rep, message) {
  if (!agent.secret_trigger) return false;
  const msgLower = (message || '').toLowerCase();
  return agent.secret_trigger.split(/\s+OR\s+/i).some(cond => {
    cond = cond.trim();
    const fM = cond.match(/friendship\s*>=\s*(\d+)/i); if (fM && rel.friendship >= +fM[1]) return true;
    const tM = cond.match(/trust\s*>=\s*(\d+)/i);      if (tM && rel.trust     >= +tM[1]) return true;
    const rM = cond.match(/romance\s*>=\s*(\d+)/i);    if (rM && rel.romance   >= +rM[1]) return true;
    const cM = cond.match(/chaos\s*<=\s*(\d+)/i);      if (cM && (rep.chaos??0) <= +cM[1]) return true;
    const wM = cond.match(/player (?:mentions|asks about) '([^']+)'/i);
    if (wM && msgLower.includes(wM[1].toLowerCase())) return true;
    return false;
  });
}

// ─────────────────────────────────────────────
// START SYSTEMS
// ─────────────────────────────────────────────
routine.start(broadcast, 8);
startGossipTimer(30000);

// ── Economy: decay item demand every 10 real minutes ──
setInterval(tickDemandDecay, 600000);

// ── Memory: decay + prune every 5 real minutes ──
setInterval(() => {
  decayAllMemories();
  agents.forEach(a => pruneMemory(a.id));
}, 300000);

// ── Housing: NPC visits every 30s ──
setInterval(() => {
  const visits = planNpcVisits();
  for (const visit of visits) {
    routine.setNpcPosition(visit.npcId, visit.worldX, visit.worldY);
    broadcast({ type: 'npc_move', id: visit.npcId, x: visit.worldX, y: visit.worldY });
    sendToPlayer(visit.playerId, { type: 'npc_visit', npcId: visit.npcId });
    updateRelationship(visit.npcId, visit.playerId, 'visited_house');
    broadcast({ type: 'house_visitor', npcId: visit.npcId, playerId: visit.playerId });
  }
}, 30000);

// ── Events + Politics: hooked into routine's game_time broadcast ──
let _lastTickMinute = -1;
const _origBroadcast = broadcast;

function tickAllTimeSystems(gameMinute) {
  if (gameMinute === _lastTickMinute) return;
  _lastTickMinute = gameMinute;

  setGameMinute(gameMinute); // sync memory decay clock

  // Events
  const before = getActiveEvent();
  eventTick(gameMinute, players, locations, _origBroadcast);
  const after = getActiveEvent();
  if (!before && after) {
    for (const npcId of after.npcParticipants) {
      const loc = locations[after.location] || { x: 400, y: 400 };
      routine.setNpcPosition(npcId, loc.x, loc.y);
      _origBroadcast({ type: 'npc_move', id: npcId, x: loc.x, y: loc.y });
    }
  }

  // Politics + economy integration
  const economy = require('../ai/economy');
  const issuesBefore = getOpenIssues().map(i => i.id);
  tickPolitics(gameMinute, economy);
  const issuesAfter = getOpenIssues().map(i => i.id);

  // Broadcast any elections that just resolved
  const { archived: _archived } = require('../ai/politics');
  for (const resolved of _archived.slice(-5)) {
    if (issuesBefore.includes(resolved.id) && !issuesAfter.includes(resolved.id)) {
      _origBroadcast({
        type:     'politics_result',
        name:     resolved.name,
        outcome:  resolved.outcome,
        sides:    resolved.sides,
        yesCount: resolved.tally.yes,
        noCount:  resolved.tally.no,
      });
    }
  }

  // Memory decay — every 60 in-game minutes
  if (gameMinute % 60 === 0) {
    decayAllMemories();
    for (const a of agents) pruneMemory(a.id);
    setGameMinute(gameMinute);
    decayDrama(); // drama slowly fades when nothing happens
  }

  // Hourly broadcasts
  if (gameMinute % 60 === 0) {
    _origBroadcast({ type: 'politics_update', issues: getOpenIssues() });
    _origBroadcast({ type: 'economy_update',  shops: getAllShops() });
  }
}

// Patch routine to call our tick hook on each game_time broadcast
const originalRoutineStart = routine.start.bind(routine);
// Since routine is already started, we register a listener through a wrapper:
const _patchedBroadcast = (data) => {
  _origBroadcast(data);
  if (data.type === 'game_time') {
    tickAllTimeSystems(data.hour * 60 + data.minute);
  }
};
// Re-start routine with patched broadcast to enable time hooks
// (clear existing interval via module reload won't work, so we just call tickAllTimeSystems manually)
// Instead, schedule our own parallel timer that fires every second (same as routine's GAME_SPEED=1)
setInterval(() => {
  const t = routine.getTime();
  tickAllTimeSystems(t.hour * 60 + t.minute);
}, 1000);

// ─────────────────────────────────────────────
// PLAYER HELPERS
// ─────────────────────────────────────────────
let idCounter = 0;
function genId() { return 'p' + (++idCounter) + '_' + Date.now(); }

const PLAYER_COLORS = ['#4fc3f7','#81c784','#ffb74d','#f06292','#ce93d8','#80cbc4','#fff176','#ff8a65'];
function randColor() { return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]; }
function randName() {
  const adj  = ['Swift','Brave','Quiet','Bold','Keen','Wise','Calm','Bright'];
  const noun = ['Fox','Wolf','Hawk','Bear','Lynx','Stag','Raven','Pike'];
  return adj[Math.floor(Math.random() * adj.length)] + noun[Math.floor(Math.random() * noun.length)];
}

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
wss.on('connection', (ws) => {
  const socketId    = genId();
  const playerName  = randName();
  const playerColor = randColor();

  playerIds[socketId]        = socketId;
  socketByPlayerId[socketId] = ws;

  players[socketId] = {
    x: 300 + Math.floor(Math.random() * 200),
    y: 300 + Math.floor(Math.random() * 200),
    name: playerName, color: playerColor,
  };

  updateReputation(socketId, 'custom', {}, 'joined');
  console.log(`[+] ${playerName} (${socketId})`);

  ws.send(JSON.stringify({
    type:       'init',
    id:         socketId,
    name:       playerName,
    color:      playerColor,
    players,
    npcs:       buildNpcList(),
    game_time:  routine.getTime(),
    locations,
    reputation: getRepSummary(socketId),
    factions:   getFactionSummary(socketId),
    house:      getHouseSummary(socketId),
    event:      getActiveEvent(),
    politics:   getOpenIssues(),
    economy:    { wallet: getWalletSummary(socketId), shops: getAllShops() },
    progression: getProgress(socketId),
    drama:      getAllDramaLevels(),
  }));

  broadcast({ type: 'player_join', id: socketId, ...players[socketId] }, ws);

  // ─────────────────────────────────────────────
  // INCOMING MESSAGES
  // ─────────────────────────────────────────────
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const playerId = playerIds[socketId];

    // ── MOVE ──
    if (msg.type === 'move') {
      if (!players[socketId]) return;
      players[socketId].x = msg.x;
      players[socketId].y = msg.y;
      broadcast({ type: 'player_move', id: socketId, x: msg.x, y: msg.y });

      if (isEventActive()) {
        const ev  = getActiveEvent();
        const loc = locations[ev.location] || { x: 400, y: 400 };
        const dx = msg.x - loc.x, dy = msg.y - loc.y;
        if (Math.sqrt(dx*dx + dy*dy) < 120 && joinEvent(playerId)) {
          ws.send(JSON.stringify({ type: 'event_joined', event: ev }));
        }
      }
    }

    // ── NPC INTERACT ──
    if (msg.type === 'npc_interact') {
      const { npcId, message } = msg;
      const agent = agents.find(a => a.id === npcId);
      if (!agent) return;

      // Culture — get modifiers for the town this player is in
      const townId  = players[socketId]?.townId || 'pixel_synapse';
      const town    = townsData.towns.find(t => t.id === townId);
      const culture = town?.culture || { friendliness: 65, honesty: 60, wealth: 55, chaos: 40 };
      const _dramaMult  = cultureDramaMultiplier(culture);
      const _frndBonus  = cultureFriendlinessBonus(culture);

      // 1. Infer reputation + check for player lies
      inferFromMessage(playerId, message);
      updateReputation(playerId, 'long_conversation', {}, `chatted with ${agent.name}`);

      const rel = getRelationship(npcId, playerId);
      const rep = getRepSummary(playerId);

      // 2. Assess if player might be lying
      const lieAssessment = assessPlayerMessage(message, rel.trust);

      // 3. Check secret reveal
      const revealSecret = agent.secret && agent.secret_reveal
        && !_revealedSecrets.has(`${npcId}:${playerId}`)
        && shouldRevealSecret(agent, rel, rep, message);

      // 4. Build prompt — use decay-aware memory
      const memory    = getMemory(npcId, playerId);
      const gameTime  = routine.getTime();
      const rs        = routine.npcStates[npcId];
      const prompt    = buildNPCPrompt(
        agent, memory, message, playerName, playerId,
        gameTime, rs,
        { revealSecret, playerTrust: rel.trust }
      );

      // 5. Call Claude
      let aiReply;
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key':    process.env.ANTHROPIC_API_KEY || '',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model:      'claude-sonnet-4-20250514',
            max_tokens: 400,
            messages:   [{ role: 'user', content: prompt }],
          }),
        });
        const data  = await response.json();
        const text  = data.content?.[0]?.text || '';
        aiReply     = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch {
        aiReply = getFallbackReply(agent, message);
      }

      // 6. Store memory with decay scoring
      addDecayMemory(npcId, playerId, {
        playerMessage: message,
        npcReply:      aiReply.reply,
        playerName,
        emotion:       aiReply.emotion,
      });

      // 7. Relationship update
      const relAction = aiReply.relationship_delta;
      if (relAction && relAction !== 'null') {
        updateRelationship(npcId, playerId, relAction);
      } else if (['happy','excited'].includes(aiReply.emotion)) {
        updateRelationship(npcId, playerId, 'complimented');
      } else if (aiReply.emotion === 'suspicious' || aiReply.action === 'walk_away') {
        updateRelationship(npcId, playerId, 'ignored');
      } else {
        updateRelationship(npcId, playerId, 'long_talk');
      }

      // 8. Faction rep
      updateFactionRepFromNpc(npcId, playerId,
        ['happy','excited'].includes(aiReply.emotion) ? 3 : -1);

      // 9. Global reputation
      if (['happy','excited'].includes(aiReply.emotion)) {
        updateReputation(playerId, 'gave_compliment', {}, `${agent.name} reacted positively`);
      } else if (aiReply.emotion === 'suspicious' || aiReply.action === 'walk_away') {
        updateReputation(playerId, 'interrupted', {}, `${agent.name} was suspicious`);
      }

      // 10. Deception — if NPC detected a lie, increase drama + notify player
      if (aiReply.lie_detected || lieAssessment.likelyLie) {
        updateRelationship(npcId, playerId, 'lied');
        updateReputation(playerId, 'lied', {}, `${agent.name} suspected a lie`);
        increaseDrama(npcId, 'lie_detected',
          Math.round(12 * _dramaMult), `${playerName} may have lied`);
        const liedStmt = generateStatement(npcId, {
          topic: 'player honesty', trueFact: `${playerName} may have lied`,
          playerId, playerName, trust: rel.trust, emotion: aiReply.emotion,
        });
        if (liedStmt.lied) {
          createGossip(npcId, playerId, playerName,
            `${agent.name} suspects ${playerName} isn't being entirely honest`);
          increaseDrama(npcId, 'rumour_spread', Math.round(8 * _dramaMult));
        }
        ws.send(JSON.stringify({ type: 'lie_detected', npcId, npcName: agent.name }));
      }

      // 11. Gossip seeding → increases drama pressure (scaled by town chaos)
      const gossipSeed = aiReply.gossip_seed;
      if (gossipSeed && gossipSeed !== 'null') {
        createGossip(npcId, playerId, playerName, gossipSeed);
        increaseDrama(npcId, 'gossip_received', Math.round(5 * _dramaMult));
      } else {
        maybeCreateFromInteraction(npcId, playerId, playerName, message, aiReply.reply);
      }

      // 12. Drama: positive interactions relieve tension; culture affects rate
      if (['happy','excited'].includes(aiReply.emotion)) {
        relieveDrama(npcId, 'player_was_kind');
      } else if (aiReply.emotion === 'suspicious' || aiReply.action === 'walk_away') {
        increaseDrama(npcId, 'gossip_received', Math.round(5 * _dramaMult));
      }
      increaseDrama(npcId, 'long_talk'); // baseline decay (chatting calms things)

      // 12b. Check if drama threshold crossed → fire public event
      const dramaCheck = checkDramaThreshold(npcId);
      if (dramaCheck.shouldFire) {
        setTimeout(() => {
          triggerDramaEvent(npcId, playerId, playerName, (evt) => {
            broadcast({ type: 'drama_event', ...evt });
            const xpResult = addXP(playerId, 'drama_resolved');
            sendToPlayer(playerId, { type: 'xp_update', ...xpResult });
          });
        }, 800);
      }

      // 13. Relationship collapse
      const collapse = checkAndTriggerCollapse(npcId, playerId, playerName, (event) => {
        broadcast({ type: 'relationship_collapse', ...event });
        increaseDrama(npcId, 'relationship_collapse', Math.round(20 * _dramaMult));
      });

      // 14. Secret reveal
      if (revealSecret) {
        _revealedSecrets.add(`${npcId}:${playerId}`);
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'secret_reveal', npcId, npcName: agent.name,
            secretText: agent.secret_reveal,
          }));
          createGossip(npcId, playerId, playerName,
            `${playerName} learned ${agent.name}'s deepest secret`);
          const xpResult = addXP(playerId, 'secret_discovered');
          ws.send(JSON.stringify({ type: 'xp_update', ...xpResult }));
        }, 1800);
      }

      // 15. XP for chatting
      const xpResult = addXP(playerId, 'npc_chat');

      // 16. Send reply — include culture so client can show town personality
      const relState    = getRelationshipState(npcId, playerId);
      const dramaSummary = getDramaSummary(npcId);
      ws.send(JSON.stringify({
        type:         'npc_reply',
        npcId,
        npcName:      agent.name,
        reply:        aiReply.reply   || '...',
        emotion:      aiReply.emotion || 'neutral',
        action:       aiReply.action  || 'none',
        reputation:   getRepSummary(playerId),
        factions:     getFactionSummary(playerId),
        relationship: { npcId, ...relState, ...getRelationship(npcId, playerId) },
        wallet:       getWalletSummary(playerId),
        collapse:     collapse ? { type: collapse.subtype, message: collapse.message } : null,
        drama:        { npcId, ...dramaSummary },
        progression:  xpResult,
        culture,
      }));

      // 17. Walk to player
      if (aiReply.action === 'walk_to_player' && players[socketId]) {
        const px = players[socketId].x, py = players[socketId].y;
        routine.setNpcPosition(npcId,
          Math.round(px + (Math.random() > 0.5 ? 36 : -36)),
          Math.round(py + (Math.random() > 0.5 ? 24 : -24)));
        broadcast({ type: 'npc_move', id: npcId,
          x: routine.npcStates[npcId].x, y: routine.npcStates[npcId].y });
      }
    }

    // ── ECONOMY: BUY ──
    if (msg.type === 'shop_buy') {
      const result = buyItem(playerId, players[socketId]?.name, msg.shopId, msg.itemId);
      if (result.ok) {
        const xpResult = addXP(playerId, 'shop_purchase');
        ws.send(JSON.stringify({
          type:     'economy_bought',
          itemName: result.itemName || msg.itemId,
          price:    result.price   || 0,
          balance:  result.balance || getWalletSummary(playerId).coins,
          shopId:   msg.shopId,
          progression: xpResult,
        }));
        broadcast({ type: 'economy_update', shops: getAllShops() });
      } else {
        ws.send(JSON.stringify({ type: 'shop_error', error: result.error, shopId: msg.shopId }));
      }
    }

    // ── ECONOMY: JOB ──
    if (msg.type === 'job_do') {
      const rel    = getRelationship(msg.npcId, playerId);
      const gm     = routine.getTime().hour * 60 + routine.getTime().minute;
      const result = earnMoney(playerId, players[socketId]?.name, msg.npcId, msg.jobId, gm, rel);
      if (result.ok) {
        const xpResult = addXP(playerId, 'job_complete');
        relieveDrama(msg.npcId, 'helped');
        ws.send(JSON.stringify({
          type:    'economy_earned',
          jobName: result.jobName || msg.jobId,
          amount:  result.amount  || 0,
          balance: result.balance || getWalletSummary(playerId).coins,
          progression: xpResult,
        }));
      } else {
        ws.send(JSON.stringify({ type: 'shop_error', error: result.error }));
      }
    }

    // ── ECONOMY: GET SHOP ──
    if (msg.type === 'shop_get') {
      const rel = getRelationship(msg.npcId || '', playerId);
      const gm  = routine.getTime().hour * 60 + routine.getTime().minute;
      ws.send(JSON.stringify({
        type:   'shop_data',
        shop:   getShopData(msg.npcId),
        jobs:   getAvailableJobs(msg.npcId, playerId, gm, rel),
        wallet: getWalletSummary(playerId),
        drama:  getDramaSummary(msg.npcId || ''),
      }));
    }

    // ── PROGRESSION: GET ──
    if (msg.type === 'progression_get') {
      ws.send(JSON.stringify({ type: 'progression_data', progression: getProgress(playerId) }));
    }

    // ── PROGRESSION: INVEST SKILL ──
    if (msg.type === 'skill_invest') {
      const result = investSkill(playerId, msg.path);
      ws.send(JSON.stringify({ type: 'skill_result', ...result, progression: getProgress(playerId) }));
    }

    // ── DRAMA: GET ──
    if (msg.type === 'drama_get') {
      ws.send(JSON.stringify({ type: 'drama_data', drama: getAllDramaLevels() }));
    }

    // ── NPC MEMORY: GET TOP MEMORIES ──
    // Returns the top 5 most relevant memories this NPC has of the player.
    // Used by the Memory Visualization panel on the client.
    if (msg.type === 'npc_memory_get') {
      const { npcId: memNpcId } = msg;
      const npcMem = memories[memNpcId]?.[playerId] || null;
      const drama  = getDramaSummary(memNpcId);

      // Pull from both shortTerm and longTerm, sort by importance × strength
      const all = [
        ...(npcMem?.shortTerm || []),
        ...(npcMem?.longTerm  || []),
      ];

      // Deduplicate by playerSaid, take strongest version
      const seen = new Set();
      const deduped = all.filter(e => {
        const key = (e.playerSaid || '').slice(0, 40);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Score: importance × strength (both default to 1 if undefined)
      const scored = deduped.map(e => ({
        ...e,
        score: (e.importance || 3) * (e.strength ?? 1),
      })).sort((a, b) => b.score - a.score).slice(0, 5);

      // Classify each memory as positive / negative / neutral
      const classified = scored.map(e => {
        const emotion = (e.emotion || 'neutral').toLowerCase();
        const text    = (e.playerSaid || '').toLowerCase();
        const iReply  = (e.iReplied  || '').toLowerCase();
        let valence = 'neutral';
        if (['happy','excited'].includes(emotion) || text.includes('help') || text.includes('thank'))
          valence = 'positive';
        if (['suspicious','sad','nervous'].includes(emotion) || text.includes('lie') ||
            text.includes('betray') || e.distorted)
          valence = 'negative';
        return {
          text:      e.distorted ? e.playerSaid : (e.playerSaid || '').slice(0, 80),
          reply:     (e.iReplied  || '').slice(0, 60),
          emotion:   e.emotion || 'neutral',
          valence,
          strength:  Math.round((e.strength ?? 1) * 100),
          distorted: !!e.distorted,
          importance: e.importance || 3,
        };
      });

      ws.send(JSON.stringify({
        type:         'npc_memory_data',
        npcId:        memNpcId,
        interactionCount: npcMem?.interactionCount || 0,
        firstMet:     npcMem?.firstMet || null,
        memories:     classified,
        drama:        drama,
        relationship: { ...getRelationshipState(memNpcId, playerId), ...getRelationship(memNpcId, playerId) },
      }));
    }

    // ── POLITICS: VOTE ──
    if (msg.type === 'politics_vote') {
      playerVote(msg.issueId, playerId, msg.side);
      const xpResult = addXP(playerId, 'vote_cast');
      ws.send(JSON.stringify({ type: 'vote_recorded', issueId: msg.issueId, side: msg.side }));
      ws.send(JSON.stringify({ type: 'politics_data', issues: getOpenIssues() }));
      ws.send(JSON.stringify({ type: 'xp_update', ...xpResult }));
    }

    // ── POLITICS: INFLUENCE NPC ──
    if (msg.type === 'politics_influence') {
      const rep    = getRepSummary(playerId);
      const result = playerInfluenceVote(
        msg.npcId, msg.issueId, msg.targetSide, playerId, rep.kindness || 0
      );
      if (result.success) {
        const xpResult = addXP(playerId, 'vote_influenced');
        ws.send(JSON.stringify({ type: 'xp_update', ...xpResult }));
      }
      ws.send(JSON.stringify({ type: 'influence_result', ...result }));
      broadcast({ type: 'politics_update', issues: getOpenIssues() });
    }

    // ── POLITICS: GET ISSUES ──
    if (msg.type === 'politics_get') {
      ws.send(JSON.stringify({ type: 'politics_data', issues: getOpenIssues() }));
    }

    // ── TOWN TRAVEL ──
    // Client requests list of available towns
    if (msg.type === 'travel_get') {
      const townsData = require('../ai/towns.json');
      const currentTown = players[socketId]?.townId || 'pixel_synapse';
      ws.send(JSON.stringify({
        type:        'travel_data',
        towns:       townsData.towns,
        currentTown,
      }));
    }

    // Client confirms travel to a specific town
    if (msg.type === 'travel_to') {
      const townsData = require('../ai/towns.json');
      const target    = townsData.towns.find(t => t.id === msg.townId);
      if (!target) return;

      const prevTown = players[socketId]?.townId || 'pixel_synapse';
      if (prevTown === target.id) {
        ws.send(JSON.stringify({ type: 'travel_result', ok: false, error: 'Already here.' }));
        return;
      }

      // Update player's town
      if (players[socketId]) players[socketId].townId = target.id;

      // Award XP for exploring a new town
      const xpResult = addXP(playerId, 'custom', 15);

      // Build NPC list from this town's npcs array.
      // Each entry has { id, x, y, role } — merge with base agent metadata.
      const townNpcs = (target.npcs || []).map(entry => {
        const base = npcMeta[entry.id];
        if (!base) return null;
        return {
          ...base,
          x:     entry.x,
          y:     entry.y,
          role:  entry.role || base.role,
          state: 'idle',
          action:'idle',
          label: `In ${target.name}`,
        };
      }).filter(Boolean);

      console.log(`[travel] ${playerName} → ${target.name} (mapType: ${target.mapType}, npcs: ${townNpcs.length})`);

      ws.send(JSON.stringify({
        type:        'travel_result',
        ok:          true,
        town:        target,
        mapType:     target.mapType || 'city',
        spawnX:      target.spawnX,
        spawnY:      target.spawnY,
        npcs:        townNpcs,
        progression: xpResult,
        culture:     target.culture || null,
      }));
    }

    // ── HOUSING ──
    if (msg.type === 'house_enter') {
      ws.send(JSON.stringify({ type: 'house_state', ...enterHouse(playerId) }));
    }
    if (msg.type === 'house_exit') {
      exitHouse(playerId);
      ws.send(JSON.stringify({ type: 'house_state', ok: true, inside: false }));
    }
    if (msg.type === 'house_place_item') {
      ws.send(JSON.stringify({ type: 'house_item_placed',
        ...placeItem(playerId, msg.itemType, msg.gridX, msg.gridY),
        house: getHouseSummary(playerId) }));
    }
    if (msg.type === 'house_remove_item') {
      ws.send(JSON.stringify({ type: 'house_item_removed',
        ...removeItem(playerId, msg.itemId),
        house: getHouseSummary(playerId) }));
    }

    // ── REPUTATION ACTION ──
    if (msg.type === 'player_action' && msg.action in ACTION_PRESETS) {
      updateReputation(playerId, msg.action, {}, msg.note || '');
      ws.send(JSON.stringify({ type: 'reputation_update', reputation: getRepSummary(playerId) }));
      broadcast({ type: 'player_rep', id: socketId, reputation: getRepSummary(playerId) }, ws);
    }

    // ── PLAYER CHAT ──
    // Broadcasts a chat message to every connected client (including sender).
    // Message is sanitised and capped at 120 chars.
    if (msg.type === 'player_chat') {
      const raw  = (msg.text || '').toString().replace(/</g, '&lt;').trim();
      const text = raw.slice(0, 120);
      if (!text) return;
      const sender = players[socketId];
      broadcast({
        type:   'player_chat',
        id:     socketId,
        name:   sender?.name || 'Unknown',
        color:  sender?.color || '#aabbff',
        text,
      });
      console.log(`[chat] ${sender?.name}: ${text}`);
    }
  });

  ws.on('close', () => {
    console.log(`[-] ${players[socketId]?.name} left`);
    delete players[socketId];
    delete socketByPlayerId[socketId];
    broadcast({ type: 'player_leave', id: socketId });
  });
});

// ─────────────────────────────────────────────
// FALLBACK REPLIES
// ─────────────────────────────────────────────
function getFallbackReply(agent) {
  const fallbacks = {
    lena:  ["Oh! That's fascinating — can I quote you?", "I'm writing a story about that!"],
    orion: ["Hmm? Oh yes — wait, I lost my train of thought.", "Eureka! No wait, that's not it..."],
    mira:  ["Sit down, love! The coffee is fresh.", "The gossip is hot today, just like the coffee!"],
    kai:   ["...interesting choice of words.", "Everything is traceable. Remember that."],
    zara:  ["*hums* I'm already writing a song about this.", "Shall I write a song about that?"],
    bram:  ["HALT! Oh — you're friendly. Sorry, on edge.", "Did you hear that? Probably nothing..."],
    ivy:   ["Every flower has a story. Like you.", "Growth takes patience. For people too."],
    juno:  ["Bet I can run there faster than you!", "Last one to the fountain buys snacks!"],
    sol:   ["That reminds me of the Great Canyon Expedition...", "Sit down. This story might change your life."],
    pix:   ["[PROCESSING] ...I mean, hello!", "Query: Is this what humans call fun?"],
  };
  const lines = fallbacks[agent.id] || ['...'];
  return {
    reply: lines[Math.floor(Math.random() * lines.length)],
    emotion: 'neutral', action: 'none',
    gossip_seed: null, relationship_delta: null, lie_detected: false,
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Pixel Synapse running on http://localhost:${PORT}`);
  console.log(`🕐 Game time: ${routine.getTime().label}`);
});
