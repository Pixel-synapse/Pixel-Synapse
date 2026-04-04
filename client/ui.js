/**
 * ui.js — Pixel Synapse Phaser UI System
 *
 * Self-contained UI layer. Import and call UISystem.init(scene) once,
 * then use the public API anywhere in your game.
 *
 * Public API:
 *   UISystem.showDialogue(npc, text, emotion)
 *   UISystem.hideDialogue()
 *   UISystem.updateDialogueText(text, emotion)
 *   UISystem.showBubble(worldX, worldY, text, durationMs)
 *   UISystem.updateReputation(color, label)
 *   UISystem.showNotification(text, color, durationMs)
 *   UISystem.setThinking(on)
 *   UISystem.updateGameClock(timeLabel, isDark)
 *   UISystem.updateNpcBadge(npcId, state, label, color)
 *   UISystem.clearBadge(npcId)
 */

const UISystem = (() => {

  // ─────────────────────────────────────────────
  // INTERNAL STATE
  // ─────────────────────────────────────────────
  let _scene = null;   // Phaser scene reference
  let _cam   = null;   // main camera
  const _bubbles = []; // active chat bubbles
  const _badges  = {}; // npcId → { el, timer }
  let _dialogueNpc = null;

  // ─────────────────────────────────────────────
  // EMOTION CONFIG
  // ─────────────────────────────────────────────
  const EMOTION_COLORS = {
    happy:      '#44ff88',
    curious:    '#44aaff',
    nervous:    '#ffaa44',
    suspicious: '#ff4444',
    excited:    '#ffff44',
    sad:        '#4466aa',
    neutral:    '#556677',
    glitchy:    '#00ffcc',
    idle:       '#556677',
  };
  const EMOTION_ICONS = {
    happy: '◆', curious: '?', nervous: '~', suspicious: '!',
    excited: '★', sad: '▽', neutral: '●', glitchy: '✕', idle: '●',
  };

  // ─────────────────────────────────────────────
  // DOM HELPERS
  // ─────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function fadeIn(el, ms = 120) {
    el.style.transition = `opacity ${ms}ms ease-out, transform ${ms}ms ease-out`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.opacity  = '1';
      el.style.transform = el.dataset.openTransform || 'translateX(-50%) translateY(0)';
    }));
  }

  function fadeOut(el, ms = 120, cb) {
    el.style.transition = `opacity ${ms}ms ease-in, transform ${ms}ms ease-in`;
    el.style.opacity  = '0';
    el.style.transform = el.dataset.closeTransform || 'translateX(-50%) translateY(12px)';
    setTimeout(() => { el.style.display = 'none'; if (cb) cb(); }, ms + 10);
  }

  // Draw a mini NPC avatar onto a canvas element
  function drawAvatarCanvas(canvasEl, color) {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    const W = canvasEl.width, H = canvasEl.height;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0a0a1a'; ctx.fillRect(0,0,W,H);

    // Simple 2x-scaled NPC sprite (head + body)
    const S = 2;
    const p = (x,y,w,h,c) => { ctx.fillStyle = c; ctx.fillRect(x*S,y*S,w*S,h*S); };
    p(4,0,8,8,color);
    p(5,1,6,6,'#d4a574');
    p(5,3,2,2,'#0a0a0a'); p(9,3,2,2,'#0a0a0a'); // eyes
    p(5,3,1,1,'#fff');    p(9,3,1,1,'#fff');     // highlights
    p(2,8,12,5,color);
    p(0,8,2,4,color); p(14,8,2,4,color);
    p(3,13,3,3,'#aabbcc'); p(9,13,3,3,'#aabbcc');
    p(4,0,8,1,'#0a0a0a'); p(4,7,8,1,'#0a0a0a');
    p(4,0,1,8,'#0a0a0a'); p(11,0,1,8,'#0a0a0a');
    canvasEl.getContext('2d'); // noop, ensure refresh
  }

  // ─────────────────────────────────────────────
  // DIALOGUE BOX
  // ─────────────────────────────────────────────

  /**
   * Show the dialogue box for an NPC.
   * @param {object} npc    - { id, name, role, color }
   * @param {string} text   - opening text
   * @param {string} emotion
   */
  function showDialogue(npc, text, emotion = 'idle') {
    _dialogueNpc = npc;
    const overlay = $('dialogue-overlay');
    if (!overlay) return;

    $('dialogue-npc-name').textContent = (npc.name || 'NPC').toUpperCase();
    $('dialogue-role').textContent     = npc.role || '';
    drawAvatarCanvas($('dialogue-avatar'), npc.color || '#888888');
    updateDialogueText(text, emotion);

    overlay.style.display = 'block';
    overlay.style.opacity = '0';
    overlay.style.transform = 'translateY(100%)';
    overlay.dataset.openTransform  = 'translateY(0)';
    overlay.dataset.closeTransform = 'translateY(100%)';
    fadeIn(overlay, 130);
  }

  function hideDialogue() {
    const overlay = $('dialogue-overlay');
    if (!overlay || overlay.style.display === 'none') return;
    fadeOut(overlay, 130, () => {
      overlay.classList.remove('open');
    });
    _dialogueNpc = null;
    setThinking(false);
  }

  /**
   * Update the text and emotion in an already-open dialogue box.
   */
  function updateDialogueText(text, emotion = 'neutral') {
    const el = $('dialogue-text');
    if (el) {
      // Typewriter effect — clears and writes character by character
      el.textContent = '';
      typewriterWrite(el, text, 18);
    }
    _setEmotionUI(emotion);
  }

  function typewriterWrite(el, text, msPerChar = 22) {
    let i = 0;
    clearInterval(el._tw);
    el._tw = setInterval(() => {
      el.textContent += text[i++] || '';
      if (i >= text.length) clearInterval(el._tw);
    }, msPerChar);
  }

  function _setEmotionUI(emotion) {
    const em  = (emotion || 'neutral').toLowerCase();
    const col = EMOTION_COLORS[em] || EMOTION_COLORS.neutral;
    const ico = EMOTION_ICONS[em]  || '●';

    const dot = $('dialogue-emotion-dot');
    const lbl = $('dialogue-emotion-label');
    if (dot) { dot.style.background = col; dot.style.boxShadow = `0 0 6px ${col}66`; }
    if (lbl) { lbl.textContent = `${ico} ${em.toUpperCase()}`; lbl.style.color = col; }
  }

  // ─────────────────────────────────────────────
  // CHAT BUBBLES
  // World-space HTML divs synced to camera each frame.
  // ─────────────────────────────────────────────

  /**
   * Show a chat bubble above a world position.
   * @param {number} worldX
   * @param {number} worldY
   * @param {string} text
   * @param {number} durationMs
   * @param {string} [color]   border/text accent color
   */
  function showBubble(worldX, worldY, text, durationMs = 2800, color = '#3344aa') {
    const layer = $('bubble-layer');
    if (!layer) return;

    // Remove any bubble already at this position
    _bubbles
      .filter(b => Math.abs(b.wx - worldX) < 24 && Math.abs(b.wy - worldY) < 24)
      .forEach(b => { b.el.remove(); });

    const el = document.createElement('div');
    el.className = 'chat-bubble';
    el.style.cssText = [
      'position:absolute',
      'background:#0f0f22',
      `border:1px solid ${color}`,
      'padding:4px 8px',
      "font-family:'VT323',monospace",
      'font-size:17px',
      'color:#ccdde8',
      'white-space:nowrap',
      'pointer-events:none',
      'z-index:80',
      'opacity:0',
      'transition:opacity 0.15s ease-out',
    ].join(';');
    el.textContent = text;

    // Tail triangle
    const tail = document.createElement('div');
    tail.style.cssText = [
      'position:absolute',
      'bottom:-5px',
      'left:50%',
      'transform:translateX(-50%)',
      'width:0',
      'height:0',
      `border-left:4px solid transparent`,
      `border-right:4px solid transparent`,
      `border-top:5px solid ${color}`,
    ].join(';');
    el.appendChild(tail);
    layer.appendChild(el);

    // Fade in
    requestAnimationFrame(() => { el.style.opacity = '1'; });

    const entry = { el, wx: worldX, wy: worldY };
    _bubbles.push(entry);

    // Auto-dismiss
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s ease-in';
      el.style.opacity = '0';
      setTimeout(() => {
        el.remove();
        const idx = _bubbles.indexOf(entry);
        if (idx !== -1) _bubbles.splice(idx, 1);
      }, 320);
    }, durationMs);

    return entry;
  }

  /**
   * Call this every frame (from Phaser update) to sync bubble positions.
   */
  function syncBubbles(cam) {
    if (!cam) return;
    for (const b of _bubbles) {
      const sx = (b.wx - cam.scrollX) - (b.el.offsetWidth  / 2);
      const sy = (b.wy - cam.scrollY) - (b.el.offsetHeight + 28);
      b.el.style.left = Math.round(sx) + 'px';
      b.el.style.top  = Math.round(sy) + 'px';
    }
  }

  // ─────────────────────────────────────────────
  // REPUTATION INDICATOR
  // Small icon above the player in world-space,
  // plus the HUD label + axis bars.
  // ─────────────────────────────────────────────

  /**
   * Update reputation display.
   * @param {string} color   hex color (green/red/yellow etc.)
   * @param {string} label   e.g. 'FRIENDLY'
   * @param {object} [axes]  { kindness, trust, chaos } 0-100 or -100-100
   */
  function updateReputation(color, label, axes) {
    // HUD label
    const lbl = $('rep-label');
    if (lbl) { lbl.textContent = label || ''; lbl.style.color = color || '#888780'; }

    // Axis bars
    if (axes) {
      _setBar('bar-kindness', Math.round(((axes.kindness ?? 0)+100)/2), axes.kindness >= 0 ? '#44ff88' : '#ff4444');
      _setBar('bar-trust',    Math.round(((axes.trust    ?? 0)+100)/2), axes.trust    >= 0 ? '#44aaff' : '#ff8844');
      _setBar('bar-chaos',    Math.round(axes.chaos ?? 0),              (axes.chaos??0) > 60 ? '#ff4444' : '#ffcc44');
    }

    // World-space reputation dot above player sprite — redraw with new color
    if (_scene && _scene.myRepDot) {
      const col = parseInt((color || '#888780').replace('#',''), 16);
      _scene.myRepDot.clear();
      _scene.myRepDot.fillStyle(col, 1);
      _scene.myRepDot.fillCircle(0, 0, 3);
    }
  }

  function _setBar(id, pct, col) {
    const el = $(id);
    if (el) { el.style.width = Math.round(pct) + '%'; el.style.background = col; }
  }

  // ─────────────────────────────────────────────
  // NPC BADGES (name + state label)
  // ─────────────────────────────────────────────

  function createNpcBadge(npc) {
    const layer = $('bubble-layer');
    if (!layer || _badges[npc.id]) return;

    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'position:absolute',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:2px',
      'pointer-events:none',
      'z-index:60',
      'transform:translate(-50%,-100%)',
    ].join(';');

    const nameEl = document.createElement('div');
    nameEl.style.cssText = [
      "font-family:'Press Start 2P',monospace",
      'font-size:5px',
      `color:${npc.color || '#aabbff'}`,
      'background:#0f0f22',
      'border:1px solid #3344aa',
      'padding:2px 5px',
      'white-space:nowrap',
      'letter-spacing:1px',
    ].join(';');
    nameEl.textContent = (npc.name || '').toUpperCase();

    const stateEl = document.createElement('div');
    stateEl.style.cssText = [
      "font-family:'VT323',monospace",
      'font-size:13px',
      `color:#556677`,
      'border:1px solid #33445566',
      'padding:1px 5px',
      'white-space:nowrap',
      'transition:color 0.3s, border-color 0.3s',
    ].join(';');
    stateEl.textContent = '● IDLE';

    wrap.appendChild(nameEl);
    wrap.appendChild(stateEl);
    layer.appendChild(wrap);
    _badges[npc.id] = { wrap, nameEl, stateEl, _timer: null };
  }

  const STATE_COLORS = { idle: '#888780', walking: '#44aaff', talking: '#44ff88' };
  const STATE_ICONS  = { idle: '● IDLE',  walking: '▸ WALK',  talking: '◆ TALK' };

  function updateNpcBadge(npcId, state, label, emotionColor) {
    const badge = _badges[npcId];
    if (!badge) return;
    if (badge._emotionTimer) return; // emotion overrides state briefly

    const s   = (state || 'idle').toLowerCase();
    const col = emotionColor || STATE_COLORS[s] || STATE_COLORS.idle;
    const ico = STATE_ICONS[s] || STATE_ICONS.idle;

    badge.stateEl.textContent           = ico;
    badge.stateEl.style.color           = col;
    badge.stateEl.style.borderColor     = col + '66';
    if (label) badge.wrap.title         = label;
  }

  function showNpcEmotion(npcId, emotion) {
    const badge = _badges[npcId];
    if (!badge) return;
    const em  = (emotion || 'idle').toLowerCase();
    const col = EMOTION_COLORS[em] || EMOTION_COLORS.idle;
    const ico = EMOTION_ICONS[em]  || '●';

    badge.stateEl.textContent       = `${ico} ${em.toUpperCase()}`;
    badge.stateEl.style.color       = col;
    badge.stateEl.style.borderColor = col + '66';

    clearTimeout(badge._emotionTimer);
    badge._emotionTimer = setTimeout(() => {
      badge._emotionTimer = null;
      badge.stateEl.textContent       = STATE_ICONS.idle;
      badge.stateEl.style.color       = STATE_COLORS.idle;
      badge.stateEl.style.borderColor = STATE_COLORS.idle + '66';
    }, 5000);
  }

  function syncBadges(cam) {
    if (!cam) return;
    // Find all NPC sprites via gameState (passed from outside on each frame call)
    for (const [npcId, badge] of Object.entries(_badges)) {
      if (!badge._spriteRef) continue;
      const sx = (badge._spriteRef.x - cam.scrollX);
      const sy = (badge._spriteRef.y - cam.scrollY) - 22;
      badge.wrap.style.left = Math.round(sx) + 'px';
      badge.wrap.style.top  = Math.round(sy) + 'px';
    }
  }

  function bindNpcSprite(npcId, sprite) {
    if (_badges[npcId]) _badges[npcId]._spriteRef = sprite;
  }

  function clearBadge(npcId) {
    const badge = _badges[npcId];
    if (badge) { badge.wrap.remove(); delete _badges[npcId]; }
  }

  // ─────────────────────────────────────────────
  // NOTIFICATION (toast)
  // ─────────────────────────────────────────────

  /**
   * @param {string} text
   * @param {string} [color]    text accent color
   * @param {number} [duration]
   */
  function showNotification(text, color = '#8899cc', duration = 2200) {
    const el = $('toast');
    if (!el) return;
    el.textContent  = '▸ ' + text;
    el.style.color  = color;
    el.style.display = 'block';
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.transition = 'opacity 0.3s';
      el.style.opacity = '0';
      setTimeout(() => { el.style.display = 'none'; el.style.opacity = '1'; }, 320);
    }, duration);
  }

  // ─────────────────────────────────────────────
  // THINKING INDICATOR
  // ─────────────────────────────────────────────
  function setThinking(on) {
    const el = $('thinking');
    if (el) el.style.display = on ? 'block' : 'none';
  }

  // ─────────────────────────────────────────────
  // GAME CLOCK
  // ─────────────────────────────────────────────
  function updateGameClock(label, isDark) {
    const el = $('hud-clock');
    if (!el) return;
    el.textContent = `${isDark ? '☽' : '☀'} ${label}`;
    el.style.color = isDark ? '#aabbff' : '#ffcc44';
  }

  // ─────────────────────────────────────────────
  // PHASER WORLD-SPACE REP DOT
  // A small colored circle above the player sprite
  // ─────────────────────────────────────────────
  function _createRepDot(scene, sprite) {
    const g = scene.add.graphics();
    g.fillStyle(0x888780, 1);
    g.fillCircle(0, 0, 3);
    g.setDepth(12);
    scene.myRepDot = g;
    return g;
  }

  function syncRepDot(scene) {
    if (!scene || !scene.myRepDot) return;
    // Access the global gameState defined in main.js
    const sp = (typeof gameState !== 'undefined') ? gameState.mySprite : null;
    if (sp) scene.myRepDot.setPosition(sp.x, sp.y - 14);
  }

  // ─────────────────────────────────────────────
  // EVENT BANNER
  // ─────────────────────────────────────────────
  function showEventBanner(label, description) {
    const el = $('event-banner');
    if (!el) return;
    if (!label) { el.style.display = 'none'; return; }
    el.textContent = `▸ ${label}`;
    if (description) el.title = description;
    el.style.display = 'block';
    el.style.opacity = '0';
    requestAnimationFrame(() => {
      el.style.transition = 'opacity 0.3s';
      el.style.opacity = '1';
    });
  }

  function hideEventBanner() {
    const el = $('event-banner');
    if (!el) return;
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(() => { el.style.display = 'none'; }, 320);
  }

  // ─────────────────────────────────────────────
  // SECRET REVEAL OVERLAY
  // Full-screen dramatic moment for secret reveals
  // ─────────────────────────────────────────────
  function showSecretReveal(npcName, npcColor, secretText, onClose) {
    // Remove any existing reveal overlay
    const existing = document.getElementById('secret-reveal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'secret-reveal-overlay';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'background:#00000099',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'z-index:1200',       // above all other overlays
      'opacity:0',
      'transition:opacity 0.4s',
      'cursor:pointer',
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'background:#080810',
      `border:2px solid ${npcColor || '#3344aa'}`,
      'padding:24px 32px',
      'max-width:440px',
      'width:min(440px,90vw)',
      'text-align:center',
      'position:relative',
    ].join(';');

    // Close button top-right
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = [
      'position:absolute', 'top:8px', 'right:12px',
      'background:none', 'border:none',
      'color:#556677', 'cursor:pointer',
      "font-family:'Press Start 2P',monospace",
      'font-size:8px',
    ].join(';');
    closeBtn.onclick = (e) => { e.stopPropagation(); doClose(); };

    const header = document.createElement('div');
    header.style.cssText = "font-family:'Press Start 2P',monospace;font-size:7px;color:" + (npcColor||'#aabbff') + ";letter-spacing:2px;margin-bottom:12px;";
    header.textContent = `${npcName?.toUpperCase()} REVEALS`;

    const icon = document.createElement('div');
    icon.style.cssText = "font-family:'VT323',monospace;font-size:28px;color:#ffcc44;margin-bottom:12px;";
    icon.textContent = '✦ SECRET ✦';

    const text = document.createElement('div');
    text.style.cssText = "font-family:'VT323',monospace;font-size:20px;color:#ccdde8;line-height:1.5;margin-bottom:16px;";
    text.textContent = secretText;

    const hint = document.createElement('div');
    hint.style.cssText = "font-family:'Press Start 2P',monospace;font-size:5px;color:#445566;letter-spacing:1px;";
    hint.textContent = '[ click anywhere · ESC · or ✕ to close ]';

    card.appendChild(closeBtn);
    card.appendChild(header);
    card.appendChild(icon);
    card.appendChild(text);
    card.appendChild(hint);
    overlay.appendChild(card);
    // Append to body (not bubble-layer) so pointer-events work
    document.body.appendChild(overlay);

    requestAnimationFrame(() => { overlay.style.opacity = '1'; });

    function doClose() {
      overlay.style.opacity = '0';
      document.removeEventListener('keydown', onKey);
      setTimeout(() => { overlay.remove(); if (onClose) onClose(); }, 420);
    }

    // Click backdrop to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) doClose();
    });

    // ESC key to close
    function onKey(e) {
      if (e.key === 'Escape') doClose();
    }
    document.addEventListener('keydown', onKey);
  }

  // ─────────────────────────────────────────────
  // INIT
  // Call once after Phaser scene is created.
  // ─────────────────────────────────────────────
  function init(scene) {
    _scene = scene;
    _cam   = scene.cameras?.main || null;
    // Create the rep dot — mySprite lives on the global gameState
    const sp = (typeof gameState !== 'undefined') ? gameState.mySprite : null;
    if (sp) _createRepDot(scene, sp);
  }

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────
  return {
    init,
    // Dialogue
    showDialogue,
    hideDialogue,
    updateDialogueText,
    // Bubbles
    showBubble,
    syncBubbles,
    // Reputation
    updateReputation,
    // NPC badges
    createNpcBadge,
    updateNpcBadge,
    showNpcEmotion,
    syncBadges,
    bindNpcSprite,
    clearBadge,
    // Misc
    showNotification,
    setThinking,
    updateGameClock,
    syncRepDot,
    // Events
    showEventBanner,
    hideEventBanner,
    showSecretReveal,
    // Internal helpers exposed for integration
    EMOTION_COLORS,
  };

})();

// Export for Node-style environments (ignored in browser)
if (typeof module !== 'undefined') module.exports = UISystem;
