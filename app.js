/* ============================================================
   UNO Multijugador — Interfaz y lógica de cliente
   Modos: local (pasar dispositivo) y en línea (código de sala)
   ============================================================ */

import * as engine from './game.js';

/* --------------------------- Estado --------------------------- */

const app = {
  mode: null, // 'local' | 'online'
  payload: null,
  sound: true,
  unoTick: null,
  local: {
    game: null,
    names: [],
    round: 1,
    viewer: null,
    awaitingPass: false,
    timer: null,
    count: 2,
  },
  online: {
    code: null,
    playerId: null,
    name: null,
    es: null,
    reconnecting: false,
  },
};

const $ = (id) => document.getElementById(id);
const VIEWS = ['view-menu', 'view-local', 'view-create', 'view-join', 'view-lobby', 'view-game'];

function setView(name) {
  for (const v of VIEWS) $(v).classList.toggle('hidden', v !== name);
}

/* --------------------------- Sonido --------------------------- */

let audioCtx = null;
function beep(freq, dur = 0.08, type = 'triangle', vol = 0.18) {
  if (!app.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch { /* sin audio */ }
}
const sndPlay = () => beep(520, 0.07);
const sndDraw = () => beep(300, 0.09, 'square', 0.1);
const sndUno = () => { beep(660, 0.1); setTimeout(() => beep(880, 0.14), 110); };
const sndWin = () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 0.16), i * 130));
const sndError = () => beep(160, 0.16, 'sawtooth', 0.12);

/* --------------------------- Toast --------------------------- */

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 300);
  }, ms);
}

/* --------------------------- Cartas --------------------------- */

const SKIP_SVG = `<svg class="icon" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="33" fill="none" stroke="currentColor" stroke-width="12"/><line x1="25" y1="75" x2="75" y2="25" stroke="currentColor" stroke-width="12" stroke-linecap="round"/></svg>`;
const REV_SVG = `<svg class="icon" viewBox="0 0 100 100" aria-hidden="true"><polygon points="14,26 52,26 52,12 88,34 52,56 52,42 14,42" fill="currentColor"/><polygon points="86,74 48,74 48,88 12,66 48,44 48,58 86,58" fill="currentColor"/></svg>`;

function cornerLabel(card) {
  switch (card.kind) {
    case 'number': return String(card.value);
    case 'skip': return '⊘';
    case 'reverse': return '⇄';
    case 'draw2': return '+2';
    case 'wild': return '★';
    case 'draw4': return '+4';
    default: return '';
  }
}

function cardHTML(card, opts = {}) {
  const classes = ['card', card.color];
  if (opts.playable) classes.push('playable');
  if (opts.dim) classes.push('dim');
  const attrs = `class="${classes.join(' ')}" data-id="${card.id}" ${opts.title ? `title="${opts.title}"` : ''}`;

  let center;
  if (card.kind === 'number') {
    center = `<div class="oval"></div>
      <span class="corner tl">${card.value}</span>
      <span class="big">${card.value}</span>
      <span class="corner br">${card.value}</span>`;
  } else if (card.kind === 'skip') {
    center = `<div class="oval"></div>
      <span class="corner tl">⊘</span>
      ${SKIP_SVG}
      <span class="corner br">⊘</span>`;
  } else if (card.kind === 'reverse') {
    center = `<div class="oval"></div>
      <span class="corner tl">⇄</span>
      ${REV_SVG}
      <span class="corner br">⇄</span>`;
  } else if (card.kind === 'draw2') {
    center = `<div class="oval"></div>
      <span class="corner tl">+2</span>
      <span class="big">+2</span>
      <span class="corner br">+2</span>`;
  } else if (card.kind === 'draw4') {
    center = `<div class="oval"></div>
      <span class="corner tl">+4</span>
      <span class="big">+4</span>
      <span class="corner br">+4</span>`;
  } else {
    center = `<div class="oval"></div>
      <span class="corner tl">★</span>
      <span class="big">★</span>
      <span class="corner br">★</span>`;
  }
  return `<div ${attrs}>${center}</div>`;
}

