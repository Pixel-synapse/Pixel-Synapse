/**
 * Pixel Synapse — Multiplayer Prototype
 * Phaser 3 + Socket.io
 *
 * Architecture:
 *   GameScene  — main Phaser scene
 *   Socket.io  — real-time sync
 *
 * Players:
 *   myPlayer      — local player (green square + name tag)
 *   otherPlayers  — map of id → { sprite, nameTag, bubble }
 */

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const WORLD_W     = 800;
const WORLD_H     = 600;
const PLAYER_SIZE = 14;
const SPEED       = 180;
const SEND_RATE   = 40;   // ms between position broadcasts (~25 fps)
const LERP        = 0.18; // interpolation for remote players

// ─────────────────────────────────────────────
// SOCKET — connect before Phaser boots
// ─────────────────────────────────────────────
const socket = io('http://localhost:3000');

socket.on('connect', () => {
  document.getElementById('status').textContent = `Connected · ${socket.id.slice(0,8)}…`;
});
socket.on('disconnect', () => {
  document.getElementById('status').textContent = 'Disconnected — refresh to reconnect';
  document.getElementById('status').style.color = '#ff4444';
});

// ─────────────────────────────────────────────
// PHASER SCENE
// ─────────────────────────────────────────────
class GameScene extends Phaser.Scene {
  constructor() { super({ key: 'GameScene' }); }

  // ── preload ─────────────────────────────────
  preload() {
    // Generate all player textures procedurally
    // (no image assets needed)
  }

