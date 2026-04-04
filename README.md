# 🎮 Pixel Synapse

A cozy 2D pixel-art social MMO where human players explore a living town populated by AI-powered NPCs with memory, personality, and real conversations.

```
pixel-synapse/
├── client/
│   ├── index.html     — Game UI, dialogue overlay, HUD, minimap, styles
│   └── main.js        — Phaser 3 game engine: world, player, NPC sprites, input, WS sync
├── server/
│   ├── server.js      — Express + WebSocket server: player sync, AI pipeline
│   └── package.json   — Node.js dependencies
├── ai/
│   ├── agents.json    — 10 NPC character definitions (personality, goals, traits)
│   ├── memory.js      — Short-term + long-term memory per NPC per player
│   └── prompt.js      — Builds rich character-faithful prompts for Claude API
└── README.md
```

---

## 🚀 Run Locally

### Prerequisites
- Node.js 18+ (https://nodejs.org)

### Steps

```bash
# 1. Clone / download the project
cd pixel-synapse/server

# 2. Install dependencies
npm install

# 3. (Optional) Add your Anthropic API key for live AI responses
# Without it, NPCs use built-in fallback responses
export ANTHROPIC_API_KEY=your_key_here
# On Windows: set ANTHROPIC_API_KEY=your_key_here

# 4. Start the server
node server.js

# 5. Open your browser
# http://localhost:3000
```

That's it. Open multiple browser tabs to test multiplayer.

---

## 🎯 How to Play

| Key | Action |
|-----|--------|
| `WASD` or `Arrow Keys` | Move your character |
| `E` | Interact with nearby NPC |
| `Enter` | Send dialogue message |
| `Escape` | Close dialogue |

Walk near any glowing character (NPC), press **E** to open the dialogue panel, then type anything to start a conversation. Each NPC has a unique personality and remembers your previous conversations.

---

## 🤖 The 10 AI NPCs

| Name | Role | Color | Personality |
|------|------|-------|-------------|
| Lena | Curious Journalist | Gold | Interviews everyone, chases secrets |
| Orion | Distracted Inventor | Orange | Brilliant but absent-minded |
| Mira | Café Owner | Peach | Warm, welcoming, knows all the gossip |
| Kai | Mysterious Hacker | Cyan | Cryptic, tests your morality |
| Zara | Street Musician | Lavender | Emotional, turns life into songs |
| Bram | Paranoid Guard | Brown | Protective, jumpy, can't relax |
| Ivy | Botanist | Green | Calm, philosophical, plant metaphors |
| Juno | Competitive Racer | Yellow | Pure energy, challenges everyone |
| Sol | Retired Adventurer | Coral | Wise, full of stories |
| Pix | Childlike Robot | Silver | Glitchy, learning what feelings are |

---

## 🔑 Adding Your Claude API Key

Without an API key, NPCs use pre-written fallback lines (still fun!).

For live AI responses:

```bash
# In your terminal before starting the server:
export ANTHROPIC_API_KEY=sk-ant-...

# Or create a .env file in /server:
ANTHROPIC_API_KEY=sk-ant-...
```

Then install dotenv: `npm install dotenv` and add `require('dotenv').config()` at the top of `server.js`.

---

## ☁️ Deploy to Render (Free Tier)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your GitHub repo
4. Set **Root Directory**: `server`
5. **Build Command**: `npm install`
6. **Start Command**: `node server.js`
7. Add Environment Variable: `ANTHROPIC_API_KEY` = your key
8. Deploy → your game is live at `https://your-app.onrender.com`

Note: Render serves static files from the `../client` folder automatically via Express.

---

## 🎮 Deploy to Replit

1. Create a new **Node.js** Repl
2. Upload all files maintaining the folder structure
3. In Shell: `cd server && npm install`
4. Click **Run** (starts `node server.js`)
5. Enable **Always On** in Repl settings
6. Share the URL — multiplayer works instantly

---

## 🌐 Deploy to Glitch

1. Go to [glitch.com](https://glitch.com) → New Project → Import from GitHub
2. Glitch auto-detects Node and runs `npm start`
3. Update `package.json` start script if needed: `"start": "node server/server.js"`
4. Add `ANTHROPIC_API_KEY` in Glitch's `.env` panel

---

## 🛠 Extending the Game

### Add a New NPC
Edit `ai/agents.json` — add a new object following the existing structure. The server auto-loads all agents on start.

### Adjust NPC Memory
In `ai/memory.js`, change:
- `SHORT_TERM_LIMIT` (line: `if (mem.shortTerm.length > 10)`) — how many recent exchanges NPCs remember
- `importantKeywords` — what triggers long-term memory storage

### Change the World
In `client/main.js` → `createTextures()` — the entire pixel world is drawn on an HTML5 canvas. Add buildings, decorations, paths using the canvas 2D API.

### Add NPC Scheduled Events
In `server/server.js`, add a `setInterval` that moves specific NPCs to specific locations at specific times (e.g., all NPCs gather at the fountain at noon).

### Add Player Inventory / Quests
Extend the `players` object in `server.js` with `{ inventory: [], quests: [] }` and add corresponding WebSocket message types.

### Add Chat Between Players
Add a `chat` message type in server.js that broadcasts to all connected players, and display it as floating text bubbles in the Phaser scene.

---

## 🏗 Architecture Overview

```
Browser (Phaser 3)
  │  WebSocket (JSON messages)
  ▼
Node.js Server (Express + ws)
  │  ├── Player position sync (broadcast to all)
  │  ├── NPC interaction handler
  │  └── Fetch to Anthropic API
  ▼
Claude API (claude-sonnet-4-20250514)
  │  Returns JSON: { reply, emotion, action }
  ▼
Server updates NPC memory → sends reply to player
```

---

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| `express` | Static file serving + HTTP server |
| `ws` | WebSocket server |
| `node-fetch` | HTTP requests to Claude API (Node 18+ has global fetch) |

Frontend: **Phaser 3** (loaded via CDN, no build step needed).

---

Built with ❤️ and pixel art. Have fun in Pixel Synapse!