function cardBackHTML() {
  return `<div class="card back"><div class="card-back-inner"><span>UNO</span></div></div>`;
}

/* --------------------------- API en línea --------------------------- */

async function api(path, body) {
  try {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ ok: false, error: 'Error de conexión' }));
    return data;
  } catch {
    return { ok: false, error: 'Sin conexión con el servidor' };
  }
}

function saveSession() {
  try {
    localStorage.setItem('uno-session', JSON.stringify(app.online));
  } catch { /* sin storage */ }
}
function clearSession() {
  try { localStorage.removeItem('uno-session'); } catch { /* sin storage */ }
}

/* Long-polling: funciona a través de cualquier proxy, CDN o red móvil */
let pollRunning = false;
let lastVersion = 0;

function connectSSE() {
  // (se usaba EventSource; ahora long-polling, compatible con todos los proxies)
  startPolling();
}

function startPolling() {
  pollRunning = true;
  lastVersion = 0;
  pollLoop();
}

async function pollLoop() {
  while (pollRunning && app.mode === 'online' && app.online.code) {
    try {
      const url = `/api/poll?code=${encodeURIComponent(app.online.code)}&playerId=${encodeURIComponent(app.online.playerId)}&after=${lastVersion}`;
      const res = await fetch(url);
      if (res.status === 404) {
        const data = await res.json().catch(() => ({}));
        toast(data.error || 'La sesión de la sala terminó');
        leaveOnline();
        return;
      }
      const data = await res.json();
      if (!pollRunning || app.mode !== 'online' || !app.online.code) return; // salió mientras esperaba
      if (!data.ok && data.error === 'out') {
        toast('Saliste de la sala');
        leaveOnline();
        return;
      }
      if (data.ok && typeof data.version === 'number') lastVersion = data.version;
      if (data.ok && data.payload) {
        app.online.reconnecting = false;
        handleState(data.payload);
      }
    } catch {
      if (!app.online.reconnecting) {
        app.online.reconnecting = true;
        toast('📡 Reconectando con la sala…', 3000);
      }
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  pollRunning = false;
}

function handleState(payload) {
  app.payload = payload;
  if (!payload.game) {
    renderLobby(payload);
    setView('view-lobby');
    return;
  }
  setView('view-game');
  renderGame(payload);
}

/* --------------------------- Menú --------------------------- */

$('btn-go-local').addEventListener('click', () => {
  app.mode = 'local';
  renderNameFields();
  setView('view-local');
});
$('btn-go-create').addEventListener('click', () => setView('view-create'));
$('btn-go-join').addEventListener('click', () => setView('view-join'));
$('btn-rules-menu').addEventListener('click', () => $('overlay-rules').classList.remove('hidden'));
$('btn-close-rules').addEventListener('click', () => $('overlay-rules').classList.add('hidden'));
$('btn-rules-game').addEventListener('click', () => $('overlay-rules').classList.remove('hidden'));

document.querySelectorAll('[data-back]').forEach((b) =>
  b.addEventListener('click', () => {
    app.mode = null;
    setView('view-menu');
  })
);

$('btn-sound').addEventListener('click', () => {
  app.sound = !app.sound;
  $('btn-sound').textContent = app.sound ? '🔊' : '🔇';
  if (app.sound) sndPlay();
});

/* --------------------------- Local --------------------------- */

$('local-count').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  app.local.count = Number(btn.dataset.n);
  document.querySelectorAll('#local-count .seg').forEach((s) => s.classList.toggle('active', s === btn));
  renderNameFields();
});

function renderNameFields() {
  const wrap = $('local-names');
  wrap.innerHTML = '';
  for (let i = 0; i < app.local.count; i++) {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.placeholder = `Jugador ${i + 1}`;
    input.value = i < app.local.names.length ? app.local.names[i] : '';
    input.addEventListener('input', () => { app.local.names[i] = input.value; });
    wrap.appendChild(input);
  }
}

