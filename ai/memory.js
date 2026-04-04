/**
 * memory.js — NPC Memory System for Pixel Synapse
 *
 * Each NPC has:
 *   - shortTerm: last 10 interactions per player
 *   - longTerm: important events flagged by AI (stored indefinitely)
 */

// Structure: memories[npcId][playerId] = { shortTerm: [], longTerm: [] }
const memories = {};

function ensureMemory(npcId, playerId) {
  if (!memories[npcId]) memories[npcId] = {};
  if (!memories[npcId][playerId]) {
    memories[npcId][playerId] = {
      shortTerm: [],
      longTerm: [],
      interactionCount: 0,
      firstMet: new Date().toISOString()
    };
  }
}

/**
 * Get memory context for a specific NPC + player pair
 * Returns a formatted summary for use in AI prompts
 */
function getMemory(npcId, playerId) {
  ensureMemory(npcId, playerId);
  const mem = memories[npcId][playerId];
  return {
    shortTerm: mem.shortTerm.slice(-10),
    longTerm: mem.longTerm.slice(-5),
    interactionCount: mem.interactionCount,
    firstMet: mem.firstMet
  };
}

/**
 * Add a new interaction to memory
 * @param {string} npcId
 * @param {string} playerId
 * @param {object} interaction - { playerMessage, npcReply, playerName, isImportant }
 */
function addMemory(npcId, playerId, interaction) {
  ensureMemory(npcId, playerId);
  const mem = memories[npcId][playerId];

  const entry = {
    timestamp: new Date().toISOString(),
    playerName: interaction.playerName || 'Unknown',
    playerSaid: interaction.playerMessage,
    iReplied: interaction.npcReply,
    emotion: interaction.emotion || 'neutral'
  };

  // Add to short-term memory (keep last 10)
  mem.shortTerm.push(entry);
  if (mem.shortTerm.length > 10) {
    mem.shortTerm.shift();
  }

  mem.interactionCount++;

  // Heuristic: mark as long-term memory if it seems important
  const importantKeywords = [
    'secret', 'important', 'remember', 'always', 'never', 'love', 'hate',
    'afraid', 'help', 'danger', 'promise', 'name', 'from', 'looking for'
  ];
  const msgLower = (interaction.playerMessage || '').toLowerCase();
  const isImportant = importantKeywords.some(kw => msgLower.includes(kw))
    || interaction.isImportant
    || mem.interactionCount === 1; // First meeting is always important

  if (isImportant) {
    mem.longTerm.push({
      ...entry,
      reason: mem.interactionCount === 1 ? 'first_meeting' : 'flagged_important'
    });
    if (mem.longTerm.length > 20) {
      mem.longTerm.shift();
    }
  }
}

/**
 * Format memory for prompt injection
 */
function formatMemoryForPrompt(memory) {
  const lines = [];

  if (memory.interactionCount === 0) {
    return 'You have never spoken to this player before. This is your first meeting.';
  }

  lines.push(`You have spoken with this player ${memory.interactionCount} time(s), first on ${memory.firstMet.split('T')[0]}.`);

  if (memory.longTerm.length > 0) {
    lines.push('\nKey things you remember about them:');
    memory.longTerm.forEach(e => {
      lines.push(`  - They once said: "${e.playerSaid}" (you replied: "${e.iReplied}")`);
    });
  }

  if (memory.shortTerm.length > 0) {
    lines.push('\nRecent conversation (last few exchanges):');
    memory.shortTerm.slice(-4).forEach(e => {
      lines.push(`  ${e.playerName}: "${e.playerSaid}"`);
      lines.push(`  You: "${e.iReplied}"`);
    });
  }

  return lines.join('\n');
}

module.exports = { getMemory, addMemory, formatMemoryForPrompt, memories };
