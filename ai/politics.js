/**
 * politics.js — Town Politics & Elections System
 *
 * The town periodically faces issues that NPCs vote on.
 * Player reputation, faction standing, and persuasion attempts
 * all influence NPC votes. Election outcomes change town life.
 *
 * Issue lifecycle:
 *   proposed → open (NPCs vote over time) → resolved → archived
 *
 * Resolved elections affect:
 *   - Economy (tax rates, shop prices)
 *   - Faction reputation
 *   - NPC daily schedules (conceptually)
 *   - Gossip
 */

const agents           = require('./agents.json');
const { FACTION_DEFS, NPC_FACTION, factionRep } = require('./factions');
const { createGossip } = require('./gossip');
const { relationships } = require('./relationships');

// ─────────────────────────────────────────────
// ISSUE STORE
// ─────────────────────────────────────────────
const issues   = {};  // issueId → issue object
const archived = [];  // resolved issues
let   _issueCounter = 0;

// ─────────────────────────────────────────────
// PRE-DEFINED ISSUE TEMPLATES
// Spawned on a schedule or triggered by events.
// ─────────────────────────────────────────────
const ISSUE_TEMPLATES = [
  {
    template:     'hacker_ban',
    name:         'Ban Hackers from Town Square',
    description:  'Bram has proposed restricting The Network from public spaces.',
    sides:        { yes: 'Support the ban', no: 'Oppose the ban' },
    factionBias:  { guards: 'yes', hackers: 'no', cafe: 'no', naturalists: 'no' },
    effects: {
      yes: { guards: +10, hackers: -20, economy_modifier: -0.05 },
      no:  { guards: -5,  hackers: +10 },
    },
  },
  {
    template:     'new_market',
    name:         'Expand the Market District',
    description:  'Mira proposes a larger market area to grow the economy.',
    sides:        { yes: 'Expand the market', no: 'Keep things small' },
    factionBias:  { cafe: 'yes', naturalists: 'no', guards: 'yes', hackers: 'abstain' },
    effects: {
      yes: { cafe: +10, economy_modifier: +0.15 },
      no:  { cafe: -5,  naturalists: +5 },
    },
  },
  {
    template:     'concert_law',
    name:         'Regulate Street Performances',
    description:  'A proposal to limit busking to designated zones.',
    sides:        { yes: 'Regulate performances', no: 'Keep music free' },
    factionBias:  { guards: 'yes', naturalists: 'no', cafe: 'no', hackers: 'abstain' },
    effects: {
      yes: { naturalists: -15, guards: +8 },
      no:  { naturalists: +10, guards: -5, economy_modifier: +0.05 },
    },
  },
  {
    template:     'security_tax',
    name:         'Raise Security Tax',
    description:  'Juno and Bram want more funds for town protection.',
    sides:        { yes: 'Fund the Watch', no: 'Reduce taxes' },
    factionBias:  { guards: 'yes', hackers: 'no', cafe: 'no', naturalists: 'abstain' },
    effects: {
      yes: { guards: +15, economy_modifier: -0.10 },
      no:  { guards: -10, economy_modifier: +0.05 },
    },
  },
  {
    template:     'open_borders',
    name:         'Open Town to Outsiders',
    description:  'Should strangers be welcomed or kept at the gate?',
    sides:        { yes: 'Welcome all', no: 'Tighten the gate' },
    factionBias:  { cafe: 'yes', guards: 'no', hackers: 'yes', naturalists: 'yes' },
    effects: {
      yes: { cafe: +8, guards: -5, economy_modifier: +0.10 },
      no:  { guards: +10, cafe: -8 },
    },
  },
];

// ─────────────────────────────────────────────
// CREATE ISSUE
// ─────────────────────────────────────────────

/**
 * Create a new town issue that NPCs can vote on.
 * @param {string} [templateId]  - from ISSUE_TEMPLATES, or 'custom'
 * @param {object} [custom]      - override fields for custom issues
 * @returns {object} issue
 */
