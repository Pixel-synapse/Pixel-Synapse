/**
 * prompt.js — NPC Prompt Builder for Pixel Synapse
 *
 * Assembles all context layers:
 *   character · personality · secret (gated) · time · routine ·
 *   memory (decayed) · relationship · collapse state ·
 *   faction · reputation · deception · gossip ·
 *   politics · economy · event
 */

const { summarizeMemory }        = require('./memoryDecay');
const { getGossipContext }       = require('./gossip');
const { getReputationContext }   = require('./reputation');
const { getRelationshipContext } = require('./relationships');
const { getCollapseContext }     = require('./relationshipsAdvanced');
const { getFactionContext }      = require('./factions');
const { getEventContext }        = require('./events');
const { getDeceptionContext }    = require('./deception');
const { getNpcPoliticalContext } = require('./politics');
const { getEconomyContext }      = require('./economy');
const { getDramaContext }        = require('./drama');

/**
 * Build a complete NPC prompt with all context.
 *
 * @param {object} agent
 * @param {object} memory          - raw memory object (we use summarizeMemory instead)
 * @param {string} playerMessage
 * @param {string} playerName
 * @param {string} playerId
 * @param {object} [gameTime]
 * @param {object} [npcState]
 * @param {object} [options]       - { revealSecret, playerTrust }
 */
function buildNPCPrompt(
  agent, memory, playerMessage,
  playerName = 'a traveler', playerId = null,
  gameTime = null, npcState = null,
  options = {}
) {
  const playerTrust = options.playerTrust ?? 50;

  // ── MEMORY (uses decay-aware summary) ──
  const memoryContext = playerId
    ? summarizeMemory(agent.id, playerId)
    : 'You have never spoken to this player before.';

  // ── ALL OTHER CONTEXT LAYERS ──
  const gossipContext    = playerId ? getGossipContext(agent.id, playerId, playerName) : '';
  const repContext       = playerId ? getReputationContext(agent.id, playerId) : '';
  const relContext       = playerId ? getRelationshipContext(agent.id, playerId) : '';
  const collapseContext  = playerId ? getCollapseContext(agent.id, playerId) : '';
  const factionContext   = getFactionContext(agent.id, playerId || '');
  const deceptionCtx     = playerId ? getDeceptionContext(agent.id, playerId, playerTrust) : '';
  const politicsContext  = getNpcPoliticalContext(agent.id);
  const economyContext   = getEconomyContext(agent.id, playerId);
  const eventContext     = getEventContext();
  const dramaCtx         = getDramaContext(agent.id);

  // ── TIME ──
  let timeContext = '';
  if (gameTime) {
    const h = gameTime.hour;
    const period = h < 6 ? 'the middle of the night'
      : h < 9  ? 'early morning' : h < 12 ? 'morning'
      : h < 14 ? 'midday'       : h < 17 ? 'afternoon'
      : h < 20 ? 'evening'      : 'late night';
    timeContext = `The current game time is ${gameTime.label} (${period}).`;
  }

  // ── ROUTINE ──
  let activityContext = '';
  if (npcState) {
    const ctx = npcState.label || npcState.action || '';
    if (ctx) activityContext = `Right now you are: "${ctx}"${npcState.location ? ` at ${npcState.location}` : ''}.`;
  }

  // ── SECRET ──
  let secretContext = '';
  if (options.revealSecret && agent.secret_reveal) {
    secretContext = [
      `## YOUR SECRET IS BEING REVEALED`,
      `The moment has come — reveal your secret to ${playerName} naturally in your reply.`,
      `Your secret: ${agent.secret}`,
      `What you'll say: "${agent.secret_reveal}"`,
      `Make it the emotional peak of this conversation. It should feel earned.`,
    ].join('\n');
  } else if (agent.secret) {
    secretContext = [
      `## YOUR HIDDEN SECRET (do NOT reveal — shapes your subtext only)`,
      `You carry: ${agent.secret}`,
      `This creates anxiety, deflection, and care about what you admit. Don't name it directly.`,
    ].join('\n');
  }

  // ── ASSEMBLE ──
  const sections = [
    `You are ${agent.name}, a character in Pixel Synapse — a cozy pixel-art MMO town.`,
    '',
    `## YOUR CHARACTER`,
    `Name: ${agent.name} | Role: ${agent.role}`,
    `Personality: ${agent.personality}`,
    `Core traits: ${agent.traits.join(', ')}`,
    `Goal: ${agent.goal}`,
    `Catchphrase: "${agent.catchphrase}"`,
    agent.dialogue_style    ? `Dialogue style: ${agent.dialogue_style}` : '',
    agent.emotional_tendency? `Emotional tendency: ${agent.emotional_tendency}` : '',
    agent.behavior          ? `Typical behavior: ${agent.behavior}` : '',
  ].filter(Boolean);

  if (timeContext || activityContext) {
    sections.push('', '## CURRENT MOMENT');
    if (timeContext)     sections.push(timeContext);
    if (activityContext) sections.push(activityContext);
  }

  if (secretContext) { sections.push(''); sections.push(secretContext); }

  sections.push('', `## YOUR MEMORY OF ${playerName} (may be faded or distorted)`);
  sections.push(memoryContext);

  // Collapse context takes priority over normal relationship context
  if (collapseContext) {
    sections.push(''); sections.push(collapseContext);
  } else if (relContext) {
    sections.push(''); sections.push(relContext);
  }

  if (factionContext)   { sections.push(''); sections.push(factionContext); }
  if (repContext)       { sections.push(''); sections.push(repContext); }
  if (deceptionCtx)     { sections.push(''); sections.push(deceptionCtx); }
  if (politicsContext)  { sections.push(''); sections.push(politicsContext); }
  if (economyContext)   { sections.push(''); sections.push(economyContext); }

  if (gossipContext) {
    sections.push('', `## WHAT YOU'VE HEARD AROUND TOWN`);
    sections.push(gossipContext);
    sections.push(`Let this colour your attitude. Don't quote it verbatim.`);
  }

  if (eventContext) { sections.push(''); sections.push(eventContext); }

  sections.push(
    '',
    `## THE PLAYER JUST SAID`,
    `"${playerMessage}"`,
    '',
    `## HOW TO RESPOND`,
    `- Stay completely in character — 1–3 sentences, specific to who you are`,
    `- Your dialogue style: ${agent.dialogue_style || 'natural, in-character'}`,
    options.revealSecret
      ? `- THIS IS THE MOMENT: deliver your secret reveal naturally`
      : `- Let relationship, deception history, and hidden secret subtly shape your subtext`,
    `- Do NOT announce scores or system values`,
    `- Reference current activity, economy, or politics only if it fits naturally`,
    '',
    `## RESPONSE FORMAT — valid JSON only, no markdown:`,
    `{`,
    `  "reply": "Your in-character spoken response",`,
    `  "emotion": "happy / curious / nervous / suspicious / excited / sad / neutral / glitchy",`,
    `  "action": "none / walk_to_player / walk_away",`,
    `  "relationship_delta": "complimented / rude / lied / helped / threatened / long_talk / null",`,
    `  "gossip_seed": "one-sentence observation about the player worth sharing, or null",`,
    `  "lie_detected": true/false (did you notice the player might be lying?)`,
    `}`
  );

  return sections.join('\n');
}

module.exports = { buildNPCPrompt };