$('btn-start-local').addEventListener('click', () => {
  const names = [];
  for (let i = 0; i < app.local.count; i++) {
    names.push((app.local.names[i] || '').trim() || `Jugador ${i + 1}`);
  }
  app.mode = 'local';
  app.local.names = names;
  app.local.round = 1;
  app.local.game = engine.createGame(names);
  app.local.viewer = 0;
  app.local.awaitingPass = true;
  sndPlay();
  setView('view-game');
  renderGame(localPayload());
});

function localPayload() {
  const g = app.local.game;
  const viewer = app.local.viewer ?? g.current;
  return {
    mode: 'local',
    room: { code: 'LOCAL', hostId: 'p0', inMatch: true, round: app.local.round },
    players: g.players.map((p, i) => ({
      id: 'p' + i,
      name: p.name,
      connected: true,
      isHost: i === 0,
    })),
    you: {
      playerId: 'p' + viewer,
      index: viewer,
      name: g.players[viewer].name,
      isHost: true,
    },
    game: engine.sanitize(g, viewer),
    serverTime: Date.now(),
  };
}

function afterLocalAction(prevCurrent) {
  const g = app.local.game;
  if (g.phase === 'colorPick') {
    // El mismo jugador elige color: sin pasar el dispositivo
  } else if (g.unoWindow && g.unoWindow.playerIdx === app.local.viewer) {
    // El jugador debe decir UNO antes de pasar el dispositivo
  } else if (g.phase === 'gameOver') {
    app.local.awaitingPass = false;
  } else if (g.current !== app.local.viewer) {
    app.local.awaitingPass = true;
  }
  syncLocalTimers();
  renderGame(localPayload());
}

function syncLocalTimers() {
  const g = app.local.game;
  if (!g) return;
  if (app.local.timer && !g.unoWindow) {
    clearTimeout(app.local.timer);
    app.local.timer = null;
  }
  if (g.unoWindow && !app.local.timer) {
    const ms = Math.max(50, g.unoWindow.expires - Date.now());
    app.local.timer = setTimeout(() => {
      app.local.timer = null;
      engine.expireUnoWindow(g);
      if (g.unoWindow === null && g.current !== app.local.viewer) {
        app.local.awaitingPass = true;
      }
      renderGame(localPayload());
    }, ms);
  }
}

$('btn-pass-ready').addEventListener('click', () => {
  const g = app.local.game;
  app.local.awaitingPass = false;
  app.local.viewer = g.current;
  sndPlay();
  renderGame(localPayload());
});

/* --------------------------- En línea --------------------------- */

$('btn-create-room').addEventListener('click', async () => {
  const name = $('create-name').value.trim();
  if (!name) return toast('Escribe tu nombre');
  const res = await api('/api/create', { name });
  if (!res.ok) return toast(res.error || 'No se pudo crear la sala');
  app.mode = 'online';
  app.online.code = res.code;
  app.online.playerId = res.playerId;
  app.online.name = res.name;
  saveSession();
  connectSSE();
});

$('btn-join-room').addEventListener('click', async () => {
  const code = $('join-code').value.trim().toUpperCase();
  const name = $('join-name').value.trim();
  if (code.length < 4) return toast('Escribe el código de la sala');
  if (!name) return toast('Escribe tu nombre');
  const res = await api('/api/join', { code, name });
  if (!res.ok) return toast(res.error || 'No se pudo unir');
  app.mode = 'online';
  app.online.code = res.code;
  app.online.playerId = res.playerId;
  app.online.name = res.name;
  saveSession();
  connectSSE();
});

$('btn-copy-code').addEventListener('click', async () => {
  const code = app.payload?.room?.code || app.online.code;
  try {
    await navigator.clipboard.writeText(code);
    toast('📋 Código copiado');
  } catch {
    toast(`Código: ${code}`);
  }
});

$('btn-start-online').addEventListener('click', async () => {
  const res = await api('/api/action', {
    action: 'start',
    code: app.online.code,
    playerId: app.online.playerId,
  });
  if (!res.ok) toast(res.error || 'No se pudo iniciar');
  else sndPlay();
});