function createIssue(templateId, custom = {}) {
  const template = ISSUE_TEMPLATES.find(t => t.template === templateId);
  const base = template ? { ...template } : {};
  const issueId = `issue_${++_issueCounter}`;

  const issue = {
    id:           issueId,
    template:     templateId || 'custom',
    name:         custom.name        || base.name        || 'Town Vote',
    description:  custom.description || base.description || '',
    sides:        custom.sides       || base.sides       || { yes: 'Yes', no: 'No' },
    factionBias:  custom.factionBias || base.factionBias || {},
    effects:      custom.effects     || base.effects     || {},
    status:       'open',
    votes:        { yes: {}, no: {}, abstain: {} }, // npcId → side
    playerVotes:  {},   // playerId → side
    tally:        { yes: 0, no: 0, abstain: 0 },
    createdAt:    Date.now(),
    resolvedAt:   null,
    outcome:      null,
  };

  issues[issueId] = issue;
  console.log(`[politics] Issue created: "${issue.name}" (${issueId})`);

  // Trigger immediate NPC voting
  agents.forEach(agent => npcVote(agent.id, issueId));

  return issue;
}

// ─────────────────────────────────────────────
// NPC VOTE
// Each NPC votes based on faction bias, relationships, personality.
// ─────────────────────────────────────────────

/**
 * Determine and record an NPC's vote on an issue.
 * @param {string} npcId
 * @param {string} issueId
 */
function npcVote(npcId, issueId) {
  const issue = issues[issueId];
  if (!issue || issue.status !== 'open') return;

  const fid  = NPC_FACTION[npcId];
  const bias = issue.factionBias?.[fid] || null;

  let vote;
  if (bias === 'abstain') {
    vote = 'abstain';
  } else if (bias) {
    // 75% chance to vote with faction bias, 25% personal deviation
    vote = Math.random() < 0.75 ? bias : (bias === 'yes' ? 'no' : 'yes');
  } else {
    // No faction bias — coin flip with slight personality lean
    const agent = agents.find(a => a.id === npcId);
    const leansOrder = (agent?.traits || []).includes('anxious') || (agent?.traits || []).includes('protective');
    vote = leansOrder ? (Math.random() < 0.6 ? 'yes' : 'no') : (Math.random() < 0.5 ? 'yes' : 'no');
  }

  issue.votes[vote][npcId] = vote;
  issue.tally[vote] = Object.keys(issue.votes[vote]).length;
}

// ─────────────────────────────────────────────
// PLAYER INFLUENCE
// Players can attempt to sway NPC votes via conversation.
// ─────────────────────────────────────────────

/**
 * Player attempts to influence an NPC's vote.
 * Success chance scales with relationship trust + faction rep.
 *
 * @param {string} npcId
 * @param {string} issueId
 * @param {string} targetSide  - 'yes' or 'no'
 * @param {string} playerId
 * @param {number} [repScore]  - player's global reputation score
 * @returns {{ success: boolean, previousVote: string, newVote: string }}
 */
function playerInfluenceVote(npcId, issueId, targetSide, playerId, repScore = 0) {
  const issue = issues[issueId];
  if (!issue || issue.status !== 'open') return { success: false };

  const rel = relationships[npcId]?.[playerId];
  const trust      = rel?.trust      || 0;
  const friendship = rel?.friendship || 0;
  const fid        = NPC_FACTION[npcId];
  const facRep     = (factionRep[fid]?.[playerId] || 0);

  // Base persuasion chance
  const persuasionChance = Math.min(0.85,
    0.10 +
    (trust      / 100) * 0.3 +
    (friendship / 100) * 0.2 +
    (facRep     / 100) * 0.2 +
    (repScore   / 100) * 0.1
  );

  const success = Math.random() < persuasionChance;

  // Find current vote
  let previousVote = 'abstain';
  for (const [side, voters] of Object.entries(issue.votes)) {
    if (voters[npcId]) { previousVote = side; break; }
  }

  if (success) {
    // Remove from old bucket, add to new
    for (const side of Object.keys(issue.votes)) {
      delete issue.votes[side][npcId];
      issue.tally[side] = Object.keys(issue.votes[side]).length;
    }
    issue.votes[targetSide][npcId] = targetSide;
    issue.tally[targetSide] = Object.keys(issue.votes[targetSide]).length;
  }

  return { success, previousVote, newVote: success ? targetSide : previousVote };
}

/**
 * Record a player's own vote on an issue.
 */
function playerVote(issueId, playerId, side) {
  const issue = issues[issueId];
  if (!issue || issue.status !== 'open') return;
  issue.playerVotes[playerId] = side;
}

// ─────────────────────────────────────────────
// RESOLVE ELECTION
// Count votes, apply effects, archive.
// ─────────────────────────────────────────────

/**
 * Close voting and apply the winning side's effects.
 * @returns {{ outcome: string, margin: number, effects: object }}
 */
