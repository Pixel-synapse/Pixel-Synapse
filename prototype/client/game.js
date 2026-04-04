/**
 * Pixel Synapse Multiplayer Prototype
 * Pure canvas — no framework needed.
 */

const canvas = document.getElementById('game');
const ctx    = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

// ── Socket ──
const socket = io('http://localhost:3000');

// ── State ──
let me = null;
const others = {};
const SPEED = 160, PSIZE = 14, SEND_MS = 50;
let lastSend = 0, lastTime = performance.now();

// ── Input ──
const keys = {};
window.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.code === 'Enter' && document.activeElement !== chatInput) { chatInput.focus(); e.preventDefault(); }
});
window.addEventListener('keyup', e => keys[e.code] = false);

// ── Chat ──
const chatInput = document.getElementById('chat-input');
const chatLog   = document.getElementById('chat-log');

function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat', msg);
  chatInput.value = '';
  chatInput.blur();
}
chatInput.addEventListener('keydown', e => {
  if (e.code === 'Enter')  { sendChat(); e.preventDefault(); }
  if (e.code === 'Escape') chatInput.blur();
  e.stopPropagation();
});
document.getElementById('chat-send').addEventListener('click', sendChat);

function logLine(name, msg, color) {
  const d = document.createElement('div');
  d.className = 'chat-line';
  d.innerHTML = `<span style="color:${color||'#aabbff'}">${name}:</span> ${msg}`;
  chatLog.appendChild(d);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ── Socket events ──
socket.on('init', ({ self, players }) => {
  me = { ...self, tx: self.x, ty: self.y, chat:'', chatTimer:0 };
  document.getElementById('ui-name').textContent = `▸ ${self.name}`;
  document.getElementById('ui-name').style.color = self.color;
  players.forEach(p => others[p.id] = {...p, tx:p.x, ty:p.y, chat:'', chatTimer:0});
  updateCount();
  logLine('System', `You joined as ${self.name}`, '#556677');
});
socket.on('playerJoined', p => {
  others[p.id] = {...p, tx:p.x, ty:p.y, chat:'', chatTimer:0};
  updateCount();
  logLine('System', `${p.name} joined`, '#445566');
});
socket.on('playerMoved', ({id,x,y}) => {
  if (others[id]) { others[id].tx = x; others[id].ty = y; }
});
socket.on('playerChat', ({id,name,msg}) => {
  const t = id === socket.id ? me : others[id];
  if (t) { t.chat = msg; t.chatTimer = 4000; }
  logLine(name, msg, t?.color||'#aabbff');
});
socket.on('playerLeft', id => {
  const name = others[id]?.name || 'Someone';
  delete others[id];
  updateCount();
  logLine('System', `${name} left`, '#445566');
});
socket.on('connect_error', () => logLine('Error', 'Cannot reach server', '#ff4444'));

function updateCount() {
  const n = Object.keys(others).length + (me ? 1 : 0);
  document.getElementById('ui-count').textContent = `● ${n} online`;
}

// ── World ──
function drawWorld() {
  // Grass
  ctx.fillStyle = '#0d1a0a'; ctx.fillRect(0,0,W,H);
  // Grid
  ctx.strokeStyle = '#0a150a'; ctx.lineWidth = 1;
  for (let x=0;x<W;x+=32){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for (let y=0;y<H;y+=32){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
  // Roads
  ctx.fillStyle='#1e1c18';
  ctx.fillRect(0, H/2-20, W, 40);
  ctx.fillRect(W/2-20, 0, 40, H);
  ctx.fillStyle='#2a2820';
  ctx.fillRect(0, H/2-1, W, 2);
  ctx.fillRect(W/2-1, 0, 2, H);
  // Town square
  ctx.fillStyle='#2a2820'; ctx.fillRect(W/2-80,H/2-80,160,160);
  ctx.strokeStyle='#3a3530'; ctx.lineWidth=1; ctx.strokeRect(W/2-80,H/2-80,160,160);
  // Fountain
  ctx.fillStyle='#1a2a3a'; ctx.beginPath(); ctx.arc(W/2,H/2,28,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#88ccff'; ctx.beginPath(); ctx.arc(W/2,H/2,18,0,Math.PI*2); ctx.fill();
  // Buildings
  [[30,30],[650,30],[30,480],[650,480]].forEach(([bx,by])=>{
    ctx.fillStyle='#181824'; ctx.fillRect(bx,by,120,90);
    ctx.fillStyle='#100f1a'; ctx.fillRect(bx,by,120,18);
    ctx.strokeStyle='#2a2a3a'; ctx.lineWidth=1; ctx.strokeRect(bx,by,120,90);
    for(let i=0;i<3;i++){ctx.fillStyle='#33334444';ctx.fillRect(bx+14+i*36,by+28,22,16);}
    ctx.fillStyle='#0a0808'; ctx.fillRect(bx+50,by+66,20,24);
  });
  // Portal
  const ph = 0.5+Math.sin(performance.now()/400)*0.3;
  ctx.fillStyle=`rgba(170,102,255,${ph})`; ctx.strokeStyle='#aa66ff'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(W-30,H/2,18,0,Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.fillStyle='#fff'; ctx.font='10px monospace'; ctx.textAlign='center';
  ctx.fillText('⟡',W-30,H/2+4);
  ctx.fillStyle='#aa66ff88'; ctx.font='7px monospace';
  ctx.fillText('TRANSIT',W-30,H/2+18);
}

// ── Players ──
function drawPlayer(p, isMe) {
  const {x,y,color,name,chat,chatTimer} = p;
  const s = PSIZE;
  // Shadow
  ctx.fillStyle='rgba(0,0,0,0.3)'; ctx.fillRect(x-s+2,y-s+4,s*2,s*2);
  // Body
  ctx.fillStyle = isMe ? lighten(color,20) : color; ctx.fillRect(x-s,y-s,s*2,s*2);
  // Highlight
  ctx.fillStyle='rgba(255,255,255,0.18)'; ctx.fillRect(x-s+2,y-s+2,s*2-4,s-2);
  // Border
  ctx.strokeStyle = isMe ? '#fff' : 'rgba(255,255,255,0.5)'; ctx.lineWidth = isMe?2:1;
  ctx.strokeRect(x-s,y-s,s*2,s*2);
  // Name
  ctx.font='9px monospace'; ctx.textAlign='center';
  ctx.strokeStyle='#000'; ctx.lineWidth=3; ctx.strokeText(name,x,y-s-4);
  ctx.fillStyle=color; ctx.fillText(name,x,y-s-4);
  // YOU badge
  if(isMe){
    ctx.strokeText('YOU',x,y-s-14); ctx.fillStyle='#fff'; ctx.fillText('YOU',x,y-s-14);
  }
  // Chat bubble
  if(chat && chatTimer>0) drawBubble(x, y-s-8, chat, color);
}

function drawBubble(bx,by,text,color){
  ctx.font='10px monospace';
  const tw=ctx.measureText(text).width, bw=tw+12, bh=18;
  const rx=bx-bw/2, ry=by-bh-12;
  ctx.fillStyle='#0a0a18ee'; ctx.strokeStyle=color; ctx.lineWidth=1;
  roundRect(rx,ry,bw,bh,4); ctx.fill(); ctx.stroke();
  ctx.fillStyle='#ccdde8'; ctx.textAlign='center'; ctx.fillText(text,bx,ry+bh-5);
}

function roundRect(x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

function lighten(hex,a){
  const n=parseInt(hex.replace('#',''),16);
  return `rgb(${Math.min(255,(n>>16)+a)},${Math.min(255,((n>>8)&255)+a)},${Math.min(255,(n&255)+a)})`;
}

// ── Minimap ──
const MMS=100, MMX=W-MMS-8, MMY=8, MMSX=MMS/W, MMSY=MMS/H;
function drawMinimap(){
  ctx.fillStyle='#04040ccc'; ctx.strokeStyle='#1a1a3a'; ctx.lineWidth=1;
  ctx.fillRect(MMX,MMY,MMS,MMS); ctx.strokeRect(MMX,MMY,MMS,MMS);
  ctx.fillStyle='#1e1c18';
  ctx.fillRect(MMX,MMY+MMS/2-2,MMS,4); ctx.fillRect(MMX+MMS/2-2,MMY,4,MMS);
  // Portal dot
  const ph=0.5+Math.sin(performance.now()/400)*0.3;
  ctx.fillStyle=`rgba(170,102,255,${ph})`; ctx.fillRect(MMX+MMS-5,MMY+MMS/2-2,4,4);
  // Others
  for(const p of Object.values(others)){
    ctx.fillStyle=p.color; ctx.fillRect(MMX+p.x*MMSX-2,MMY+p.y*MMSY-2,4,4);
  }
  // Self
  if(me){
    ctx.fillStyle='#fff'; ctx.strokeStyle='#000'; ctx.lineWidth=1;
    ctx.fillRect(MMX+me.x*MMSX-3,MMY+me.y*MMSY-3,6,6);
    ctx.strokeRect(MMX+me.x*MMSX-3,MMY+me.y*MMSY-3,6,6);
  }
  ctx.fillStyle='#334455'; ctx.font='7px monospace'; ctx.textAlign='left';
  ctx.fillText('MAP',MMX+3,MMY+MMS-3);
}

// ── Loop ──
function lerp(a,b,t){ return a+(b-a)*t; }

function loop(now){
  const dt = Math.min((now-lastTime)/1000,0.05);
  lastTime = now;

  if(me && document.activeElement!==chatInput){
    let dx=0,dy=0;
    if(keys.ArrowLeft||keys.KeyA)  dx-=1;
    if(keys.ArrowRight||keys.KeyD) dx+=1;
    if(keys.ArrowUp||keys.KeyW)    dy-=1;
    if(keys.ArrowDown||keys.KeyS)  dy+=1;
    if(dx&&dy){dx*=0.707;dy*=0.707;}
    me.x=Math.max(PSIZE,Math.min(W-PSIZE,me.x+dx*SPEED*dt));
    me.y=Math.max(PSIZE,Math.min(H-PSIZE,me.y+dy*SPEED*dt));
    if(now-lastSend>SEND_MS){ socket.emit('move',{x:me.x,y:me.y}); lastSend=now; }
  }

  // Interpolate others
  for(const p of Object.values(others)){
    p.x=lerp(p.x,p.tx,0.22); p.y=lerp(p.y,p.ty,0.22);
    if(p.chatTimer>0) p.chatTimer-=dt*1000;
  }
  if(me&&me.chatTimer>0) me.chatTimer-=dt*1000;

  // Render
  ctx.clearRect(0,0,W,H);
  drawWorld();
  for(const p of Object.values(others)) drawPlayer(p,false);
  if(me) drawPlayer(me,true);
  drawMinimap();

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