$('btn-leave-lobby').addEventListener('click', () => leaveOnline());
$('btn-leave-game').addEventListener('click', () => {
  if (app.mode === 'online') leaveOnline();
  else {
    app.local.game = null;
    app.mode = null;
    setView('view-menu');
  }
});

function leaveOnline() {
  pollRunning = false;
  if (app.online.code && app.online.playerId) {
    api('/api/action', {
      action: 'leave',
      code: app.online.code,
      playerId: app.online.playerId,
    }).catch(() => {});
  }
  if (app.online.es) {
    try { app.online.es.close(); } catch { /* nada */ }
    app.online.es = null;
  }
  app.online.code = null;
  app.online.playerId = null;
  app.payload = null;
  app.mode = null;
  clearSession();
  setView('view-menu');
}

async function onlineAction(action, extra = {}) {
  const res = await api('/api/action', {
    action,
    code: app.online.code,
    playerId: app.online.playerId,
    ...extra,
  });
  if (!res.ok) {
    toast(res.error || 'Acción no permitida');
    sndError();
  }
  return res;
}

/* --------------------------- Lobby --------------------------- */

function renderLobby(payload) {
  $('lobby-code').textContent = payload.room.code;
  $('lobby-share').textContent = payload.room.code;

  const list = $('lobby-players');
  list.innerHTML = '';
  for (const p of payload.players) {
    const li = document.createElement('li');
    const hue = (p.name.charCodeAt(0) * 37) % 360;
    li.innerHTML = `
      <div class="avatar" style="background:hsl(${hue},60%,45%)">${p.name[0].toUpperCase()}</div>
      <span>${escapeHTML(p.name)}${p.id === payload.you.playerId ? ' (tú)' : ''}</span>
      <div class="conn-dot ${p.connected ? '' : 'off'}" title="${p.connected ? 'Conectado' : 'Desconectado'}"></div>
      ${p.isHost ? '<span class="host-tag">ANFITRIÓN</span>' : ''}`;
    list.appendChild(li);
  }

  const isHost = payload.you.isHost;
  $('btn-start-online').classList.toggle('hidden', !isHost);
  $('btn-start-online').disabled = payload.players.length < 2;
  $('lobby-waiting').textContent = isHost
    ? payload.players.length < 2
      ? 'Necesitas al menos 2 jugadores para empezar.'
      : 'Cuando todos estén listos, inicia la partida.'
    : 'Esperando a que el anfitrión inicie la partida…';
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* --------------------------- Mesa --------------------------- */

function renderGame(payload) {
  const g = payload.game;
  if (!g) return;

  app.payload = payload;
  const me = payload.you.index;
  const myTurn = g.current === me && g.phase !== 'gameOver' && g.phase !== 'colorPick';

  // Cabecera
  $('game-room-tag').textContent = payload.mode === 'local' ? `LOCAL · RONDA ${payload.room.round}` : `SALA ${payload.room.code}`;

  const board = $('scoreboard');
  board.innerHTML = payload.players.map((p, i) => `
    <div class="score-chip">
      ${i === g.current && g.phase !== 'gameOver' ? '<div class="turn-ring"></div>' : ''}
      <span>${escapeHTML(p.name)}</span>
      <b>${g.scores[i] ?? 0}</b>
    </div>`).join('');

  // Rivales
  const oppWrap = $('opponents');
  oppWrap.innerHTML = payload.players.map((p, i) => {
    if (i === me) return '';
    const count = g.players[i].handCount;
    const minis = Array.from({ length: Math.min(count, 7) }, () => '<div class="mini-card"></div>').join('');
    return `
      <div class="opp ${i === g.current ? 'active' : ''}">
        <div class="opp-cards">${minis}</div>
        <div class="opp-name">${escapeHTML(p.name)}${g.players[i].saidUno ? ' <span class="said">¡UNO!</span>' : ''}</div>
        <div class="opp-count">${count} carta${count === 1 ? '' : 's'}</div>
      </div>`;
  }).join('');

  // Centro
  $('deck-count').textContent = `${g.deckCount} en el mazo`;

  const discardWrap = $('discard-pile');
  discardWrap.innerHTML = (g.discard && g.discard.length ? g.discard : [g.topCard])
    .filter(Boolean)
    .map((c) => cardHTML(c))
    .join('');

  const colorHex = { red: '#e02b22', yellow: '#f5bd02', green: '#22a447', blue: '#1667d9', wild: '#1b1b20' };
  $('color-indicator').style.background = colorHex[g.activeColor] || '#555';

  const dir = g.direction === 1 ? '↻' : '↺';
  const turnName = g.phase === 'gameOver'
    ? '🏆 ¡Fin de la ronda!'
    : g.phase === 'colorPick'
      ? `🎨 ${escapeHTML(payload.players[g.pendingWild?.playerIdx ?? g.current].name)} elige color…`
      : g.current === me
        ? `${dir} ¡Es tu turno!`
        : `${dir} Turno de ${escapeHTML(payload.players[g.current].name)}`;
  $('turn-banner').innerHTML = turnBannerHTML(g, payload, me, dir, turnName);

  // Banner de acumulado
  const drawBanner = $('draw-banner');
  if (g.pendingDraw > 0 && g.phase !== 'gameOver') {
    drawBanner.classList.remove('hidden');
    drawBanner.textContent = `🔥 ¡${g.pendingDraw} cartas acumuladas! Responde con +2 / +4 o róbalas`;
  } else {
    drawBanner.classList.add('hidden');
  }

  // Banner UNO
  const unoBanner = $('uno-banner');
  if (g.unoWindow) {
    const name = payload.players[g.unoWindow.playerIdx].name;
    unoBanner.classList.remove('hidden');
    unoBanner.textContent = `⚡ ¡${escapeHTML(name)} tiene una carta!`;
  } else {
    unoBanner.classList.add('hidden');
  }

  // Mi mano
  const hand = g.players[me].hand || [];
  const handWrap = $('my-hand');
  handWrap.innerHTML = hand.map((c) => {
    const playable = myTurn && engine.canPlayCard(g, me, c);
    return cardHTML(c, { playable, dim: myTurn && !playable, title: engine.cardLabel(c) });
  }).join('');

  $('my-name').textContent = `${payload.you.name} · ${g.players[me].handCount} carta${g.players[me].handCount === 1 ? '' : 's'}`;
  $('my-turn-dot').classList.toggle('hidden', !myTurn);

  // Botones de acción
  const btnUno = $('btn-uno');
  const btnCatch = $('btn-catch');
  const btnDraw = $('btn-draw');
  const btnPass = $('btn-pass');

  const imTheUno = g.unoWindow && g.unoWindow.playerIdx === me;
  btnUno.classList.toggle('hidden', !imTheUno);
  btnCatch.classList.toggle('hidden', !(g.unoWindow && g.unoWindow.playerIdx !== me));

  const canDraw = myTurn && g.phase === 'playing';
  btnDraw.classList.toggle('hidden', !canDraw);
  btnDraw.textContent = g.pendingDraw > 0 ? `🎲 Robar ${g.pendingDraw} cartas` : '🎲 Robar carta';

  const mustPass = myTurn && g.justDrew && g.justDrew.playerIdx === me && g.justDrew.cardId;
  btnPass.classList.toggle('hidden', !mustPass);

  // Registro
  const logWrap = $('log-entries');
  logWrap.innerHTML = (g.log || []).map((e) =>
    `<div class="entry ${e.cls || ''}">${escapeHTML(e.text)}</div>`
  ).join('');
  logWrap.scrollTop = logWrap.scrollHeight;

  // Overlay de fin de ronda
  const roundOverlay = $('overlay-round');
  if (g.phase === 'gameOver') {
    roundOverlay.classList.remove('hidden');
    const winner = payload.players[g.winner];
    $('round-title').textContent = `🏆 ¡${winner.name} gana la ronda!`;
    $('round-scores').innerHTML = payload.players.map((p, i) => `
      <div class="row ${i === g.winner ? 'winner' : ''}">
        <span>${escapeHTML(p.name)}${i === g.winner && g.lastRoundPoints ? ` · +${g.lastRoundPoints.points} pts` : ''}</span>
        <b>${g.scores[i] ?? 0} pts</b>
      </div>`).join('');
    const btnNext = $('btn-next-round');
    const isHost = payload.you.isHost !== false;
    if (payload.mode === 'local' || isHost) {
      btnNext.classList.remove('hidden');
      btnNext.textContent = payload.mode === 'local' ? '🔁 Otra ronda' : '🔁 Otra ronda (anfitrión)';
    } else {
      btnNext.classList.add('hidden');
    }
  } else {
    roundOverlay.classList.add('hidden');
  }

  // Overlay elegir color
  const colorOverlay = $('overlay-color');
  if (g.phase === 'colorPick' && g.pendingWild && g.pendingWild.playerIdx === me) {
    colorOverlay.classList.remove('hidden');
  } else {
    colorOverlay.classList.add('hidden');
  }

  // Overlay pasar dispositivo (local)
  const passOverlay = $('overlay-pass');
  if (payload.mode === 'local' && app.local.awaitingPass && g.phase !== 'gameOver') {
    passOverlay.classList.remove('hidden');
    $('pass-title').textContent = `Pasa el dispositivo a ${payload.players[g.current].name}`;
    $('pass-sub').textContent = `${payload.players[g.current].name}, cuando tengas el dispositivo toca el botón.`;
  } else {
    passOverlay.classList.add('hidden');
  }

  // Cuenta regresiva UNO
  if (g.unoWindow) startUnoTick(g.unoWindow.expires);
  else stopUnoTick();
}

function turnBannerHTML(g, payload, me, dir, turnName) {
  return `<span>${turnName}</span>`;
}

function startUnoTick(expires) {
  if (app.unoTick) return;
  app.unoTick = setInterval(() => {
    const g = app.payload && app.payload.game;
    if (!g || !g.unoWindow) return stopUnoTick();
    const left = Math.max(0, g.unoWindow.expires - Date.now());
    const btn = $('btn-uno');
    if (!btn.classList.contains('hidden')) {
      btn.textContent = `¡UNO! (${Math.ceil(left / 1000)}s)`;
    }
  }, 250);
}
function stopUnoTick() {
  if (app.unoTick) clearInterval(app.unoTick);
  app.unoTick = null;
}

/* --------------------------- Acciones de juego --------------------------- */

$('my-hand').addEventListener('click', (e) => {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const payload = app.payload;
  if (!payload || !payload.game) return;
  const g = payload.game;
  const me = payload.you.index;
  const card = (g.players[me].hand || []).find((c) => c.id === cardEl.dataset.id);
  if (!card) return;

  if (g.phase === 'colorPick') return toast('Primero elige un color');
  if (g.current !== me) return toast('No es tu turno');
  if (!engine.canPlayCard(g, me, card)) {
    toast('Esa carta no coincide con la mesa');
    sndError();
    return;
  }
  if (card.kind === 'wild' || card.kind === 'draw4') {
    openColorPicker(card.id);
    return;
  }
  doPlay(card.id);
});

$('deck-pile').addEventListener('click', () => doDraw());

$('btn-draw').addEventListener('click', () => doDraw());
$('btn-pass').addEventListener('click', () => {
  if (app.mode === 'local') {
    const prev = app.local.game.current;
    const r = engine.passTurn(app.local.game, app.local.viewer);
    if (!r.ok) return toast(r.error);
    afterLocalAction(prev);
    sndPlay();
  } else {
    onlineAction('pass');
  }
});

$('btn-uno').addEventListener('click', () => {
  if (app.mode === 'local') {
    const r = engine.declareUno(app.local.game, app.local.viewer);
    if (!r.ok) return toast(r.error);
    if (app.local.game.unoWindow === null && app.local.game.current !== app.local.viewer) {
      app.local.awaitingPass = true;
    }
    sndUno();
    renderGame(localPayload());
  } else {
    onlineAction('uno').then((r) => { if (r.ok) sndUno(); });
  }
});

$('btn-catch').addEventListener('click', () => {
  if (app.mode === 'local') {
    const r = engine.catchUno(app.local.game, app.local.viewer);
    if (!r.ok) return toast(r.error);
    if (app.local.game.unoWindow === null && app.local.game.current !== app.local.viewer) {
      app.local.awaitingPass = true;
    }
    sndError();
    renderGame(localPayload());
  } else {
    onlineAction('catch').then((r) => { if (r.ok) sndError(); });
  }
});

$('btn-next-round').addEventListener('click', async () => {
  if (app.mode === 'local') {
    app.local.round += 1;
    app.local.game = engine.createGame(app.local.names, app.local.game.scores);
    app.local.viewer = 0;
    app.local.awaitingPass = true;
    sndPlay();
    renderGame(localPayload());
  } else {
    const r = await onlineAction('next-round');
    if (r.ok) sndPlay();
  }
});

$('btn-exit-round').addEventListener('click', () => {
  if (app.mode === 'online') leaveOnline();
  else {
    app.local.game = null;
    app.mode = null;
    setView('view-menu');
  }
});

function doPlay(cardId, color) {
  if (app.mode === 'local') {
    const g = app.local.game;
    const me = app.local.viewer;
    const r = engine.playCard(g, me, cardId);
    if (!r.ok) { toast(r.error); sndError(); return; }
    if (color && g.phase === 'colorPick') {
      const r2 = engine.chooseColor(g, me, color);
      if (!r2.ok) toast(r2.error);
    }
    sndPlay();
    afterLocalAction(g.current);
  } else {
    onlineAction('play', { cardId, color }).then((r) => { if (r.ok) sndPlay(); });
  }
}

function doDraw() {
  const payload = app.payload;
  if (!payload || !payload.game) return;
  if (payload.game.current !== payload.you.index) return toast('No es tu turno');

  if (app.mode === 'local') {
    const prev = app.local.game.current;
    const r = engine.drawAction(app.local.game, app.local.viewer);
    if (!r.ok) { toast(r.error); sndError(); return; }
    sndDraw();
    afterLocalAction(prev);
  } else {
    onlineAction('draw').then((r) => { if (r.ok) sndDraw(); });
  }
}

/* --------------------------- Selector de color --------------------------- */

let pendingColorCardId = null;

function openColorPicker(cardId) {
  pendingColorCardId = cardId;
  $('overlay-color').classList.remove('hidden');
}

document.querySelector('.color-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('.color-btn');
  if (!btn) return;
  const color = btn.dataset.color;
  $('overlay-color').classList.add('hidden');
  if (pendingColorCardId) {
    doPlay(pendingColorCardId, color);
    pendingColorCardId = null;
  } else if (app.payload?.game?.pendingWild) {
    // Eligiendo color tras un comodín ya jugado (reconexión / modo en línea)
    if (app.mode === 'local') {
      const r = engine.chooseColor(app.local.game, app.local.viewer, color);
      if (!r.ok) toast(r.error);
      renderGame(localPayload());
    } else {
      onlineAction('color', { color });
    }
  }
});

/* --------------------------- Arranque / reconexión --------------------------- */

async function tryRestoreSession() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('uno-session') || 'null');
  } catch { /* nada */ }
  if (!saved || !saved.code || !saved.playerId) return;
  const res = await api(`/api/state?code=${encodeURIComponent(saved.code)}&playerId=${encodeURIComponent(saved.playerId)}`);
  if (res.ok && res.payload) {
    app.mode = 'online';
    app.online.code = saved.code;
    app.online.playerId = saved.playerId;
    app.online.name = saved.name;
    connectSSE();
    handleState(res.payload);
    toast(`🔄 Sesión restaurada: sala ${saved.code}`);
  } else {
    clearSession();
  }
}

renderNameFields();
tryRestoreSession();