function resolveElection(issueId, economySystem) {
  const issue = issues[issueId];
  if (!issue || issue.status !== 'open') return null;

  issue.status     = 'resolved';
  issue.resolvedAt = Date.now();

  const yesCount = issue.tally.yes + Object.values(issue.playerVotes).filter(v => v === 'yes').length;
  const noCount  = issue.tally.no  + Object.values(issue.playerVotes).filter(v => v === 'no').length;

  const outcome = yesCount >= noCount ? 'yes' : 'no';
  const margin  = Math.abs(yesCount - noCount);
  issue.outcome = outcome;

  const effects = issue.effects?.[outcome] || {};

  // Apply faction reputation effects
  for (const [fid, amount] of Object.entries(effects)) {
    if (fid === 'economy_modifier') continue;
    if (FACTION_DEFS[fid]) {
      for (const playerId of Object.keys(issue.playerVotes)) {
        const playerSide = issue.playerVotes[playerId];
        // Players who voted with the winner gain rep with winning faction
        if (playerSide === outcome) {
          const { updateFactionReputation } = require('./factions');
          updateFactionReputation(fid, playerId, Math.round(amount * 0.5));
        }
      }
    }
  }

  // Apply economy modifier
  if (effects.economy_modifier && economySystem) {
    economySystem.applyPoliticsModifier(effects.economy_modifier, issue.name);
  }

  // Spread result as gossip
  const loudestNpc = agents.find(a => NPC_FACTION[a.id] === Object.keys(effects)[0]) || agents[0];
  for (const playerId of Object.keys(issue.playerVotes)) {
    createGossip(loudestNpc.id, playerId, 'Town',
      `The vote on "${issue.name}" concluded — ${issue.sides[outcome]} won with ${yesCount}-${noCount}`);
  }

  archived.push(issue);
  delete issues[issueId];

  console.log(`[politics] "${issue.name}" resolved → ${outcome} (${yesCount}:${noCount})`);
  return { outcome, margin, yesCount, noCount, effects, issue };
}

// ─────────────────────────────────────────────
// POLITICAL STANCE CONTEXT
// For AI prompt injection.
// ─────────────────────────────────────────────

/**
 * Return an NPC's political stance for use in their prompt.
 */
function getNpcPoliticalContext(npcId) {
  const fid    = NPC_FACTION[npcId];
  const def    = FACTION_DEFS[fid];
  const openIssues = Object.values(issues).filter(i => i.status === 'open');

  if (openIssues.length === 0) return '';

  const lines = [`## TOWN POLITICS`];
  for (const issue of openIssues.slice(0, 2)) {
    const myVote = Object.entries(issue.votes)
      .find(([, voters]) => voters[npcId])?.[0] || 'undecided';
    lines.push(`Current issue: "${issue.name}" — your vote: ${myVote}.`);
    if (def) lines.push(`Your faction (${def.name}) generally ${issue.factionBias?.[fid] === 'yes' ? 'supports' : issue.factionBias?.[fid] === 'no' ? 'opposes' : 'is divided on'} this.`);
  }

  return lines.join('\n');
}

/**
 * Get all open issues for client display.
 */
function getOpenIssues() { return Object.values(issues).filter(i => i.status === 'open'); }
function getAllIssues()   { return Object.values(issues); }
function getIssue(id)    { return issues[id] || null; }

// Auto-create issues on a schedule (one per day)
let _lastIssuedMinute = -1;
const ISSUE_SCHEDULE = [
  { minute: 120, template: 'hacker_ban'    },
  { minute: 360, template: 'new_market'    },
  { minute: 600, template: 'concert_law'   },
  { minute: 840, template: 'security_tax'  },
  { minute: 1080, template: 'open_borders' },
];

function tickPolitics(gameMinute, economySystem) {
  // Auto-resolve issues older than 4 game hours
  for (const issue of Object.values(issues)) {
    if (issue.status === 'open') {
      const ageMinutes = gameMinute - (Math.floor(issue.createdAt / 1000) % 1440);
      if (Math.abs(ageMinutes) > 240) {
        resolveElection(issue.id, economySystem);
      }
    }
  }

  // Schedule new issues
  for (const entry of ISSUE_SCHEDULE) {
    if (gameMinute === entry.minute && _lastIssuedMinute !== entry.minute) {
      _lastIssuedMinute = entry.minute;
      createIssue(entry.template);
    }
  }
}

module.exports = {
  ISSUE_TEMPLATES,
  createIssue,
  npcVote,
  playerVote,
  playerInfluenceVote,
  resolveElection,
  getNpcPoliticalContext,
  getOpenIssues,
  getAllIssues,
  getIssue,
  tickPolitics,
  issues,
  archived,
};