  // ── create ──────────────────────────────────
  create() {
    // ── World background ──
    this._buildWorld();

    // ── Input ──
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd    = this.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });

    // ── Local player (created on currentPlayers) ──
    this.myPlayer    = null;
    this.myId        = null;
    this.otherPlayers= {};
    this._lastSend   = 0;
    this._chatBubbles= {};  // id → { text, timer }

    // ── Socket event handlers ──
    this._bindSocket();

    // ── Chat UI ──
    this._bindChat();
  }

  // ── World map ───────────────────────────────
  _buildWorld() {
    const gfx = this.add.graphics();

    // Ground — dark tile grid
    gfx.fillStyle(0x08080f);
    gfx.fillRect(0, 0, WORLD_W, WORLD_H);

    // Subtle tile grid
    gfx.lineStyle(1, 0x0e0e20, 0.6);
    for (let x = 0; x <= WORLD_W; x += 32) gfx.lineBetween(x, 0, x, WORLD_H);
    for (let y = 0; y <= WORLD_H; y += 32) gfx.lineBetween(0, y, WORLD_W, y);

    // Town square — centre cobble patch
    gfx.fillStyle(0x161420);
    gfx.fillRect(280, 200, 240, 200);
    gfx.lineStyle(1, 0x2a2840);
    gfx.strokeRect(280, 200, 240, 200);

    // Fountain
    gfx.fillStyle(0x1a2a3a);
    gfx.fillCircle(400, 300, 28);
    gfx.fillStyle(0x88ccff, 0.4);
    gfx.fillCircle(400, 300, 18);

    // Corner zones — tinted blocks
    const zones = [
      { x: 10,  y: 10,  w: 120, h: 90,  col: 0x181824, lbl: 'WORKSHOP'  },
      { x: 10,  y: 500, w: 100, h: 90,  col: 0x18180d, lbl: 'CAFÉ'      },
      { x: 670, y: 10,  w: 120, h: 90,  col: 0x141a14, lbl: 'MARKET'    },
      { x: 670, y: 500, w: 120, h: 90,  col: 0x1a1418, lbl: 'TOWN HALL' },
    ];
    zones.forEach(z => {
      gfx.fillStyle(z.col);
      gfx.fillRect(z.x, z.y, z.w, z.h);
      gfx.lineStyle(1, 0x2a2840);
      gfx.strokeRect(z.x, z.y, z.w, z.h);
      this.add.text(z.x + z.w/2, z.y + z.h/2, z.lbl, {
        fontSize: '8px', fontFamily: 'Courier New',
        color: '#2a2840', align: 'center',
      }).setOrigin(0.5);
    });

    // Road cross
    gfx.fillStyle(0x111118, 0.8);
    gfx.fillRect(0, WORLD_H/2 - 16, WORLD_W, 32);
    gfx.fillRect(WORLD_W/2 - 16, 0, 32, WORLD_H);

    // Road markings
    gfx.lineStyle(1, 0x2a2840, 0.5);
    gfx.lineBetween(0, WORLD_H/2, WORLD_W, WORLD_H/2);
    gfx.lineBetween(WORLD_W/2, 0, WORLD_W/2, WORLD_H);

    // Title
    this.add.text(WORLD_W/2, WORLD_H/2 - 50, 'PIXEL SYNAPSE', {
      fontSize: '11px', fontFamily: 'Courier New',
      color: '#1a1a2a', letterSpacing: 4,
    }).setOrigin(0.5);
  }

  // ── Create one player sprite ─────────────────
  _makeSprite(x, y, color, isMe) {
    const col = Phaser.Display.Color.HexStringToColor(color).color;

    // Square body
    const gfx = this.add.graphics();
    gfx.fillStyle(col, 1);
    gfx.fillRect(-PLAYER_SIZE/2, -PLAYER_SIZE/2, PLAYER_SIZE, PLAYER_SIZE);
    // Inner highlight
    gfx.fillStyle(0xffffff, 0.15);
    gfx.fillRect(-PLAYER_SIZE/2 + 2, -PLAYER_SIZE/2 + 2, PLAYER_SIZE - 4, 4);
    // Border
    gfx.lineStyle(isMe ? 2 : 1, isMe ? 0xffffff : col, isMe ? 0.9 : 0.5);
    gfx.strokeRect(-PLAYER_SIZE/2, -PLAYER_SIZE/2, PLAYER_SIZE, PLAYER_SIZE);

    // Convert to texture so physics can use it
    const key = `player_${Date.now()}_${Math.random()}`;
    gfx.generateTexture(key, PLAYER_SIZE + 4, PLAYER_SIZE + 4);
    gfx.destroy();

    const sprite = this.physics.add.sprite(x, y, key);
    sprite.setCollideWorldBounds(true);
    sprite.setDepth(10);
    return sprite;
  }

  _makeNameTag(sprite, name, color, isMe) {
    const tag = this.add.text(sprite.x, sprite.y - PLAYER_SIZE - 5, name, {
      fontSize: '9px', fontFamily: 'Courier New',
      color: isMe ? '#ffffff' : color,
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5, 1).setDepth(11);
    return tag;
  }

  _makeChatBubble(sprite, text) {
    const bub = this.add.text(sprite.x, sprite.y - PLAYER_SIZE - 22, text, {
      fontSize: '9px', fontFamily: 'Courier New',
      color: '#ccdde8',
      backgroundColor: '#0a0a14',
      padding: { x: 5, y: 3 },
      stroke: '#1a1a2a', strokeThickness: 1,
    }).setOrigin(0.5, 1).setDepth(12);
    return bub;
  }

  // ── Socket bindings ──────────────────────────
  _bindSocket() {
    // ── Receive full world state on join ──
    socket.on('currentPlayers', (players) => {
      Object.values(players).forEach(p => {
        if (p.id === socket.id) {
          // This is me
          this.myId = p.id;
          this.myPlayer = this._makeSprite(p.x, p.y, '#44ff88', true);
          this.myNameTag = this._makeNameTag(this.myPlayer, p.name + ' (you)', '#44ff88', true);
          this._updateOnlineCount(Object.keys(players).length);
        } else {
          this._addOtherPlayer(p);
        }
      });
    });

    // ── New player joined ──
    socket.on('newPlayer', (p) => {
      this._addOtherPlayer(p);
      this._updateOnlineCount(Object.keys(this.otherPlayers).length + 1);
      this._systemMessage(`${p.name} joined`);
    });

    // ── Remote player moved ──
    socket.on('playerMoved', (data) => {
      const op = this.otherPlayers[data.id];
      if (!op) return;
      // Store target position; update() will interpolate toward it
      op.targetX = data.x;
      op.targetY = data.y;
    });

    // ── Player left ──
    socket.on('playerDisconnected', (id) => {
      const op = this.otherPlayers[id];
      if (!op) return;
      const name = op.name || id.slice(0, 6);
      op.sprite?.destroy();
      op.nameTag?.destroy();
      op.bubble?.destroy();
      delete this.otherPlayers[id];
      this._updateOnlineCount(Object.keys(this.otherPlayers).length + 1);
      this._systemMessage(`${name} left`);
    });

    // ── Chat message ──
    socket.on('chatMessage', ({ id, name, text }) => {
      this._addChatLog(name, text, id === socket.id);

      // Show bubble above the right player
      if (id === socket.id) {
        this._showBubble('me', this.myPlayer, text);
      } else {
        const op = this.otherPlayers[id];
        if (op) this._showBubble(id, op.sprite, text);
      }
    });
  }

  _addOtherPlayer(p) {
    const sprite  = this._makeSprite(p.x, p.y, p.color || '#4fc3f7', false);
    const nameTag = this._makeNameTag(sprite, p.name, p.color || '#4fc3f7', false);
    this.otherPlayers[p.id] = {
      sprite, nameTag,
      bubble:  null,
      targetX: p.x,
      targetY: p.y,
      name:    p.name,
      color:   p.color,
    };
  }

  // ── Chat bubble above player ─────────────────
  _showBubble(id, sprite, text) {
    if (!sprite) return;

    // Clear old bubble for this player
    const existing = id === 'me' ? this._myBubble : this.otherPlayers[id]?.bubble;
    if (existing) existing.destroy();

    const bub = this._makeChatBubble(sprite, text);
    if (id === 'me') this._myBubble = bub;
    else if (this.otherPlayers[id]) this.otherPlayers[id].bubble = bub;

    // Auto-remove after 4 s
    this.time.delayedCall(4000, () => {
      bub.destroy();
      if (id === 'me' && this._myBubble === bub) this._myBubble = null;
      else if (this.otherPlayers[id]?.bubble === bub) this.otherPlayers[id].bubble = null;
    });
  }

  // ── Chat UI bindings ─────────────────────────
  _bindChat() {
    const input = document.getElementById('chat-input');
    const send  = () => {
      const text = input.value.trim();
      if (!text) return;
      socket.emit('chatMessage', text);
      input.value = '';
    };
    document.getElementById('chat-send').addEventListener('click', send);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
      // Stop WASD/arrows from moving player while typing
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d']
          .includes(e.key)) e.stopPropagation();
    });
    // Press Enter anywhere (not in input) to focus chat
    window.addEventListener('keydown', e => {
      if (e.key === 'Enter' && document.activeElement !== input) {
        e.preventDefault();
        input.focus();
      }
    });
  }

  _addChatLog(name, text, isMe) {
    const log = document.getElementById('chat-log');
    const line = document.createElement('div');
    line.innerHTML = `<span class="msg-name" style="color:${isMe ? '#44ff88' : '#4fc3f7'};">${name}:</span> <span class="msg-text">${text}</span>`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  _systemMessage(text) {
    const log = document.getElementById('chat-log');
    const line = document.createElement('div');
    line.style.cssText = 'color:#334;font-size:9px;font-style:italic;';
    line.textContent = `· ${text}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  _updateOnlineCount(n) {
    document.getElementById('player-count').textContent = `● ${n} online`;
  }

  // ── update loop ──────────────────────────────
  update(time) {
    if (!this.myPlayer) return;

    const chatFocused = document.activeElement === document.getElementById('chat-input');

    // ── Local movement ──
    let vx = 0, vy = 0;
    if (!chatFocused) {
      const L = this.cursors.left.isDown  || this.wasd.left.isDown;
      const R = this.cursors.right.isDown || this.wasd.right.isDown;
      const U = this.cursors.up.isDown    || this.wasd.up.isDown;
      const D = this.cursors.down.isDown  || this.wasd.down.isDown;
      if (L) vx = -SPEED;
      if (R) vx =  SPEED;
      if (U) vy = -SPEED;
      if (D) vy =  SPEED;
      // Diagonal normalise
      if (vx && vy) { vx *= 0.707; vy *= 0.707; }
    }
    this.myPlayer.setVelocity(vx, vy);

    // ── Name tag + bubble follow ──
    const sp = this.myPlayer;
    this.myNameTag?.setPosition(sp.x, sp.y - PLAYER_SIZE - 5);
    this._myBubble?.setPosition(sp.x, sp.y - PLAYER_SIZE - 22);

    // ── Emit position at SEND_RATE ──
    if (time - this._lastSend > SEND_RATE && (vx || vy)) {
      socket.emit('playerMovement', { x: Math.round(sp.x), y: Math.round(sp.y) });
      this._lastSend = time;
    }

    // ── Interpolate other players ──
    for (const [, op] of Object.entries(this.otherPlayers)) {
      if (!op.sprite || op.targetX === undefined) continue;
      op.sprite.x = Phaser.Math.Linear(op.sprite.x, op.targetX, LERP);
      op.sprite.y = Phaser.Math.Linear(op.sprite.y, op.targetY, LERP);
      op.nameTag?.setPosition(op.sprite.x, op.sprite.y - PLAYER_SIZE - 5);
      op.bubble?.setPosition(op.sprite.x, op.sprite.y - PLAYER_SIZE - 22);
    }
  }
}

// ─────────────────────────────────────────────
// PHASER GAME CONFIG
// ─────────────────────────────────────────────
const config = {
  type:   Phaser.AUTO,
  width:  WORLD_W,
  height: WORLD_H,
  parent: 'game',
  backgroundColor: '#08080f',
  pixelArt: true,
  roundPixels: true,
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 }, debug: false },
  },
  scene: [GameScene],
};

new Phaser.Game(config);
