/* ============================================================
   Servidor UNO Multijugador
   - Sirve el juego estático (public/)
   - Salas en línea con código: REST + Server-Sent Events
   Sin dependencias externas: solo módulos de Node.
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const engine = (() => {
/* ============================================================
   Motor del juego UNO — lógica pura compartida
   Funciona tanto en el navegador (modo local) como en Node
   (servidor de salas en línea). Sin dependencias.
   ============================================================ */

const COLORS = ['red', 'yellow', 'green', 'blue'];

const COLOR_NAMES = {
  red: 'rojo',
  yellow: 'amarillo',
  green: 'verde',
  blue: 'azul',
};

const UNO_WINDOW_MS = 7000;

const COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
const KIND_ORDER = { number: 0, skip: 1, reverse: 2, draw2: 3, wild: 4, draw4: 5 };

let cardCounter = 0;
const uid = () => 'c' + ++cardCounter;

/* ---------------------------- Mazo ---------------------------- */

function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ id: uid(), color, kind: 'number', value: 0 });
    for (let v = 1; v <= 9; v++) {
      deck.push({ id: uid(), color, kind: 'number', value: v });
      deck.push({ id: uid(), color, kind: 'number', value: v });
    }
    for (const kind of ['skip', 'reverse', 'draw2']) {
      deck.push({ id: uid(), color, kind, value: null });
      deck.push({ id: uid(), color, kind, value: null });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: uid(), color: 'wild', kind: 'wild', value: null });
    deck.push({ id: uid(), color: 'wild', kind: 'draw4', value: null });
  }
  return deck; // 108 cartas
}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function sortHand(hand) {
  hand.sort((a, b) =>
    (COLOR_ORDER[a.color] - COLOR_ORDER[b.color]) ||
    (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) ||
    ((a.value ?? -1) - (b.value ?? -1))
  );
  return hand;
}

/* --------------------------- Utilidades --------------------------- */

function getTop(state) {
  if (state.discard && state.discard.length) return state.discard[state.discard.length - 1];
  return state.topCard || null;
}

function nextIndex(state) {
  const n = state.players.length;
  return ((state.current + state.direction) % n + n) % n;
}

function cardLabel(card) {
  if (!card) return '';
  const c = COLOR_NAMES[card.color] || '';
  switch (card.kind) {
    case 'number': return `${card.value} ${c}`;
    case 'skip': return `Prohibido ${c}`;
    case 'reverse': return `Reversa ${c}`;
    case 'draw2': return `+2 ${c}`;
    case 'wild': return 'Comodín';
    case 'draw4': return 'Comodín +4';
    default: return 'carta';
  }
}

function handPoints(hand) {
  let pts = 0;
  for (const card of hand) {
    if (card.kind === 'number') pts += card.value;
    else if (card.kind === 'wild' || card.kind === 'draw4') pts += 50;
    else pts += 20;
  }
  return pts;
}

function log(state, text, cls) {
  state.log.push({ text, t: Date.now(), cls: cls || '' });
  if (state.log.length > 60) state.log.splice(0, state.log.length - 60);
}

function err(message) {
  return { ok: false, error: message };
}
function ok(data) {
  return { ok: true, ...(data || {}) };
}

/* --------------------------- Crear partida --------------------------- */

function createGame(playerNames, prevScores = null) {
  if (!Array.isArray(playerNames) || playerNames.length < 2 || playerNames.length > 6) {
    throw new Error('Se necesitan de 2 a 6 jugadores');
  }
  const deck = shuffle(createDeck());
  const players = playerNames.map((name) => ({
    name: String(name || 'Jugador').trim().slice(0, 20) || 'Jugador',
    hand: [],
    saidUno: false,
  }));

  for (let r = 0; r < 7; r++) {
    for (const p of players) p.hand.push(deck.pop());
  }
  for (const p of players) sortHand(p.hand);

  const discard = [];
  let first = deck.pop();
  while (first.color === 'wild' && deck.length) {
    deck.push(first);
    shuffle(deck);
    first = deck.pop();
  }
  discard.push(first);

  const state = {
    players,
    deck,
    discard,
    current: 0,
    direction: 1,
    activeColor: first.color,
    pendingDraw: 0,
    pendingWild: null,
    justDrew: null,
    unoWindow: null,
    phase: 'playing', // playing | colorPick | gameOver
    winner: null,
    lastRoundPoints: null,
    scores: prevScores ? prevScores.slice(0, players.length) : players.map(() => 0),
    log: [],
    turnCount: 0,
    startedAt: Date.now(),
  };

  log(state, `Nueva ronda. Carta inicial: ${cardLabel(first)}`);

  // Efecto de la carta inicial
  if (first.kind === 'skip') {
    log(state, `${players[0].name} pierde su turno (Prohibido)`);
    state.current = nextIndex(state);
  } else if (first.kind === 'reverse') {
    state.direction = -1;
    log(state, 'La Reversa invierte el sentido del juego');
  } else if (first.kind === 'draw2') {
    drawCardsInternal(state, 0, 2);
    log(state, `${players[0].name} roba 2 cartas por la carta inicial`);
    state.current = nextIndex(state);
  }

  return state;
}

/* --------------------------- Mazo / robo --------------------------- */

function ensureDeck(state) {
  if (state.deck.length > 0) return;
  if (state.discard.length <= 1) return;
  const top = state.discard.pop();
  const rest = state.discard.splice(0);
  state.deck = shuffle(rest);
  state.discard = [top];
  log(state, 'Se barajaron las cartas descartadas');
}

function drawCardsInternal(state, playerIdx, n) {
  const player = state.players[playerIdx];
  const drawn = [];
  for (let i = 0; i < n; i++) {
    ensureDeck(state);
    if (!state.deck.length) break;
    const card = state.deck.pop();
    player.hand.push(card);
    drawn.push(card);
  }
  if (drawn.length) sortHand(player.hand);
  return drawn;
}

/* --------------------------- Reglas --------------------------- */

function canPlayCard(state, playerIdx, card) {
  if (!card || !state.players[playerIdx]) return false;
  if (state.phase === 'gameOver' || state.phase === 'colorPick') return false;
  if (state.current !== playerIdx) return false;
  if (state.justDrew) {
    if (state.justDrew.playerIdx !== playerIdx) return false;
    if (state.justDrew.cardId !== card.id) return false;
  }
  // Acumulación de +2/+4: solo cartas de robar
  if (state.pendingDraw > 0) return card.kind === 'draw2' || card.kind === 'draw4';

  const top = getTop(state);
  if (card.color === 'wild') return true;
  if (card.color === state.activeColor) return true;
  if (!top) return true;
  if (card.kind === 'number' && top.kind === 'number') return card.value === top.value;
  if (card.kind !== 'number' && card.kind === top.kind) return true;
  return false;
}

function playableCards(state, playerIdx) {
  const p = state.players[playerIdx];
  if (!p || !p.hand) return [];
  return p.hand.filter((c) => canPlayCard(state, playerIdx, c)).map((c) => c.id);
}

/* --------------------------- Acciones --------------------------- */

function playCard(state, playerIdx, cardId) {
  expireUnoWindow(state);

  if (state.phase === 'gameOver') return err('La ronda ya terminó');
  if (state.phase === 'colorPick') return err('Primero elige un color');
  if (state.current !== playerIdx) return err('No es tu turno');

  const player = state.players[playerIdx];
  const idx = player.hand.findIndex((c) => c.id === cardId);
  if (idx < 0) return err('No tienes esa carta');

  const card = player.hand[idx];
  if (!canPlayCard(state, playerIdx, card)) return err('Esa carta no coincide con la mesa');

  player.hand.splice(idx, 1);
  state.discard.push(card);
  state.justDrew = null;
  player.saidUno = false;

  let advance = 1;

  switch (card.kind) {
    case 'number':
      state.activeColor = card.color;
      break;
    case 'skip':
      state.activeColor = card.color;
      advance = 2;
      break;
    case 'reverse':
      state.activeColor = card.color;
      state.direction *= -1;
      advance = state.players.length === 2 ? 2 : 1;
      break;
    case 'draw2':
      state.activeColor = card.color;
      state.pendingDraw += 2;
      break;
    case 'wild':
      state.pendingWild = { playerIdx, cardId: card.id, advance: 1 };
      state.phase = 'colorPick';
      break;
    case 'draw4':
      state.pendingDraw += 4;
      state.pendingWild = { playerIdx, cardId: card.id, advance: 1 };
      state.phase = 'colorPick';
      break;
    default:
      state.activeColor = card.color;
  }

  log(state, `${player.name} jugó ${cardLabel(card)}`);

  if (state.phase === 'colorPick') {
    // El avance ocurre al elegir color
  } else {
    for (let i = 0; i < advance; i++) state.current = nextIndex(state);
    state.turnCount++;
  }

  if (player.hand.length === 0) {
    finishGame(state, playerIdx);
    return ok();
  }
  if (player.hand.length === 1) {
    state.unoWindow = { playerIdx, expires: Date.now() + UNO_WINDOW_MS, saidUno: false };
  }
  return ok();
}

function chooseColor(state, playerIdx, color) {
  if (state.phase === 'gameOver') return err('La ronda ya terminó');
  if (!state.pendingWild || state.pendingWild.playerIdx !== playerIdx) {
    return err('No puedes elegir color ahora');
  }
  if (!COLORS.includes(color)) return err('Color inválido');

  state.activeColor = color;
  const advance = state.pendingWild.advance || 1;
  state.pendingWild = null;
  state.justDrew = null;
  state.phase = 'playing';
  for (let i = 0; i < advance; i++) state.current = nextIndex(state);
  state.turnCount++;

  log(state, `${state.players[playerIdx].name} eligió el color ${COLOR_NAMES[color]}`);
  return ok();
}

function drawAction(state, playerIdx) {
  expireUnoWindow(state);

  if (state.phase === 'gameOver') return err('La ronda ya terminó');
  if (state.phase === 'colorPick') return err('Primero elige un color');
  if (state.current !== playerIdx) return err('No es tu turno');

  const player = state.players[playerIdx];

  // Acumulado de +2/+4: roba todo y pierde el turno
  if (state.pendingDraw > 0) {
    const n = state.pendingDraw;
    state.pendingDraw = 0;
    state.justDrew = null;
    drawCardsInternal(state, playerIdx, n);
    log(state, `${player.name} roba ${n} cartas acumuladas`, 'danger');
    state.current = nextIndex(state);
    state.turnCount++;
    return ok({ drew: n });
  }

  const drawn = drawCardsInternal(state, playerIdx, 1);
  if (!drawn.length) {
    // No hay cartas en ninguna parte: el turno pasa (se avisa en el registro)
    state.justDrew = null;
    log(state, `No quedan cartas para robar: ${player.name} pierde el turno`, 'danger');
    state.current = nextIndex(state);
    state.turnCount++;
    return ok({ drew: 0, skipped: true });
  }
  const card = drawn[0];
  state.justDrew = { playerIdx, cardId: card.id };
  log(state, `${player.name} robó una carta`);
  return ok({ drew: 1, cardId: card.id });
}

function passTurn(state, playerIdx) {
  if (state.phase === 'gameOver') return err('La ronda ya terminó');
  if (state.phase === 'colorPick') return err('Primero elige un color');
  if (state.current !== playerIdx) return err('No es tu turno');
  if (!state.justDrew || state.justDrew.playerIdx !== playerIdx) {
    return err('Debes jugar una carta o robar antes de pasar');
  }
  // Solo puedes pasar si la carta robada SÍ se puede jugar.
  // Si no tienes con qué jugar y hay cartas en el mazo, sigue robando.
  const player = state.players[playerIdx];
  const drawnCard = player.hand.find((c) => c.id === state.justDrew.cardId);
  if (!drawnCard || !canPlayCard(state, playerIdx, drawnCard)) {
    return err('Todavía no tienes con qué jugar: roba otra carta del mazo');
  }
  state.justDrew = null;
  log(state, `${player.name} pasó`);
  state.current = nextIndex(state);
  state.turnCount++;
  return ok();
}

function declareUno(state, playerIdx) {
  if (!state.unoWindow || state.unoWindow.playerIdx !== playerIdx) {
    return err('No es momento de decir UNO');
  }
  if (state.players[playerIdx].hand.length !== 1) return err('No tienes una sola carta');

  state.players[playerIdx].saidUno = true;
  state.unoWindow = null;
  log(state, `¡${state.players[playerIdx].name} dijo UNO!`, 'uno');
  return ok();
}

function catchUno(state, catcherIdx) {
  expireUnoWindow(state);
  if (!state.unoWindow) return err('No hay nada que atrapar');
  const offenderIdx = state.unoWindow.playerIdx;
  if (offenderIdx === catcherIdx) return err('No puedes atraparte a ti mismo');

  const offender = state.players[offenderIdx];
  drawCardsInternal(state, offenderIdx, 2);
  state.unoWindow = null;
  log(state, `${state.players[catcherIdx].name} atrapó a ${offender.name} sin decir UNO: +2`, 'danger');
  return ok();
}

function expireUnoWindow(state) {
  if (!state.unoWindow) return false;
  if (Date.now() < state.unoWindow.expires) return false;
  const offenderIdx = state.unoWindow.playerIdx;
  const offender = state.players[offenderIdx];
  drawCardsInternal(state, offenderIdx, 2);
  state.unoWindow = null;
  log(state, `${offender.name} no dijo UNO a tiempo: +2`, 'danger');
  return true;
}

function finishGame(state, winnerIdx) {
  state.phase = 'gameOver';
  state.winner = winnerIdx;
  state.unoWindow = null;
  state.pendingWild = null;
  state.justDrew = null;
  let points = 0;
  state.players.forEach((p, i) => {
    if (i !== winnerIdx) points += handPoints(p.hand);
  });
  state.lastRoundPoints = { winner: winnerIdx, points };
  if (!state.scores || state.scores.length !== state.players.length) {
    state.scores = state.players.map(() => 0);
  }
  state.scores[winnerIdx] += points;
  log(state, `¡${state.players[winnerIdx].name} ganó la ronda (+${points} puntos)!`, 'win');
}

/* --------------------------- Vista privada --------------------------- */

function sanitize(state, viewerIdx) {
  if (!state) return null;
  return {
    players: state.players.map((p, i) => ({
      name: p.name,
      saidUno: !!p.saidUno,
      handCount: p.hand.length,
      hand: i === viewerIdx ? p.hand.map((c) => ({ ...c })) : null,
    })),
    deckCount: state.deck.length,
    discardCount: state.discard.length,
    discard: state.discard.slice(-3).map((c) => ({ ...c })),
    topCard: getTop(state) ? { ...getTop(state) } : null,
    current: state.current,
    direction: state.direction,
    activeColor: state.activeColor,
    pendingDraw: state.pendingDraw,
    pendingWild: state.pendingWild ? { ...state.pendingWild } : null,
    justDrew: state.justDrew
      ? {
          playerIdx: state.justDrew.playerIdx,
          cardId: state.justDrew.playerIdx === viewerIdx ? state.justDrew.cardId : null,
        }
      : null,
    unoWindow: state.unoWindow
      ? {
          playerIdx: state.unoWindow.playerIdx,
          expires: state.unoWindow.expires,
          saidUno: !!state.unoWindow.saidUno,
        }
      : null,
    phase: state.phase,
    winner: state.winner,
    lastRoundPoints: state.lastRoundPoints ? { ...state.lastRoundPoints } : null,
    scores: state.scores ? state.scores.slice() : state.players.map(() => 0),
    log: state.log.slice(-30),
    turnCount: state.turnCount,
  };
}

return { COLORS, COLOR_NAMES, UNO_WINDOW_MS, createDeck, shuffle, sortHand, getTop, nextIndex, cardLabel, handPoints, createGame, canPlayCard, playableCards, playCard, chooseColor, drawAction, passTurn, declareUno, catchUno, expireUnoWindow, sanitize };
})();
const EMBEDDED = {
  '/index.html': "<!DOCTYPE html>\n<html lang=\"es\">\n<head>\n  <meta charset=\"UTF-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\" />\n  <title>UNO Multijugador</title>\n  <link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23e02b22'/%3E%3Cellipse cx='32' cy='32' rx='24' ry='17' fill='white' transform='rotate(-20 32 32)'/%3E%3Ctext x='32' y='41' font-size='24' font-weight='900' font-style='italic' font-family='Arial' fill='%23e02b22' text-anchor='middle'%3E7%3C/text%3E%3C/svg%3E\" />\n  <link rel=\"stylesheet\" href=\"./style.css\" />\n</head>\n<body>\n  <!-- ============ MENÚ PRINCIPAL ============ -->\n  <div id=\"view-menu\" class=\"view\">\n    <div class=\"menu-hero\">\n      <div class=\"logo-card\" aria-hidden=\"true\">\n        <div class=\"logo-oval\">\n          <span class=\"logo-text\">UNO</span>\n        </div>\n      </div>\n      <h1>UNO <span class=\"accent\">Multijugador</span></h1>\n      <p class=\"tagline\">El clásico juego de cartas · 2 a 6 jugadores</p>\n\n      <div class=\"menu-buttons\">\n        <button class=\"btn btn-primary btn-big\" id=\"btn-go-local\">🎮 Jugar en local</button>\n        <button class=\"btn btn-blue btn-big\" id=\"btn-go-create\">🌐 Crear sala en línea</button>\n        <button class=\"btn btn-green btn-big\" id=\"btn-go-join\">🔑 Unirse con código</button>\n        <button class=\"btn btn-ghost\" id=\"btn-rules-menu\">📖 ¿Cómo se juega?</button>\n      </div>\n\n      <div class=\"menu-badges\">\n        <span class=\"badge-pill\">Reglas clásicas</span>\n        <span class=\"badge-pill\">+2 / +4 acumulables</span>\n        <span class=\"badge-pill\">¡Grita UNO!</span>\n        <span class=\"badge-pill\">Hasta 6 jugadores</span>\n      </div>\n    </div>\n  </div>\n\n  <!-- ============ CONFIGURACIÓN LOCAL ============ -->\n  <div id=\"view-local\" class=\"view hidden\">\n    <div class=\"panel\">\n      <button class=\"btn-back\" data-back>← Volver</button>\n      <h2>🎮 Partida local</h2>\n      <p class=\"hint\">Todos los jugadores comparten este dispositivo. Se turnan y pasan la pantalla.</p>\n\n      <label class=\"field\">\n        <span>Número de jugadores</span>\n        <div class=\"segmented\" id=\"local-count\">\n          <button data-n=\"2\" class=\"seg active\">2</button>\n          <button data-n=\"3\" class=\"seg\">3</button>\n          <button data-n=\"4\" class=\"seg\">4</button>\n          <button data-n=\"5\" class=\"seg\">5</button>\n          <button data-n=\"6\" class=\"seg\">6</button>\n        </div>\n      </label>\n\n      <div class=\"field\">\n        <span>Nombres</span>\n        <div id=\"local-names\" class=\"names-grid\"></div>\n      </div>\n\n      <button class=\"btn btn-primary btn-big\" id=\"btn-start-local\">🃏 ¡Repartir cartas!</button>\n    </div>\n  </div>\n\n  <!-- ============ CREAR SALA ============ -->\n  <div id=\"view-create\" class=\"view hidden\">\n    <div class=\"panel\">\n      <button class=\"btn-back\" data-back>← Volver</button>\n      <h2>🌐 Crear sala en línea</h2>\n      <p class=\"hint\">Comparte el código con tus amigos para que se unan desde su dispositivo.</p>\n      <label class=\"field\">\n        <span>Tu nombre</span>\n        <input id=\"create-name\" type=\"text\" maxlength=\"20\" placeholder=\"Ej. Ana\" autocomplete=\"off\" />\n      </label>\n      <button class=\"btn btn-blue btn-big\" id=\"btn-create-room\">Crear sala</button>\n    </div>\n  </div>\n\n  <!-- ============ UNIRSE ============ -->\n  <div id=\"view-join\" class=\"view hidden\">\n    <div class=\"panel\">\n      <button class=\"btn-back\" data-back>← Volver</button>\n      <h2>🔑 Unirse a una sala</h2>\n      <label class=\"field\">\n        <span>Código de la sala</span>\n        <input id=\"join-code\" type=\"text\" maxlength=\"5\" placeholder=\"Ej. K7M2P\" autocomplete=\"off\" class=\"code-input\" />\n      </label>\n      <label class=\"field\">\n        <span>Tu nombre</span>\n        <input id=\"join-name\" type=\"text\" maxlength=\"20\" placeholder=\"Ej. Luis\" autocomplete=\"off\" />\n      </label>\n      <button class=\"btn btn-green btn-big\" id=\"btn-join-room\">Unirme</button>\n    </div>\n  </div>\n\n  <!-- ============ SALA (LOBBY) ============ -->\n  <div id=\"view-lobby\" class=\"view hidden\">\n    <div class=\"panel lobby-panel\">\n      <h2>Sala <span class=\"room-code\" id=\"lobby-code\">·····</span></h2>\n      <p class=\"hint\">Comparte este código para invitar jugadores:</p>\n      <div class=\"share-code\" id=\"lobby-share\">·····</div>\n      <button class=\"btn btn-ghost btn-small\" id=\"btn-copy-code\">📋 Copiar código</button>\n\n      <h3>Jugadores en la sala</h3>\n      <ul id=\"lobby-players\" class=\"player-list\"></ul>\n      <p class=\"hint\" id=\"lobby-waiting\">Esperando a que el anfitrión inicie la partida…</p>\n      <button class=\"btn btn-primary btn-big hidden\" id=\"btn-start-online\">🃏 Iniciar partida</button>\n      <button class=\"btn btn-ghost\" id=\"btn-leave-lobby\">Salir de la sala</button>\n    </div>\n  </div>\n\n  <!-- ============ MESA DE JUEGO ============ -->\n  <div id=\"view-game\" class=\"view hidden\">\n    <header class=\"game-header\">\n      <div class=\"brand-mini\">\n        <div class=\"logo-mini\"><span>UNO</span></div>\n        <span class=\"room-tag\" id=\"game-room-tag\">LOCAL</span>\n      </div>\n      <div class=\"scoreboard\" id=\"scoreboard\"></div>\n      <div class=\"header-actions\">\n        <button class=\"btn btn-ghost btn-small\" id=\"btn-rules-game\" title=\"Reglas\">📖</button>\n        <button class=\"btn btn-ghost btn-small\" id=\"btn-sound\" title=\"Sonido\">🔊</button>\n        <button class=\"btn btn-ghost btn-small\" id=\"btn-leave-game\" title=\"Salir\">✕</button>\n      </div>\n    </header>\n\n    <div class=\"table-felt\">\n      <div class=\"opponents\" id=\"opponents\"></div>\n\n      <div class=\"table-center\">\n        <div class=\"turn-banner\" id=\"turn-banner\"></div>\n        <div class=\"piles\">\n          <div class=\"pile-wrap\">\n            <div class=\"card back deck-card\" id=\"deck-pile\" title=\"Robar carta\">\n              <div class=\"card-back-inner\"><span>UNO</span></div>\n            </div>\n            <div class=\"pile-count\" id=\"deck-count\">0</div>\n          </div>\n          <div class=\"pile-wrap\">\n            <div id=\"discard-pile\" class=\"discard-slot\"></div>\n            <div class=\"pile-label\" id=\"discard-label\">Mesa</div>\n          </div>\n          <div class=\"color-indicator\" id=\"color-indicator\" title=\"Color activo\"></div>\n        </div>\n        <div class=\"draw-banner hidden\" id=\"draw-banner\"></div>\n        <div class=\"uno-banner hidden\" id=\"uno-banner\"></div>\n      </div>\n\n      <div class=\"my-area\">\n        <div class=\"my-name-row\">\n          <span id=\"my-name\">Tú</span>\n          <span class=\"turn-dot hidden\" id=\"my-turn-dot\">Tu turno</span>\n        </div>\n        <div class=\"my-hand\" id=\"my-hand\"></div>\n        <div class=\"action-row\">\n          <button class=\"btn btn-yellow btn-big pulse hidden\" id=\"btn-uno\">¡UNO!</button>\n          <button class=\"btn btn-red btn-big hidden\" id=\"btn-catch\">🖐 ¡Atrapar!</button>\n          <button class=\"btn btn-blue hidden\" id=\"btn-draw\">🎲 Robar carta</button>\n          <button class=\"btn btn-ghost hidden\" id=\"btn-pass\">Pasar ➜</button>\n        </div>\n      </div>\n\n      <aside class=\"game-log\" id=\"game-log\">\n        <div class=\"log-title\">📜 Jugadas</div>\n        <div class=\"log-entries\" id=\"log-entries\"></div>\n      </aside>\n    </div>\n\n    <!-- Pantalla de fin de ronda -->\n    <div class=\"overlay hidden\" id=\"overlay-round\">\n      <div class=\"overlay-card\">\n        <h2 id=\"round-title\">¡Ronda terminada!</h2>\n        <div id=\"round-scores\" class=\"round-scores\"></div>\n        <button class=\"btn btn-primary btn-big\" id=\"btn-next-round\">🔁 Otra ronda</button>\n        <button class=\"btn btn-ghost\" id=\"btn-exit-round\">Salir al menú</button>\n      </div>\n    </div>\n  </div>\n\n  <!-- ============ PASAR DISPOSITIVO (local) ============ -->\n  <div class=\"overlay hidden\" id=\"overlay-pass\">\n    <div class=\"overlay-card\">\n      <div class=\"pass-icon\">📱</div>\n      <h2 id=\"pass-title\">Pasa el dispositivo</h2>\n      <p class=\"hint\" id=\"pass-sub\">Cuando estés listo, toca el botón para ver tus cartas.</p>\n      <button class=\"btn btn-primary btn-big\" id=\"btn-pass-ready\">Listo, soy yo 👋</button>\n    </div>\n  </div>\n\n  <!-- ============ ELEGIR COLOR ============ -->\n  <div class=\"overlay hidden\" id=\"overlay-color\">\n    <div class=\"overlay-card\">\n      <h2>Elige el color</h2>\n      <div class=\"color-picker\">\n        <button class=\"color-btn\" data-color=\"red\" style=\"--c:#e02b22\">Rojo</button>\n        <button class=\"color-btn\" data-color=\"yellow\" style=\"--c:#f5bd02\">Amarillo</button>\n        <button class=\"color-btn\" data-color=\"green\" style=\"--c:#22a447\">Verde</button>\n        <button class=\"color-btn\" data-color=\"blue\" style=\"--c:#1667d9\">Azul</button>\n      </div>\n    </div>\n  </div>\n\n  <!-- ============ REGLAS ============ -->\n  <div class=\"overlay hidden\" id=\"overlay-rules\">\n    <div class=\"overlay-card rules-card\">\n      <h2>📖 Reglas clásicas</h2>\n      <div class=\"rules-scroll\">\n        <h3>Objetivo</h3>\n        <p>Sé el primero en quedarte sin cartas. Al final de la ronda, el ganador suma los puntos de las cartas que dejaron los demás.</p>\n        <h3>En tu turno</h3>\n        <p>Juega una carta que coincida con el <b>color</b>, el <b>número</b> o el <b>símbolo</b> de la carta de la mesa. También puedes jugar un <b>Comodín</b> en cualquier momento, o robar una carta del mazo. <b>Si robas y no puedes jugarla, sigue robando</b> mientras haya cartas en el mazo — el turno solo pasa si decides no jugar una carta robada que sí era jugable, o si ya no hay cartas que robar.</p>\n        <h3>Cartas de acción</h3>\n        <ul>\n          <li><b>Prohibido (⊘)</b>: el siguiente jugador pierde su turno.</li>\n          <li><b>Reversa (⇄)</b>: invierte el sentido del juego (con 2 jugadores funciona como Prohibido).</li>\n          <li><b>+2</b>: el siguiente roba 2 cartas y pierde su turno.</li>\n          <li><b>Comodín</b>: eliges el nuevo color.</li>\n          <li><b>Comodín +4</b>: eliges color y el siguiente roba 4 cartas.</li>\n        </ul>\n        <h3>Acumulación (+2 / +4)</h3>\n        <p>Si te cae un <b>+2</b> o un <b>+4</b>, puedes responder con otro <b>+2</b> o <b>+4</b> y pasar la suma al siguiente jugador. Si no tienes (o no quieres), <b>roba toda la suma acumulada</b> y pierdes el turno.</p>\n        <h3>¡UNO!</h3>\n        <p>Cuando te quede <b>una sola carta</b>, debes pulsar <b>¡UNO!</b> antes de que se acabe el tiempo. Si no lo haces y otro jugador te atrapa (o se acaba la cuenta), <b>robas 2 cartas</b>.</p>\n        <h3>Puntuación</h3>\n        <ul>\n          <li>Cartas de número: su valor.</li>\n          <li>Prohibido, Reversa, +2: 20 puntos.</li>\n          <li>Comodín y Comodín +4: 50 puntos.</li>\n        </ul>\n        <h3>Ganar la partida</h3>\n        <p>Juega rondas acumulando puntos. Puedes lanzar otra ronda cuando quieras.</p>\n      </div>\n      <button class=\"btn btn-primary\" id=\"btn-close-rules\">Entendido</button>\n    </div>\n  </div>\n\n  <!-- ============ AVISOS ============ -->\n  <div id=\"toast\" class=\"toast hidden\"></div>\n\n  <script type=\"module\" src=\"./app.js\"></script>\n</body>\n</html>\n",
  '/style.css': "/* ============================================================\n   UNO Multijugador — Estilo clásico colorido\n   ============================================================ */\n\n:root {\n  --red: #e02b22;\n  --yellow: #f5bd02;\n  --green: #22a447;\n  --blue: #1667d9;\n  --wild: #1b1b20;\n  --felt-1: #0e6b45;\n  --felt-2: #08432c;\n  --ink: #1d2330;\n  --paper: #f7f5f0;\n  --white: #ffffff;\n  --shadow: 0 10px 30px rgba(0, 0, 0, 0.35);\n  --radius: 16px;\n  --header-h: 58px;\n  --card-w: 92px;\n  --card-h: 138px;\n}\n\n* { box-sizing: border-box; margin: 0; padding: 0; }\n\nhtml, body {\n  height: 100%;\n  font-family: 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;\n  background: var(--felt-2);\n  color: var(--ink);\n  overflow: hidden;\n  -webkit-tap-highlight-color: transparent;\n  user-select: none;\n}\n\n.hidden { display: none !important; }\n\n/* --------------------------- Vistas --------------------------- */\n\n.view {\n  position: fixed;\n  inset: 0;\n  overflow-y: auto;\n}\n\n#view-menu, #view-local, #view-create, #view-join, #view-lobby {\n  background:\n    radial-gradient(1200px 600px at 20% -10%, rgba(255, 255, 255, 0.10), transparent 60%),\n    radial-gradient(900px 500px at 110% 110%, rgba(224, 43, 34, 0.25), transparent 55%),\n    linear-gradient(160deg, var(--felt-1), var(--felt-2));\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  padding: 24px;\n}\n\n/* --------------------------- Menú --------------------------- */\n\n.menu-hero {\n  text-align: center;\n  max-width: 520px;\n  width: 100%;\n}\n\n.menu-hero h1 {\n  color: white;\n  font-size: clamp(34px, 8vw, 54px);\n  letter-spacing: 1px;\n  text-shadow: 0 4px 0 rgba(0, 0, 0, 0.25);\n}\n.menu-hero .accent { color: var(--yellow); }\n\n.tagline {\n  color: rgba(255, 255, 255, 0.85);\n  margin: 10px 0 26px;\n  font-size: 17px;\n}\n\n.logo-card {\n  width: 150px;\n  height: 210px;\n  margin: 0 auto 22px;\n  background: var(--wild);\n  border-radius: 18px;\n  border: 5px solid white;\n  box-shadow: var(--shadow);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  transform: rotate(-6deg);\n  animation: float 4s ease-in-out infinite;\n}\n\n@keyframes float {\n  0%, 100% { transform: rotate(-6deg) translateY(0); }\n  50% { transform: rotate(-4deg) translateY(-10px); }\n}\n\n.logo-oval {\n  width: 120px;\n  height: 84px;\n  background: conic-gradient(from 45deg, var(--red) 0 25%, var(--yellow) 0 50%, var(--green) 0 75%, var(--blue) 0);\n  border-radius: 50%;\n  transform: rotate(-20deg);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  box-shadow: inset 0 0 0 4px rgba(255, 255, 255, 0.35);\n}\n\n.logo-text {\n  font-size: 44px;\n  font-weight: 900;\n  font-style: italic;\n  color: white;\n  text-shadow: 3px 3px 0 rgba(0, 0, 0, 0.35);\n  transform: rotate(20deg);\n}\n\n.menu-buttons {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  margin: 0 auto;\n  max-width: 360px;\n}\n\n.menu-badges {\n  margin-top: 26px;\n  display: flex;\n  flex-wrap: wrap;\n  gap: 8px;\n  justify-content: center;\n}\n\n.badge-pill {\n  background: rgba(255, 255, 255, 0.14);\n  color: white;\n  border: 1px solid rgba(255, 255, 255, 0.25);\n  padding: 6px 12px;\n  border-radius: 999px;\n  font-size: 12.5px;\n}\n\n/* --------------------------- Botones --------------------------- */\n\n.btn {\n  border: none;\n  cursor: pointer;\n  font-family: inherit;\n  font-weight: 800;\n  font-size: 16px;\n  color: white;\n  padding: 13px 22px;\n  border-radius: 14px;\n  box-shadow: 0 5px 0 rgba(0, 0, 0, 0.28);\n  transition: transform 0.08s ease, box-shadow 0.08s ease, filter 0.15s;\n}\n.btn:hover { filter: brightness(1.07); }\n.btn:active { transform: translateY(4px); box-shadow: 0 1px 0 rgba(0, 0, 0, 0.28); }\n.btn:disabled { opacity: 0.55; cursor: not-allowed; }\n\n.btn-big { font-size: 19px; padding: 16px 26px; }\n.btn-small { font-size: 14px; padding: 8px 14px; box-shadow: 0 3px 0 rgba(0, 0, 0, 0.25); }\n\n.btn-primary { background: var(--red); }\n.btn-blue { background: var(--blue); }\n.btn-green { background: var(--green); }\n.btn-yellow { background: var(--yellow); color: #4a3800; }\n.btn-red { background: #c31717; }\n\n.btn-ghost {\n  background: rgba(255, 255, 255, 0.12);\n  border: 2px solid rgba(255, 255, 255, 0.35);\n  box-shadow: none;\n  color: white;\n}\n.btn-ghost:active { transform: translateY(2px); }\n\n.btn-back {\n  background: none;\n  border: none;\n  color: rgba(255, 255, 255, 0.85);\n  font-size: 15px;\n  cursor: pointer;\n  font-weight: 700;\n  margin-bottom: 12px;\n  padding: 6px 0;\n}\n.btn-back:hover { color: white; }\n\n/* --------------------------- Paneles --------------------------- */\n\n.panel {\n  background: rgba(255, 255, 255, 0.97);\n  border-radius: 22px;\n  padding: 28px;\n  width: 100%;\n  max-width: 460px;\n  box-shadow: var(--shadow);\n}\n\n.panel h2 { font-size: 26px; margin-bottom: 8px; }\n.panel h3 { margin: 18px 0 10px; font-size: 18px; }\n.hint { color: #5b6472; font-size: 14.5px; margin: 8px 0 14px; }\n\n.field { display: block; margin: 16px 0; }\n.field > span { display: block; font-weight: 800; margin-bottom: 8px; font-size: 14.5px; }\n\n.field input {\n  width: 100%;\n  padding: 13px 15px;\n  border-radius: 12px;\n  border: 2px solid #d7dce4;\n  font-size: 17px;\n  font-family: inherit;\n  outline: none;\n  transition: border-color 0.15s;\n}\n.field input:focus { border-color: var(--blue); }\n\n.code-input {\n  text-transform: uppercase;\n  letter-spacing: 8px;\n  font-size: 26px !important;\n  font-weight: 900;\n  text-align: center;\n}\n\n.segmented { display: flex; gap: 8px; }\n.seg {\n  flex: 1;\n  padding: 11px 0;\n  border-radius: 11px;\n  border: 2px solid #d7dce4;\n  background: white;\n  font-size: 17px;\n  font-weight: 800;\n  cursor: pointer;\n}\n.seg.active { background: var(--blue); border-color: var(--blue); color: white; }\n\n.names-grid { display: grid; gap: 10px; }\n\n.panel .btn { width: 100%; margin-top: 10px; }\n\n/* --------------------------- Lobby --------------------------- */\n\n.lobby-panel { text-align: center; }\n\n.room-code {\n  background: var(--ink);\n  color: var(--yellow);\n  padding: 4px 12px;\n  border-radius: 10px;\n  letter-spacing: 3px;\n}\n\n.share-code {\n  font-size: 52px;\n  font-weight: 900;\n  letter-spacing: 12px;\n  color: var(--blue);\n  margin: 10px 0;\n  font-family: 'Courier New', monospace;\n}\n\n.player-list {\n  list-style: none;\n  margin: 10px 0 16px;\n  text-align: left;\n}\n\n.player-list li {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 11px 14px;\n  background: #f1f4f8;\n  border-radius: 12px;\n  margin-bottom: 8px;\n  font-weight: 700;\n}\n\n.player-list .avatar {\n  width: 34px;\n  height: 34px;\n  border-radius: 50%;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  color: white;\n  font-weight: 900;\n  flex-shrink: 0;\n}\n\n.host-tag {\n  margin-left: auto;\n  font-size: 11.5px;\n  background: var(--yellow);\n  color: #4a3800;\n  padding: 3px 9px;\n  border-radius: 999px;\n  font-weight: 900;\n}\n\n.conn-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--green); }\n.conn-dot.off { background: #b7bec9; }\n\n/* ============================ MESA ============================ */\n\n#view-game {\n  display: flex;\n  flex-direction: column;\n  background: var(--felt-2);\n  overflow: hidden;\n}\n\n.game-header {\n  height: var(--header-h);\n  background: rgba(0, 0, 0, 0.35);\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  padding: 0 14px;\n  flex-shrink: 0;\n}\n\n.brand-mini { display: flex; align-items: center; gap: 8px; }\n\n.logo-mini {\n  width: 38px;\n  height: 52px;\n  background: var(--red);\n  border-radius: 7px;\n  border: 2px solid white;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  transform: rotate(-8deg);\n}\n.logo-mini span {\n  font-size: 11px;\n  font-weight: 900;\n  font-style: italic;\n  color: white;\n  transform: rotate(8deg);\n}\n\n.room-tag {\n  color: rgba(255, 255, 255, 0.9);\n  font-size: 12.5px;\n  font-weight: 800;\n  letter-spacing: 1px;\n  background: rgba(255, 255, 255, 0.14);\n  padding: 5px 10px;\n  border-radius: 999px;\n}\n\n.scoreboard {\n  flex: 1;\n  display: flex;\n  gap: 10px;\n  overflow-x: auto;\n  scrollbar-width: none;\n}\n.scoreboard::-webkit-scrollbar { display: none; }\n\n.score-chip {\n  display: flex;\n  align-items: center;\n  gap: 7px;\n  color: white;\n  font-size: 13px;\n  background: rgba(255, 255, 255, 0.12);\n  padding: 5px 11px;\n  border-radius: 999px;\n  white-space: nowrap;\n}\n.score-chip b { color: var(--yellow); }\n.score-chip .turn-ring {\n  width: 10px; height: 10px; border-radius: 50%;\n  border: 2px solid var(--yellow);\n  box-shadow: 0 0 8px var(--yellow);\n}\n\n.header-actions { display: flex; gap: 6px; }\n\n/* ---- Felt ---- */\n\n.table-felt {\n  flex: 1;\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  background:\n    radial-gradient(120% 90% at 50% 20%, rgba(255, 255, 255, 0.10), transparent 55%),\n    radial-gradient(140% 110% at 50% 110%, rgba(0, 0, 0, 0.35), transparent 60%),\n    linear-gradient(170deg, var(--felt-1), var(--felt-2));\n  overflow: hidden;\n}\n\n/* ---- Rivales ---- */\n\n.opponents {\n  display: flex;\n  justify-content: center;\n  gap: 14px;\n  padding: 12px 10px 4px;\n  flex-wrap: wrap;\n  flex-shrink: 0;\n}\n\n.opp {\n  background: rgba(0, 0, 0, 0.22);\n  border: 2px solid transparent;\n  border-radius: 14px;\n  padding: 8px 12px;\n  min-width: 108px;\n  text-align: center;\n  transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;\n}\n.opp.active {\n  border-color: var(--yellow);\n  box-shadow: 0 0 22px rgba(245, 189, 2, 0.55);\n  transform: translateY(2px);\n}\n\n.opp-name {\n  color: white;\n  font-size: 13px;\n  font-weight: 800;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  max-width: 120px;\n}\n.opp-name .said { color: var(--yellow); font-size: 11px; }\n\n.opp-cards {\n  display: flex;\n  justify-content: center;\n  align-items: center;\n  height: 40px;\n  margin-bottom: 5px;\n}\n\n.mini-card {\n  width: 26px;\n  height: 38px;\n  border-radius: 5px;\n  background: #101018;\n  border: 2px solid #f2f2f2;\n  margin-left: -16px;\n  box-shadow: 1px 2px 4px rgba(0, 0, 0, 0.4);\n  position: relative;\n}\n.mini-card:first-child { margin-left: 0; }\n.mini-card::after {\n  content: 'U';\n  position: absolute;\n  inset: 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  color: var(--red);\n  font-weight: 900;\n  font-style: italic;\n  font-size: 13px;\n}\n\n.opp-count {\n  color: var(--yellow);\n  font-size: 12px;\n  font-weight: 900;\n}\n\n/* ---- Centro ---- */\n\n.table-center {\n  flex: 1;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 12px;\n  min-height: 0;\n  padding: 6px;\n}\n\n.turn-banner {\n  color: white;\n  font-size: 17px;\n  font-weight: 800;\n  background: rgba(0, 0, 0, 0.28);\n  padding: 8px 18px;\n  border-radius: 999px;\n  text-align: center;\n}\n.turn-banner .dir { font-size: 15px; opacity: 0.9; }\n\n.piles {\n  display: flex;\n  align-items: center;\n  gap: 26px;\n  position: relative;\n}\n\n.pile-wrap { text-align: center; }\n\n.pile-count, .pile-label {\n  margin-top: 7px;\n  color: rgba(255, 255, 255, 0.85);\n  font-size: 13px;\n  font-weight: 800;\n}\n\n.discard-slot {\n  width: var(--card-w);\n  height: var(--card-h);\n  position: relative;\n}\n.discard-slot .card {\n  position: absolute;\n  inset: 0;\n}\n.discard-slot .card:nth-child(1) { transform: rotate(-4deg); }\n.discard-slot .card:nth-child(2) { transform: rotate(3deg) scale(0.97); }\n.discard-slot .card:nth-child(3) { transform: rotate(-2deg) scale(0.94); }\n\n.color-indicator {\n  position: absolute;\n  right: -52px;\n  top: 50%;\n  transform: translateY(-50%);\n  width: 34px;\n  height: 34px;\n  border-radius: 50%;\n  border: 3px solid rgba(255, 255, 255, 0.85);\n  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);\n}\n\n.draw-banner {\n  background: linear-gradient(180deg, #ff9d00, #f45c00);\n  color: white;\n  font-weight: 900;\n  font-size: 15px;\n  padding: 10px 20px;\n  border-radius: 12px;\n  box-shadow: 0 6px 18px rgba(244, 92, 0, 0.5);\n  animation: shake 1.2s ease-in-out infinite;\n  text-align: center;\n}\n\n@keyframes shake {\n  0%, 100% { transform: rotate(-1deg); }\n  50% { transform: rotate(1deg); }\n}\n\n.uno-banner {\n  background: var(--yellow);\n  color: #4a3800;\n  font-weight: 900;\n  padding: 9px 18px;\n  border-radius: 12px;\n  font-size: 15px;\n  text-align: center;\n}\n\n/* ---- Cartas ---- */\n\n.card {\n  width: var(--card-w);\n  height: var(--card-h);\n  border-radius: 11px;\n  border: 4px solid #ffffff;\n  position: relative;\n  cursor: default;\n  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.35);\n  background: var(--cc, #333);\n  flex-shrink: 0;\n  overflow: hidden;\n  transition: transform 0.15s ease, box-shadow 0.15s ease;\n  color: var(--cc, #333);\n}\n\n.card.red { --cc: var(--red); }\n.card.yellow { --cc: var(--yellow); }\n.card.green { --cc: var(--green); }\n.card.blue { --cc: var(--blue); }\n.card.wild { --cc: var(--wild); }\n\n.card .oval {\n  position: absolute;\n  left: 6%;\n  top: 19%;\n  width: 88%;\n  height: 62%;\n  background: #fff;\n  border-radius: 50%;\n  transform: rotate(-22deg);\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);\n}\n\n.card.wild .oval {\n  background: conic-gradient(from 45deg, var(--red) 0 25%, var(--yellow) 0 50%, var(--green) 0 75%, var(--blue) 0);\n}\n\n.card .big {\n  position: absolute;\n  inset: 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-size: 52px;\n  font-weight: 900;\n  font-style: italic;\n  z-index: 2;\n  color: var(--cc);\n  text-shadow: 2px 2px 0 rgba(0, 0, 0, 0.12);\n}\n.card.wild .big { color: #fff; text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.55); font-size: 34px; }\n.card.yellow .big, .card.yellow .corner { color: #8a6d00; text-shadow: none; }\n\n.card .corner {\n  position: absolute;\n  font-size: 17px;\n  font-weight: 900;\n  font-style: italic;\n  color: #fff;\n  z-index: 3;\n  opacity: 0.95;\n}\n.card.yellow .corner { color: #8a6d00; }\n.card .corner.tl { top: 5px; left: 7px; }\n.card .corner.br { bottom: 5px; right: 7px; transform: rotate(180deg); }\n\n.card .icon {\n  width: 44px;\n  height: 44px;\n  color: var(--cc);\n}\n.card.wild .icon { color: #fff; }\n.card.yellow .icon { color: #8a6d00; }\n\n/* Carta jugable */\n.card.playable {\n  cursor: pointer;\n  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.85), 0 10px 22px rgba(0, 0, 0, 0.45);\n}\n.card.playable:hover {\n  transform: translateY(-16px) scale(1.05);\n  z-index: 30;\n}\n.card.dim { opacity: 0.62; filter: saturate(0.75); }\n\n/* Reverso / mazo */\n.card.back {\n  background: #101018;\n  border-color: #fff;\n  cursor: pointer;\n}\n.card.back:hover { transform: translateY(-6px); }\n\n.card.back.empty {\n  opacity: 0.35;\n  cursor: default;\n  background: transparent;\n  border-style: dashed;\n}\n.card.back.empty:hover { transform: none; }\n.card.back.empty .card-back-inner {\n  background: rgba(255, 255, 255, 0.08);\n  border: 1px dashed rgba(255, 255, 255, 0.35);\n}\n.card.back.empty .card-back-inner span {\n  color: rgba(255, 255, 255, 0.75);\n  transform: none;\n  font-size: 30px;\n  text-shadow: none;\n}\n\n.card-back-inner {\n  position: absolute;\n  inset: 9px;\n  border-radius: 8px;\n  background: linear-gradient(145deg, #23232e, #0d0d14);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n.card-back-inner span {\n  font-size: 22px;\n  font-weight: 900;\n  font-style: italic;\n  color: var(--red);\n  transform: rotate(-22deg);\n  text-shadow: 2px 2px 0 rgba(255, 255, 255, 0.2);\n}\n\n/* ---- Mi zona ---- */\n\n.my-area {\n  flex-shrink: 0;\n  background: linear-gradient(180deg, rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0.42));\n  padding: 8px 12px 14px;\n}\n\n.my-name-row {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  color: white;\n  font-weight: 900;\n  font-size: 15px;\n  margin-bottom: 8px;\n  padding-left: 6px;\n}\n\n.turn-dot {\n  background: var(--yellow);\n  color: #4a3800;\n  font-size: 11.5px;\n  padding: 3px 10px;\n  border-radius: 999px;\n  animation: blink 1.2s ease-in-out infinite;\n}\n@keyframes blink {\n  0%, 100% { opacity: 1; }\n  50% { opacity: 0.55; }\n}\n\n.my-hand {\n  display: flex;\n  justify-content: center;\n  align-items: flex-end;\n  min-height: calc(var(--card-h) + 22px);\n  padding: 16px 4px 4px;\n  overflow-x: auto;\n  scrollbar-width: thin;\n}\n\n.my-hand .card {\n  margin-left: -20px;\n}\n.my-hand .card:first-child { margin-left: 0; }\n.my-hand .card.playable:hover { margin-top: -2px; }\n\n.action-row {\n  display: flex;\n  justify-content: center;\n  gap: 12px;\n  margin-top: 12px;\n  flex-wrap: wrap;\n  min-height: 52px;\n}\n\n.pulse {\n  animation: pulse 1s ease-in-out infinite;\n}\n@keyframes pulse {\n  0%, 100% { transform: scale(1); box-shadow: 0 5px 0 rgba(0, 0, 0, 0.28), 0 0 0 0 rgba(245, 189, 2, 0.7); }\n  50% { transform: scale(1.06); box-shadow: 0 5px 0 rgba(0, 0, 0, 0.28), 0 0 0 16px rgba(245, 189, 2, 0); }\n}\n\n/* ---- Registro ---- */\n\n.game-log {\n  position: absolute;\n  top: 10px;\n  right: 10px;\n  width: 250px;\n  max-height: 200px;\n  background: rgba(0, 0, 0, 0.42);\n  border-radius: 12px;\n  padding: 10px;\n  color: white;\n  display: flex;\n  flex-direction: column;\n}\n\n.log-title {\n  font-size: 12.5px;\n  font-weight: 900;\n  opacity: 0.8;\n  margin-bottom: 6px;\n  letter-spacing: 1px;\n}\n\n.log-entries {\n  overflow-y: auto;\n  scrollbar-width: thin;\n  font-size: 12.5px;\n  line-height: 1.5;\n}\n.log-entries .entry { padding: 2px 0; opacity: 0.92; }\n.log-entries .entry.danger { color: #ff9c9c; font-weight: 700; }\n.log-entries .entry.uno { color: var(--yellow); font-weight: 800; }\n.log-entries .entry.win { color: #8dffb0; font-weight: 800; }\n\n/* --------------------------- Overlays --------------------------- */\n\n.overlay {\n  position: fixed;\n  inset: 0;\n  background: rgba(8, 12, 18, 0.72);\n  backdrop-filter: blur(4px);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  z-index: 100;\n  padding: 18px;\n}\n\n.overlay-card {\n  background: white;\n  border-radius: 22px;\n  padding: 30px 26px;\n  width: 100%;\n  max-width: 430px;\n  text-align: center;\n  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);\n  animation: pop 0.22s ease-out;\n}\n\n@keyframes pop {\n  from { transform: scale(0.92); opacity: 0; }\n  to { transform: scale(1); opacity: 1; }\n}\n\n.overlay-card h2 { margin-bottom: 14px; }\n.overlay-card .btn { width: 100%; margin-top: 12px; }\n\n.pass-icon { font-size: 54px; margin-bottom: 8px; }\n\n.color-picker {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 14px;\n  margin-top: 10px;\n}\n\n.color-btn {\n  height: 92px;\n  border-radius: 16px;\n  border: none;\n  background: var(--c);\n  color: white;\n  font-size: 19px;\n  font-weight: 900;\n  cursor: pointer;\n  box-shadow: 0 6px 0 rgba(0, 0, 0, 0.25);\n  transition: transform 0.1s;\n  text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.35);\n}\n.color-btn:active { transform: translateY(4px); box-shadow: 0 1px 0 rgba(0, 0, 0, 0.25); }\n\n.rules-card { max-width: 560px; text-align: left; }\n.rules-scroll {\n  max-height: 55vh;\n  overflow-y: auto;\n  padding-right: 8px;\n  margin: 8px 0 12px;\n  font-size: 14.5px;\n  line-height: 1.65;\n}\n.rules-scroll h3 { margin: 14px 0 6px; color: var(--blue); }\n.rules-scroll ul { padding-left: 20px; }\n.rules-card .btn { margin-top: 4px; }\n\n.round-scores {\n  margin: 12px 0;\n  text-align: left;\n}\n.round-scores .row {\n  display: flex;\n  justify-content: space-between;\n  padding: 9px 12px;\n  background: #f1f4f8;\n  border-radius: 10px;\n  margin-bottom: 7px;\n  font-weight: 700;\n  font-size: 15px;\n}\n.round-scores .row.winner { background: #e4f8ea; color: #136e33; }\n.round-scores .row b { color: var(--blue); }\n\n/* --------------------------- Toast --------------------------- */\n\n.toast {\n  position: fixed;\n  left: 50%;\n  bottom: 110px;\n  transform: translateX(-50%) translateY(20px);\n  background: #222a36;\n  color: white;\n  padding: 12px 20px;\n  border-radius: 12px;\n  font-weight: 700;\n  font-size: 14.5px;\n  opacity: 0;\n  transition: opacity 0.25s, transform 0.25s;\n  z-index: 200;\n  max-width: 86vw;\n  text-align: center;\n  box-shadow: var(--shadow);\n}\n.toast.show {\n  opacity: 1;\n  transform: translateX(-50%) translateY(0);\n}\n\n/* --------------------------- Responsive --------------------------- */\n\n@media (max-width: 760px) {\n  :root {\n    --card-w: 72px;\n    --card-h: 108px;\n  }\n  .card .big { font-size: 40px; }\n  .card.wild .big { font-size: 26px; }\n  .card .corner { font-size: 13px; }\n  .my-hand .card { margin-left: -16px; }\n\n  .game-log {\n    width: 132px;\n    max-height: 74px;\n    font-size: 10px;\n    top: 4px;\n    right: 4px;\n    padding: 6px;\n  }\n  .log-title { font-size: 9.5px; margin-bottom: 3px; }\n  .log-entries { line-height: 1.35; }\n  .opponents { gap: 8px; padding-top: 8px; }\n  .opp { min-width: 88px; padding: 6px 8px; }\n  .opp-name { font-size: 11.5px; max-width: 92px; }\n  .color-indicator {\n    position: static;\n    transform: none;\n    margin-left: 8px;\n    width: 28px;\n    height: 28px;\n  }\n  .piles { gap: 18px; }\n  .turn-banner { font-size: 14px; padding: 6px 12px; }\n  .btn-big { font-size: 16px; padding: 13px 18px; }\n  .share-code { font-size: 40px; letter-spacing: 8px; }\n}\n\n@media (max-height: 620px) {\n  .table-center { gap: 6px; }\n  .my-hand { min-height: calc(var(--card-h) + 10px); padding-top: 10px; }\n}\n",
  '/app.js': "/* ============================================================\n   UNO Multijugador — Interfaz y lógica de cliente\n   Modos: local (pasar dispositivo) y en línea (código de sala)\n   ============================================================ */\n\nimport * as engine from './game.js';\n\n/* --------------------------- Estado --------------------------- */\n\nconst app = {\n  mode: null, // 'local' | 'online'\n  payload: null,\n  sound: true,\n  unoTick: null,\n  local: {\n    game: null,\n    names: [],\n    round: 1,\n    viewer: null,\n    awaitingPass: false,\n    timer: null,\n    count: 2,\n  },\n  online: {\n    code: null,\n    playerId: null,\n    name: null,\n    es: null,\n    reconnecting: false,\n  },\n};\n\nconst $ = (id) => document.getElementById(id);\nconst VIEWS = ['view-menu', 'view-local', 'view-create', 'view-join', 'view-lobby', 'view-game'];\n\nfunction setView(name) {\n  for (const v of VIEWS) $(v).classList.toggle('hidden', v !== name);\n}\n\n/* --------------------------- Sonido --------------------------- */\n\nlet audioCtx = null;\nfunction beep(freq, dur = 0.08, type = 'triangle', vol = 0.18) {\n  if (!app.sound) return;\n  try {\n    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();\n    const o = audioCtx.createOscillator();\n    const g = audioCtx.createGain();\n    o.type = type;\n    o.frequency.value = freq;\n    g.gain.value = vol;\n    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);\n    o.connect(g).connect(audioCtx.destination);\n    o.start();\n    o.stop(audioCtx.currentTime + dur);\n  } catch { /* sin audio */ }\n}\nconst sndPlay = () => beep(520, 0.07);\nconst sndDraw = () => beep(300, 0.09, 'square', 0.1);\nconst sndUno = () => { beep(660, 0.1); setTimeout(() => beep(880, 0.14), 110); };\nconst sndWin = () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 0.16), i * 130));\nconst sndError = () => beep(160, 0.16, 'sawtooth', 0.12);\n\n/* --------------------------- Toast --------------------------- */\n\nlet toastTimer = null;\nfunction toast(msg, ms = 2600) {\n  const el = $('toast');\n  el.textContent = msg;\n  el.classList.remove('hidden');\n  requestAnimationFrame(() => el.classList.add('show'));\n  clearTimeout(toastTimer);\n  toastTimer = setTimeout(() => {\n    el.classList.remove('show');\n    setTimeout(() => el.classList.add('hidden'), 300);\n  }, ms);\n}\n\n/* --------------------------- Cartas --------------------------- */\n\nconst SKIP_SVG = `<svg class=\"icon\" viewBox=\"0 0 100 100\" aria-hidden=\"true\"><circle cx=\"50\" cy=\"50\" r=\"33\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"12\"/><line x1=\"25\" y1=\"75\" x2=\"75\" y2=\"25\" stroke=\"currentColor\" stroke-width=\"12\" stroke-linecap=\"round\"/></svg>`;\nconst REV_SVG = `<svg class=\"icon\" viewBox=\"0 0 100 100\" aria-hidden=\"true\"><polygon points=\"14,26 52,26 52,12 88,34 52,56 52,42 14,42\" fill=\"currentColor\"/><polygon points=\"86,74 48,74 48,88 12,66 48,44 48,58 86,58\" fill=\"currentColor\"/></svg>`;\n\nfunction cornerLabel(card) {\n  switch (card.kind) {\n    case 'number': return String(card.value);\n    case 'skip': return '⊘';\n    case 'reverse': return '⇄';\n    case 'draw2': return '+2';\n    case 'wild': return '★';\n    case 'draw4': return '+4';\n    default: return '';\n  }\n}\n\nfunction cardHTML(card, opts = {}) {\n  const classes = ['card', card.color];\n  if (opts.playable) classes.push('playable');\n  if (opts.dim) classes.push('dim');\n  const attrs = `class=\"${classes.join(' ')}\" data-id=\"${card.id}\" ${opts.title ? `title=\"${opts.title}\"` : ''}`;\n\n  let center;\n  if (card.kind === 'number') {\n    center = `<div class=\"oval\"></div>\n      <span class=\"corner tl\">${card.value}</span>\n      <span class=\"big\">${card.value}</span>\n      <span class=\"corner br\">${card.value}</span>`;\n  } else if (card.kind === 'skip') {\n    center = `<div class=\"oval\"></div>\n      <span class=\"corner tl\">⊘</span>\n      ${SKIP_SVG}\n      <span class=\"corner br\">⊘</span>`;\n  } else if (card.kind === 'reverse') {\n    center = `<div class=\"oval\"></div>\n      <span class=\"corner tl\">⇄</span>\n      ${REV_SVG}\n      <span class=\"corner br\">⇄</span>`;\n  } else if (card.kind === 'draw2') {\n    center = `<div class=\"oval\"></div>\n      <span class=\"corner tl\">+2</span>\n      <span class=\"big\">+2</span>\n      <span class=\"corner br\">+2</span>`;\n  } else if (card.kind === 'draw4') {\n    center = `<div class=\"oval\"></div>\n      <span class=\"corner tl\">+4</span>\n      <span class=\"big\">+4</span>\n      <span class=\"corner br\">+4</span>`;\n  } else {\n    center = `<div class=\"oval\"></div>\n      <span class=\"corner tl\">★</span>\n      <span class=\"big\">★</span>\n      <span class=\"corner br\">★</span>`;\n  }\n  return `<div ${attrs}>${center}</div>`;\n}\n\nfunction cardBackHTML() {\n  return `<div class=\"card back\"><div class=\"card-back-inner\"><span>UNO</span></div></div>`;\n}\n\n/* --------------------------- API en línea --------------------------- */\n\nasync function api(path, body) {\n  try {\n    const res = await fetch(path, {\n      method: body ? 'POST' : 'GET',\n      headers: { 'Content-Type': 'application/json' },\n      body: body ? JSON.stringify(body) : undefined,\n    });\n    const data = await res.json().catch(() => ({ ok: false, error: 'Error de conexión' }));\n    return data;\n  } catch {\n    return { ok: false, error: 'Sin conexión con el servidor' };\n  }\n}\n\nfunction saveSession() {\n  try {\n    localStorage.setItem('uno-session', JSON.stringify(app.online));\n  } catch { /* sin storage */ }\n}\nfunction clearSession() {\n  try { localStorage.removeItem('uno-session'); } catch { /* sin storage */ }\n}\n\n/* Long-polling: funciona a través de cualquier proxy, CDN o red móvil */\nlet pollRunning = false;\nlet lastVersion = 0;\n\nfunction connectSSE() {\n  // (se usaba EventSource; ahora long-polling, compatible con todos los proxies)\n  startPolling();\n}\n\nfunction startPolling() {\n  pollRunning = true;\n  lastVersion = 0;\n  pollLoop();\n}\n\nasync function pollLoop() {\n  while (pollRunning && app.mode === 'online' && app.online.code) {\n    try {\n      const url = `/api/poll?code=${encodeURIComponent(app.online.code)}&playerId=${encodeURIComponent(app.online.playerId)}&after=${lastVersion}`;\n      const res = await fetch(url);\n      if (res.status === 404) {\n        const data = await res.json().catch(() => ({}));\n        toast(data.error || 'La sesión de la sala terminó');\n        leaveOnline();\n        return;\n      }\n      const data = await res.json();\n      if (!pollRunning || app.mode !== 'online' || !app.online.code) return; // salió mientras esperaba\n      if (!data.ok && data.error === 'out') {\n        toast('Saliste de la sala');\n        leaveOnline();\n        return;\n      }\n      if (data.ok && typeof data.version === 'number') lastVersion = data.version;\n      if (data.ok && data.payload) {\n        app.online.reconnecting = false;\n        handleState(data.payload);\n      }\n    } catch {\n      if (!app.online.reconnecting) {\n        app.online.reconnecting = true;\n        toast('📡 Reconectando con la sala…', 3000);\n      }\n      await new Promise((r) => setTimeout(r, 1500));\n      continue;\n    }\n    await new Promise((r) => setTimeout(r, 200));\n  }\n  pollRunning = false;\n}\n\nfunction handleState(payload) {\n  app.payload = payload;\n  if (!payload.game) {\n    renderLobby(payload);\n    setView('view-lobby');\n    return;\n  }\n  setView('view-game');\n  renderGame(payload);\n}\n\n/* --------------------------- Menú --------------------------- */\n\n$('btn-go-local').addEventListener('click', () => {\n  app.mode = 'local';\n  renderNameFields();\n  setView('view-local');\n});\n$('btn-go-create').addEventListener('click', () => setView('view-create'));\n$('btn-go-join').addEventListener('click', () => setView('view-join'));\n$('btn-rules-menu').addEventListener('click', () => $('overlay-rules').classList.remove('hidden'));\n$('btn-close-rules').addEventListener('click', () => $('overlay-rules').classList.add('hidden'));\n$('btn-rules-game').addEventListener('click', () => $('overlay-rules').classList.remove('hidden'));\n\ndocument.querySelectorAll('[data-back]').forEach((b) =>\n  b.addEventListener('click', () => {\n    app.mode = null;\n    setView('view-menu');\n  })\n);\n\n$('btn-sound').addEventListener('click', () => {\n  app.sound = !app.sound;\n  $('btn-sound').textContent = app.sound ? '🔊' : '🔇';\n  if (app.sound) sndPlay();\n});\n\n/* --------------------------- Local --------------------------- */\n\n$('local-count').addEventListener('click', (e) => {\n  const btn = e.target.closest('.seg');\n  if (!btn) return;\n  app.local.count = Number(btn.dataset.n);\n  document.querySelectorAll('#local-count .seg').forEach((s) => s.classList.toggle('active', s === btn));\n  renderNameFields();\n});\n\nfunction renderNameFields() {\n  const wrap = $('local-names');\n  wrap.innerHTML = '';\n  for (let i = 0; i < app.local.count; i++) {\n    const input = document.createElement('input');\n    input.type = 'text';\n    input.maxLength = 20;\n    input.placeholder = `Jugador ${i + 1}`;\n    input.value = i < app.local.names.length ? app.local.names[i] : '';\n    input.addEventListener('input', () => { app.local.names[i] = input.value; });\n    wrap.appendChild(input);\n  }\n}\n\n$('btn-start-local').addEventListener('click', () => {\n  const names = [];\n  for (let i = 0; i < app.local.count; i++) {\n    names.push((app.local.names[i] || '').trim() || `Jugador ${i + 1}`);\n  }\n  app.mode = 'local';\n  app.local.names = names;\n  app.local.round = 1;\n  app.local.game = engine.createGame(names);\n  app.local.viewer = 0;\n  app.local.awaitingPass = true;\n  sndPlay();\n  setView('view-game');\n  renderGame(localPayload());\n});\n\nfunction localPayload() {\n  const g = app.local.game;\n  const viewer = app.local.viewer ?? g.current;\n  return {\n    mode: 'local',\n    room: { code: 'LOCAL', hostId: 'p0', inMatch: true, round: app.local.round },\n    players: g.players.map((p, i) => ({\n      id: 'p' + i,\n      name: p.name,\n      connected: true,\n      isHost: i === 0,\n    })),\n    you: {\n      playerId: 'p' + viewer,\n      index: viewer,\n      name: g.players[viewer].name,\n      isHost: true,\n    },\n    game: engine.sanitize(g, viewer),\n    serverTime: Date.now(),\n  };\n}\n\nfunction afterLocalAction(prevCurrent) {\n  const g = app.local.game;\n  if (g.phase === 'colorPick') {\n    // El mismo jugador elige color: sin pasar el dispositivo\n  } else if (g.unoWindow && g.unoWindow.playerIdx === app.local.viewer) {\n    // El jugador debe decir UNO antes de pasar el dispositivo\n  } else if (g.phase === 'gameOver') {\n    app.local.awaitingPass = false;\n  } else if (g.current !== app.local.viewer) {\n    app.local.awaitingPass = true;\n  }\n  syncLocalTimers();\n  renderGame(localPayload());\n}\n\nfunction syncLocalTimers() {\n  const g = app.local.game;\n  if (!g) return;\n  if (app.local.timer && !g.unoWindow) {\n    clearTimeout(app.local.timer);\n    app.local.timer = null;\n  }\n  if (g.unoWindow && !app.local.timer) {\n    const ms = Math.max(50, g.unoWindow.expires - Date.now());\n    app.local.timer = setTimeout(() => {\n      app.local.timer = null;\n      engine.expireUnoWindow(g);\n      if (g.unoWindow === null && g.current !== app.local.viewer) {\n        app.local.awaitingPass = true;\n      }\n      renderGame(localPayload());\n    }, ms);\n  }\n}\n\n$('btn-pass-ready').addEventListener('click', () => {\n  const g = app.local.game;\n  app.local.awaitingPass = false;\n  app.local.viewer = g.current;\n  sndPlay();\n  renderGame(localPayload());\n});\n\n/* --------------------------- En línea --------------------------- */\n\n$('btn-create-room').addEventListener('click', async () => {\n  const name = $('create-name').value.trim();\n  if (!name) return toast('Escribe tu nombre');\n  const res = await api('/api/create', { name });\n  if (!res.ok) return toast(res.error || 'No se pudo crear la sala');\n  app.mode = 'online';\n  app.online.code = res.code;\n  app.online.playerId = res.playerId;\n  app.online.name = res.name;\n  saveSession();\n  connectSSE();\n});\n\n$('btn-join-room').addEventListener('click', async () => {\n  const code = $('join-code').value.trim().toUpperCase();\n  const name = $('join-name').value.trim();\n  if (code.length < 4) return toast('Escribe el código de la sala');\n  if (!name) return toast('Escribe tu nombre');\n  const res = await api('/api/join', { code, name });\n  if (!res.ok) return toast(res.error || 'No se pudo unir');\n  app.mode = 'online';\n  app.online.code = res.code;\n  app.online.playerId = res.playerId;\n  app.online.name = res.name;\n  saveSession();\n  connectSSE();\n});\n\n$('btn-copy-code').addEventListener('click', async () => {\n  const code = app.payload?.room?.code || app.online.code;\n  try {\n    await navigator.clipboard.writeText(code);\n    toast('📋 Código copiado');\n  } catch {\n    toast(`Código: ${code}`);\n  }\n});\n\n$('btn-start-online').addEventListener('click', async () => {\n  const res = await api('/api/action', {\n    action: 'start',\n    code: app.online.code,\n    playerId: app.online.playerId,\n  });\n  if (!res.ok) toast(res.error || 'No se pudo iniciar');\n  else sndPlay();\n});\n\n$('btn-leave-lobby').addEventListener('click', () => leaveOnline());\n$('btn-leave-game').addEventListener('click', () => {\n  if (app.mode === 'online') leaveOnline();\n  else {\n    app.local.game = null;\n    app.mode = null;\n    setView('view-menu');\n  }\n});\n\nfunction leaveOnline() {\n  pollRunning = false;\n  if (app.online.code && app.online.playerId) {\n    api('/api/action', {\n      action: 'leave',\n      code: app.online.code,\n      playerId: app.online.playerId,\n    }).catch(() => {});\n  }\n  if (app.online.es) {\n    try { app.online.es.close(); } catch { /* nada */ }\n    app.online.es = null;\n  }\n  app.online.code = null;\n  app.online.playerId = null;\n  app.payload = null;\n  app.mode = null;\n  clearSession();\n  setView('view-menu');\n}\n\nasync function onlineAction(action, extra = {}) {\n  const res = await api('/api/action', {\n    action,\n    code: app.online.code,\n    playerId: app.online.playerId,\n    ...extra,\n  });\n  if (!res.ok) {\n    toast(res.error || 'Acción no permitida');\n    sndError();\n  }\n  return res;\n}\n\n/* --------------------------- Lobby --------------------------- */\n\nfunction renderLobby(payload) {\n  $('lobby-code').textContent = payload.room.code;\n  $('lobby-share').textContent = payload.room.code;\n\n  const list = $('lobby-players');\n  list.innerHTML = '';\n  for (const p of payload.players) {\n    const li = document.createElement('li');\n    const hue = (p.name.charCodeAt(0) * 37) % 360;\n    li.innerHTML = `\n      <div class=\"avatar\" style=\"background:hsl(${hue},60%,45%)\">${p.name[0].toUpperCase()}</div>\n      <span>${escapeHTML(p.name)}${p.id === payload.you.playerId ? ' (tú)' : ''}</span>\n      <div class=\"conn-dot ${p.connected ? '' : 'off'}\" title=\"${p.connected ? 'Conectado' : 'Desconectado'}\"></div>\n      ${p.isHost ? '<span class=\"host-tag\">ANFITRIÓN</span>' : ''}`;\n    list.appendChild(li);\n  }\n\n  const isHost = payload.you.isHost;\n  $('btn-start-online').classList.toggle('hidden', !isHost);\n  $('btn-start-online').disabled = payload.players.length < 2;\n  $('lobby-waiting').textContent = isHost\n    ? payload.players.length < 2\n      ? 'Necesitas al menos 2 jugadores para empezar.'\n      : 'Cuando todos estén listos, inicia la partida.'\n    : 'Esperando a que el anfitrión inicie la partida…';\n}\n\nfunction escapeHTML(s) {\n  return String(s).replace(/[&<>\"']/g, (c) => ({\n    '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;',\n  }[c]));\n}\n\n/* --------------------------- Mesa --------------------------- */\n\nfunction renderGame(payload) {\n  const g = payload.game;\n  if (!g) return;\n\n  app.payload = payload;\n  const me = payload.you.index;\n  const myTurn = g.current === me && g.phase !== 'gameOver' && g.phase !== 'colorPick';\n\n  // Cabecera\n  $('game-room-tag').textContent = payload.mode === 'local' ? `LOCAL · RONDA ${payload.room.round}` : `SALA ${payload.room.code}`;\n\n  const board = $('scoreboard');\n  board.innerHTML = payload.players.map((p, i) => `\n    <div class=\"score-chip\">\n      ${i === g.current && g.phase !== 'gameOver' ? '<div class=\"turn-ring\"></div>' : ''}\n      <span>${escapeHTML(p.name)}</span>\n      <b>${g.scores[i] ?? 0}</b>\n    </div>`).join('');\n\n  // Rivales\n  const oppWrap = $('opponents');\n  oppWrap.innerHTML = payload.players.map((p, i) => {\n    if (i === me) return '';\n    const count = g.players[i].handCount;\n    const minis = Array.from({ length: Math.min(count, 7) }, () => '<div class=\"mini-card\"></div>').join('');\n    return `\n      <div class=\"opp ${i === g.current ? 'active' : ''}\">\n        <div class=\"opp-cards\">${minis}</div>\n        <div class=\"opp-name\">${escapeHTML(p.name)}${g.players[i].saidUno ? ' <span class=\"said\">¡UNO!</span>' : ''}</div>\n        <div class=\"opp-count\">${count} carta${count === 1 ? '' : 's'}</div>\n      </div>`;\n  }).join('');\n\n  // Centro\n  $('deck-count').textContent = g.deckCount > 0 ? `${g.deckCount} en el mazo` : 'Mazo vacío';\n  const deckEl = $('deck-pile');\n  if (g.deckCount > 0) {\n    deckEl.classList.remove('empty');\n    deckEl.innerHTML = '<div class=\"card-back-inner\"><span>UNO</span></div>';\n  } else {\n    deckEl.classList.add('empty');\n    deckEl.innerHTML = '<div class=\"card-back-inner\"><span>∅</span></div>';\n  }\n\n  const discardWrap = $('discard-pile');\n  discardWrap.innerHTML = (g.discard && g.discard.length ? g.discard : [g.topCard])\n    .filter(Boolean)\n    .map((c) => cardHTML(c))\n    .join('');\n\n  const colorHex = { red: '#e02b22', yellow: '#f5bd02', green: '#22a447', blue: '#1667d9', wild: '#1b1b20' };\n  $('color-indicator').style.background = colorHex[g.activeColor] || '#555';\n\n  const dir = g.direction === 1 ? '↻' : '↺';\n  const turnName = g.phase === 'gameOver'\n    ? '🏆 ¡Fin de la ronda!'\n    : g.phase === 'colorPick'\n      ? `🎨 ${escapeHTML(payload.players[g.pendingWild?.playerIdx ?? g.current].name)} elige color…`\n      : g.current === me\n        ? `${dir} ¡Es tu turno!`\n        : `${dir} Turno de ${escapeHTML(payload.players[g.current].name)}`;\n  $('turn-banner').innerHTML = turnBannerHTML(g, payload, me, dir, turnName);\n\n  // Banner de acumulado\n  const drawBanner = $('draw-banner');\n  if (g.pendingDraw > 0 && g.phase !== 'gameOver') {\n    drawBanner.classList.remove('hidden');\n    drawBanner.textContent = `🔥 ¡${g.pendingDraw} cartas acumuladas! Responde con +2 / +4 o róbalas`;\n  } else {\n    drawBanner.classList.add('hidden');\n  }\n\n  // Banner UNO\n  const unoBanner = $('uno-banner');\n  if (g.unoWindow) {\n    const name = payload.players[g.unoWindow.playerIdx].name;\n    unoBanner.classList.remove('hidden');\n    unoBanner.textContent = `⚡ ¡${escapeHTML(name)} tiene una carta!`;\n  } else {\n    unoBanner.classList.add('hidden');\n  }\n\n  // Mi mano\n  const hand = g.players[me].hand || [];\n  const handWrap = $('my-hand');\n  handWrap.innerHTML = hand.map((c) => {\n    const playable = myTurn && engine.canPlayCard(g, me, c);\n    return cardHTML(c, { playable, dim: myTurn && !playable, title: engine.cardLabel(c) });\n  }).join('');\n\n  $('my-name').textContent = `${payload.you.name} · ${g.players[me].handCount} carta${g.players[me].handCount === 1 ? '' : 's'}`;\n  $('my-turn-dot').classList.toggle('hidden', !myTurn);\n\n  // Botones de acción\n  const btnUno = $('btn-uno');\n  const btnCatch = $('btn-catch');\n  const btnDraw = $('btn-draw');\n  const btnPass = $('btn-pass');\n\n  const imTheUno = g.unoWindow && g.unoWindow.playerIdx === me;\n  btnUno.classList.toggle('hidden', !imTheUno);\n  btnCatch.classList.toggle('hidden', !(g.unoWindow && g.unoWindow.playerIdx !== me));\n\n  const canDraw = myTurn && g.phase === 'playing';\n  btnDraw.classList.toggle('hidden', !canDraw);\n\n  // \"Pasar\" solo si robaste una carta que SÍ se puede jugar.\n  // Si no tienes con qué jugar, el mazo sigue dando cartas: hay que seguir robando.\n  const justDrewMine = myTurn && g.justDrew && g.justDrew.playerIdx === me && g.justDrew.cardId;\n  const drawnCard = justDrewMine ? (g.players[me].hand || []).find((c) => c.id === g.justDrew.cardId) : null;\n  const drawnPlayable = drawnCard ? engine.canPlayCard(g, me, drawnCard) : false;\n  btnPass.classList.toggle('hidden', !(justDrewMine && drawnPlayable));\n\n  if (g.pendingDraw > 0) {\n    btnDraw.textContent = `🎲 Robar ${g.pendingDraw} cartas`;\n  } else if (justDrewMine && !drawnPlayable) {\n    btnDraw.textContent = '🎲 Seguir robando';\n  } else {\n    btnDraw.textContent = '🎲 Robar carta';\n  }\n\n  // Registro\n  const logWrap = $('log-entries');\n  logWrap.innerHTML = (g.log || []).map((e) =>\n    `<div class=\"entry ${e.cls || ''}\">${escapeHTML(e.text)}</div>`\n  ).join('');\n  logWrap.scrollTop = logWrap.scrollHeight;\n\n  // Overlay de fin de ronda\n  const roundOverlay = $('overlay-round');\n  if (g.phase === 'gameOver') {\n    roundOverlay.classList.remove('hidden');\n    const winner = payload.players[g.winner];\n    $('round-title').textContent = `🏆 ¡${winner.name} gana la ronda!`;\n    $('round-scores').innerHTML = payload.players.map((p, i) => `\n      <div class=\"row ${i === g.winner ? 'winner' : ''}\">\n        <span>${escapeHTML(p.name)}${i === g.winner && g.lastRoundPoints ? ` · +${g.lastRoundPoints.points} pts` : ''}</span>\n        <b>${g.scores[i] ?? 0} pts</b>\n      </div>`).join('');\n    const btnNext = $('btn-next-round');\n    const isHost = payload.you.isHost !== false;\n    if (payload.mode === 'local' || isHost) {\n      btnNext.classList.remove('hidden');\n      btnNext.textContent = payload.mode === 'local' ? '🔁 Otra ronda' : '🔁 Otra ronda (anfitrión)';\n    } else {\n      btnNext.classList.add('hidden');\n    }\n  } else {\n    roundOverlay.classList.add('hidden');\n  }\n\n  // Overlay elegir color\n  const colorOverlay = $('overlay-color');\n  if (g.phase === 'colorPick' && g.pendingWild && g.pendingWild.playerIdx === me) {\n    colorOverlay.classList.remove('hidden');\n  } else {\n    colorOverlay.classList.add('hidden');\n  }\n\n  // Overlay pasar dispositivo (local)\n  const passOverlay = $('overlay-pass');\n  if (payload.mode === 'local' && app.local.awaitingPass && g.phase !== 'gameOver') {\n    passOverlay.classList.remove('hidden');\n    $('pass-title').textContent = `Pasa el dispositivo a ${payload.players[g.current].name}`;\n    $('pass-sub').textContent = `${payload.players[g.current].name}, cuando tengas el dispositivo toca el botón.`;\n  } else {\n    passOverlay.classList.add('hidden');\n  }\n\n  // Cuenta regresiva UNO\n  if (g.unoWindow) startUnoTick(g.unoWindow.expires);\n  else stopUnoTick();\n}\n\nfunction turnBannerHTML(g, payload, me, dir, turnName) {\n  return `<span>${turnName}</span>`;\n}\n\nfunction startUnoTick(expires) {\n  if (app.unoTick) return;\n  app.unoTick = setInterval(() => {\n    const g = app.payload && app.payload.game;\n    if (!g || !g.unoWindow) return stopUnoTick();\n    const left = Math.max(0, g.unoWindow.expires - Date.now());\n    const btn = $('btn-uno');\n    if (!btn.classList.contains('hidden')) {\n      btn.textContent = `¡UNO! (${Math.ceil(left / 1000)}s)`;\n    }\n  }, 250);\n}\nfunction stopUnoTick() {\n  if (app.unoTick) clearInterval(app.unoTick);\n  app.unoTick = null;\n}\n\n/* --------------------------- Acciones de juego --------------------------- */\n\n$('my-hand').addEventListener('click', (e) => {\n  const cardEl = e.target.closest('.card');\n  if (!cardEl) return;\n  const payload = app.payload;\n  if (!payload || !payload.game) return;\n  const g = payload.game;\n  const me = payload.you.index;\n  const card = (g.players[me].hand || []).find((c) => c.id === cardEl.dataset.id);\n  if (!card) return;\n\n  if (g.phase === 'colorPick') return toast('Primero elige un color');\n  if (g.current !== me) return toast('No es tu turno');\n  if (!engine.canPlayCard(g, me, card)) {\n    toast('Esa carta no coincide con la mesa');\n    sndError();\n    return;\n  }\n  if (card.kind === 'wild' || card.kind === 'draw4') {\n    openColorPicker(card.id);\n    return;\n  }\n  doPlay(card.id);\n});\n\n$('deck-pile').addEventListener('click', () => doDraw());\n\n$('btn-draw').addEventListener('click', () => doDraw());\n$('btn-pass').addEventListener('click', () => {\n  if (app.mode === 'local') {\n    const prev = app.local.game.current;\n    const r = engine.passTurn(app.local.game, app.local.viewer);\n    if (!r.ok) return toast(r.error);\n    afterLocalAction(prev);\n    sndPlay();\n  } else {\n    onlineAction('pass');\n  }\n});\n\n$('btn-uno').addEventListener('click', () => {\n  if (app.mode === 'local') {\n    const r = engine.declareUno(app.local.game, app.local.viewer);\n    if (!r.ok) return toast(r.error);\n    if (app.local.game.unoWindow === null && app.local.game.current !== app.local.viewer) {\n      app.local.awaitingPass = true;\n    }\n    sndUno();\n    renderGame(localPayload());\n  } else {\n    onlineAction('uno').then((r) => { if (r.ok) sndUno(); });\n  }\n});\n\n$('btn-catch').addEventListener('click', () => {\n  if (app.mode === 'local') {\n    const r = engine.catchUno(app.local.game, app.local.viewer);\n    if (!r.ok) return toast(r.error);\n    if (app.local.game.unoWindow === null && app.local.game.current !== app.local.viewer) {\n      app.local.awaitingPass = true;\n    }\n    sndError();\n    renderGame(localPayload());\n  } else {\n    onlineAction('catch').then((r) => { if (r.ok) sndError(); });\n  }\n});\n\n$('btn-next-round').addEventListener('click', async () => {\n  if (app.mode === 'local') {\n    app.local.round += 1;\n    app.local.game = engine.createGame(app.local.names, app.local.game.scores);\n    app.local.viewer = 0;\n    app.local.awaitingPass = true;\n    sndPlay();\n    renderGame(localPayload());\n  } else {\n    const r = await onlineAction('next-round');\n    if (r.ok) sndPlay();\n  }\n});\n\n$('btn-exit-round').addEventListener('click', () => {\n  if (app.mode === 'online') leaveOnline();\n  else {\n    app.local.game = null;\n    app.mode = null;\n    setView('view-menu');\n  }\n});\n\nfunction doPlay(cardId, color) {\n  if (app.mode === 'local') {\n    const g = app.local.game;\n    const me = app.local.viewer;\n    const r = engine.playCard(g, me, cardId);\n    if (!r.ok) { toast(r.error); sndError(); return; }\n    if (color && g.phase === 'colorPick') {\n      const r2 = engine.chooseColor(g, me, color);\n      if (!r2.ok) toast(r2.error);\n    }\n    sndPlay();\n    afterLocalAction(g.current);\n  } else {\n    onlineAction('play', { cardId, color }).then((r) => { if (r.ok) sndPlay(); });\n  }\n}\n\nfunction doDraw() {\n  const payload = app.payload;\n  if (!payload || !payload.game) return;\n  if (payload.game.current !== payload.you.index) return toast('No es tu turno');\n\n  if (app.mode === 'local') {\n    const prev = app.local.game.current;\n    const r = engine.drawAction(app.local.game, app.local.viewer);\n    if (!r.ok) { toast(r.error); sndError(); return; }\n    sndDraw();\n    afterLocalAction(prev);\n  } else {\n    onlineAction('draw').then((r) => { if (r.ok) sndDraw(); });\n  }\n}\n\n/* --------------------------- Selector de color --------------------------- */\n\nlet pendingColorCardId = null;\n\nfunction openColorPicker(cardId) {\n  pendingColorCardId = cardId;\n  $('overlay-color').classList.remove('hidden');\n}\n\ndocument.querySelector('.color-picker').addEventListener('click', (e) => {\n  const btn = e.target.closest('.color-btn');\n  if (!btn) return;\n  const color = btn.dataset.color;\n  $('overlay-color').classList.add('hidden');\n  if (pendingColorCardId) {\n    doPlay(pendingColorCardId, color);\n    pendingColorCardId = null;\n  } else if (app.payload?.game?.pendingWild) {\n    // Eligiendo color tras un comodín ya jugado (reconexión / modo en línea)\n    if (app.mode === 'local') {\n      const r = engine.chooseColor(app.local.game, app.local.viewer, color);\n      if (!r.ok) return toast(r.error);\n      afterLocalAction(app.local.game.current);\n    } else {\n      onlineAction('color', { color });\n    }\n  }\n});\n\n/* --------------------------- Arranque / reconexión --------------------------- */\n\nasync function tryRestoreSession() {\n  let saved = null;\n  try {\n    saved = JSON.parse(localStorage.getItem('uno-session') || 'null');\n  } catch { /* nada */ }\n  if (!saved || !saved.code || !saved.playerId) return;\n  const res = await api(`/api/state?code=${encodeURIComponent(saved.code)}&playerId=${encodeURIComponent(saved.playerId)}`);\n  if (res.ok && res.payload) {\n    app.mode = 'online';\n    app.online.code = saved.code;\n    app.online.playerId = saved.playerId;\n    app.online.name = saved.name;\n    connectSSE();\n    handleState(res.payload);\n    toast(`🔄 Sesión restaurada: sala ${saved.code}`);\n  } else {\n    clearSession();\n  }\n}\n\nrenderNameFields();\ntryRestoreSession();\n",
  '/game.js': "/* ============================================================\n   Motor del juego UNO — lógica pura compartida\n   Funciona tanto en el navegador (modo local) como en Node\n   (servidor de salas en línea). Sin dependencias.\n   ============================================================ */\n\nexport const COLORS = ['red', 'yellow', 'green', 'blue'];\n\nexport const COLOR_NAMES = {\n  red: 'rojo',\n  yellow: 'amarillo',\n  green: 'verde',\n  blue: 'azul',\n};\n\nexport const UNO_WINDOW_MS = 7000;\n\nconst COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };\nconst KIND_ORDER = { number: 0, skip: 1, reverse: 2, draw2: 3, wild: 4, draw4: 5 };\n\nlet cardCounter = 0;\nconst uid = () => 'c' + ++cardCounter;\n\n/* ---------------------------- Mazo ---------------------------- */\n\nexport function createDeck() {\n  const deck = [];\n  for (const color of COLORS) {\n    deck.push({ id: uid(), color, kind: 'number', value: 0 });\n    for (let v = 1; v <= 9; v++) {\n      deck.push({ id: uid(), color, kind: 'number', value: v });\n      deck.push({ id: uid(), color, kind: 'number', value: v });\n    }\n    for (const kind of ['skip', 'reverse', 'draw2']) {\n      deck.push({ id: uid(), color, kind, value: null });\n      deck.push({ id: uid(), color, kind, value: null });\n    }\n  }\n  for (let i = 0; i < 4; i++) {\n    deck.push({ id: uid(), color: 'wild', kind: 'wild', value: null });\n    deck.push({ id: uid(), color: 'wild', kind: 'draw4', value: null });\n  }\n  return deck; // 108 cartas\n}\n\nexport function shuffle(arr, rng = Math.random) {\n  for (let i = arr.length - 1; i > 0; i--) {\n    const j = Math.floor(rng() * (i + 1));\n    const t = arr[i];\n    arr[i] = arr[j];\n    arr[j] = t;\n  }\n  return arr;\n}\n\nexport function sortHand(hand) {\n  hand.sort((a, b) =>\n    (COLOR_ORDER[a.color] - COLOR_ORDER[b.color]) ||\n    (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) ||\n    ((a.value ?? -1) - (b.value ?? -1))\n  );\n  return hand;\n}\n\n/* --------------------------- Utilidades --------------------------- */\n\nexport function getTop(state) {\n  if (state.discard && state.discard.length) return state.discard[state.discard.length - 1];\n  return state.topCard || null;\n}\n\nexport function nextIndex(state) {\n  const n = state.players.length;\n  return ((state.current + state.direction) % n + n) % n;\n}\n\nexport function cardLabel(card) {\n  if (!card) return '';\n  const c = COLOR_NAMES[card.color] || '';\n  switch (card.kind) {\n    case 'number': return `${card.value} ${c}`;\n    case 'skip': return `Prohibido ${c}`;\n    case 'reverse': return `Reversa ${c}`;\n    case 'draw2': return `+2 ${c}`;\n    case 'wild': return 'Comodín';\n    case 'draw4': return 'Comodín +4';\n    default: return 'carta';\n  }\n}\n\nexport function handPoints(hand) {\n  let pts = 0;\n  for (const card of hand) {\n    if (card.kind === 'number') pts += card.value;\n    else if (card.kind === 'wild' || card.kind === 'draw4') pts += 50;\n    else pts += 20;\n  }\n  return pts;\n}\n\nfunction log(state, text, cls) {\n  state.log.push({ text, t: Date.now(), cls: cls || '' });\n  if (state.log.length > 60) state.log.splice(0, state.log.length - 60);\n}\n\nfunction err(message) {\n  return { ok: false, error: message };\n}\nfunction ok(data) {\n  return { ok: true, ...(data || {}) };\n}\n\n/* --------------------------- Crear partida --------------------------- */\n\nexport function createGame(playerNames, prevScores = null) {\n  if (!Array.isArray(playerNames) || playerNames.length < 2 || playerNames.length > 6) {\n    throw new Error('Se necesitan de 2 a 6 jugadores');\n  }\n  const deck = shuffle(createDeck());\n  const players = playerNames.map((name) => ({\n    name: String(name || 'Jugador').trim().slice(0, 20) || 'Jugador',\n    hand: [],\n    saidUno: false,\n  }));\n\n  for (let r = 0; r < 7; r++) {\n    for (const p of players) p.hand.push(deck.pop());\n  }\n  for (const p of players) sortHand(p.hand);\n\n  const discard = [];\n  let first = deck.pop();\n  while (first.color === 'wild' && deck.length) {\n    deck.push(first);\n    shuffle(deck);\n    first = deck.pop();\n  }\n  discard.push(first);\n\n  const state = {\n    players,\n    deck,\n    discard,\n    current: 0,\n    direction: 1,\n    activeColor: first.color,\n    pendingDraw: 0,\n    pendingWild: null,\n    justDrew: null,\n    unoWindow: null,\n    phase: 'playing', // playing | colorPick | gameOver\n    winner: null,\n    lastRoundPoints: null,\n    scores: prevScores ? prevScores.slice(0, players.length) : players.map(() => 0),\n    log: [],\n    turnCount: 0,\n    startedAt: Date.now(),\n  };\n\n  log(state, `Nueva ronda. Carta inicial: ${cardLabel(first)}`);\n\n  // Efecto de la carta inicial\n  if (first.kind === 'skip') {\n    log(state, `${players[0].name} pierde su turno (Prohibido)`);\n    state.current = nextIndex(state);\n  } else if (first.kind === 'reverse') {\n    state.direction = -1;\n    log(state, 'La Reversa invierte el sentido del juego');\n  } else if (first.kind === 'draw2') {\n    drawCardsInternal(state, 0, 2);\n    log(state, `${players[0].name} roba 2 cartas por la carta inicial`);\n    state.current = nextIndex(state);\n  }\n\n  return state;\n}\n\n/* --------------------------- Mazo / robo --------------------------- */\n\nfunction ensureDeck(state) {\n  if (state.deck.length > 0) return;\n  if (state.discard.length <= 1) return;\n  const top = state.discard.pop();\n  const rest = state.discard.splice(0);\n  state.deck = shuffle(rest);\n  state.discard = [top];\n  log(state, 'Se barajaron las cartas descartadas');\n}\n\nfunction drawCardsInternal(state, playerIdx, n) {\n  const player = state.players[playerIdx];\n  const drawn = [];\n  for (let i = 0; i < n; i++) {\n    ensureDeck(state);\n    if (!state.deck.length) break;\n    const card = state.deck.pop();\n    player.hand.push(card);\n    drawn.push(card);\n  }\n  if (drawn.length) sortHand(player.hand);\n  return drawn;\n}\n\n/* --------------------------- Reglas --------------------------- */\n\nexport function canPlayCard(state, playerIdx, card) {\n  if (!card || !state.players[playerIdx]) return false;\n  if (state.phase === 'gameOver' || state.phase === 'colorPick') return false;\n  if (state.current !== playerIdx) return false;\n  if (state.justDrew) {\n    if (state.justDrew.playerIdx !== playerIdx) return false;\n    if (state.justDrew.cardId !== card.id) return false;\n  }\n  // Acumulación de +2/+4: solo cartas de robar\n  if (state.pendingDraw > 0) return card.kind === 'draw2' || card.kind === 'draw4';\n\n  const top = getTop(state);\n  if (card.color === 'wild') return true;\n  if (card.color === state.activeColor) return true;\n  if (!top) return true;\n  if (card.kind === 'number' && top.kind === 'number') return card.value === top.value;\n  if (card.kind !== 'number' && card.kind === top.kind) return true;\n  return false;\n}\n\nexport function playableCards(state, playerIdx) {\n  const p = state.players[playerIdx];\n  if (!p || !p.hand) return [];\n  return p.hand.filter((c) => canPlayCard(state, playerIdx, c)).map((c) => c.id);\n}\n\n/* --------------------------- Acciones --------------------------- */\n\nexport function playCard(state, playerIdx, cardId) {\n  expireUnoWindow(state);\n\n  if (state.phase === 'gameOver') return err('La ronda ya terminó');\n  if (state.phase === 'colorPick') return err('Primero elige un color');\n  if (state.current !== playerIdx) return err('No es tu turno');\n\n  const player = state.players[playerIdx];\n  const idx = player.hand.findIndex((c) => c.id === cardId);\n  if (idx < 0) return err('No tienes esa carta');\n\n  const card = player.hand[idx];\n  if (!canPlayCard(state, playerIdx, card)) return err('Esa carta no coincide con la mesa');\n\n  player.hand.splice(idx, 1);\n  state.discard.push(card);\n  state.justDrew = null;\n  player.saidUno = false;\n\n  let advance = 1;\n\n  switch (card.kind) {\n    case 'number':\n      state.activeColor = card.color;\n      break;\n    case 'skip':\n      state.activeColor = card.color;\n      advance = 2;\n      break;\n    case 'reverse':\n      state.activeColor = card.color;\n      state.direction *= -1;\n      advance = state.players.length === 2 ? 2 : 1;\n      break;\n    case 'draw2':\n      state.activeColor = card.color;\n      state.pendingDraw += 2;\n      break;\n    case 'wild':\n      state.pendingWild = { playerIdx, cardId: card.id, advance: 1 };\n      state.phase = 'colorPick';\n      break;\n    case 'draw4':\n      state.pendingDraw += 4;\n      state.pendingWild = { playerIdx, cardId: card.id, advance: 1 };\n      state.phase = 'colorPick';\n      break;\n    default:\n      state.activeColor = card.color;\n  }\n\n  log(state, `${player.name} jugó ${cardLabel(card)}`);\n\n  if (state.phase === 'colorPick') {\n    // El avance ocurre al elegir color\n  } else {\n    for (let i = 0; i < advance; i++) state.current = nextIndex(state);\n    state.turnCount++;\n  }\n\n  if (player.hand.length === 0) {\n    finishGame(state, playerIdx);\n    return ok();\n  }\n  if (player.hand.length === 1) {\n    state.unoWindow = { playerIdx, expires: Date.now() + UNO_WINDOW_MS, saidUno: false };\n  }\n  return ok();\n}\n\nexport function chooseColor(state, playerIdx, color) {\n  if (state.phase === 'gameOver') return err('La ronda ya terminó');\n  if (!state.pendingWild || state.pendingWild.playerIdx !== playerIdx) {\n    return err('No puedes elegir color ahora');\n  }\n  if (!COLORS.includes(color)) return err('Color inválido');\n\n  state.activeColor = color;\n  const advance = state.pendingWild.advance || 1;\n  state.pendingWild = null;\n  state.justDrew = null;\n  state.phase = 'playing';\n  for (let i = 0; i < advance; i++) state.current = nextIndex(state);\n  state.turnCount++;\n\n  log(state, `${state.players[playerIdx].name} eligió el color ${COLOR_NAMES[color]}`);\n  return ok();\n}\n\nexport function drawAction(state, playerIdx) {\n  expireUnoWindow(state);\n\n  if (state.phase === 'gameOver') return err('La ronda ya terminó');\n  if (state.phase === 'colorPick') return err('Primero elige un color');\n  if (state.current !== playerIdx) return err('No es tu turno');\n\n  const player = state.players[playerIdx];\n\n  // Acumulado de +2/+4: roba todo y pierde el turno\n  if (state.pendingDraw > 0) {\n    const n = state.pendingDraw;\n    state.pendingDraw = 0;\n    state.justDrew = null;\n    drawCardsInternal(state, playerIdx, n);\n    log(state, `${player.name} roba ${n} cartas acumuladas`, 'danger');\n    state.current = nextIndex(state);\n    state.turnCount++;\n    return ok({ drew: n });\n  }\n\n  const drawn = drawCardsInternal(state, playerIdx, 1);\n  if (!drawn.length) {\n    // No hay cartas en ninguna parte: el turno pasa (se avisa en el registro)\n    state.justDrew = null;\n    log(state, `No quedan cartas para robar: ${player.name} pierde el turno`, 'danger');\n    state.current = nextIndex(state);\n    state.turnCount++;\n    return ok({ drew: 0, skipped: true });\n  }\n  const card = drawn[0];\n  state.justDrew = { playerIdx, cardId: card.id };\n  log(state, `${player.name} robó una carta`);\n  return ok({ drew: 1, cardId: card.id });\n}\n\nexport function passTurn(state, playerIdx) {\n  if (state.phase === 'gameOver') return err('La ronda ya terminó');\n  if (state.phase === 'colorPick') return err('Primero elige un color');\n  if (state.current !== playerIdx) return err('No es tu turno');\n  if (!state.justDrew || state.justDrew.playerIdx !== playerIdx) {\n    return err('Debes jugar una carta o robar antes de pasar');\n  }\n  // Solo puedes pasar si la carta robada SÍ se puede jugar.\n  // Si no tienes con qué jugar y hay cartas en el mazo, sigue robando.\n  const player = state.players[playerIdx];\n  const drawnCard = player.hand.find((c) => c.id === state.justDrew.cardId);\n  if (!drawnCard || !canPlayCard(state, playerIdx, drawnCard)) {\n    return err('Todavía no tienes con qué jugar: roba otra carta del mazo');\n  }\n  state.justDrew = null;\n  log(state, `${player.name} pasó`);\n  state.current = nextIndex(state);\n  state.turnCount++;\n  return ok();\n}\n\nexport function declareUno(state, playerIdx) {\n  if (!state.unoWindow || state.unoWindow.playerIdx !== playerIdx) {\n    return err('No es momento de decir UNO');\n  }\n  if (state.players[playerIdx].hand.length !== 1) return err('No tienes una sola carta');\n\n  state.players[playerIdx].saidUno = true;\n  state.unoWindow = null;\n  log(state, `¡${state.players[playerIdx].name} dijo UNO!`, 'uno');\n  return ok();\n}\n\nexport function catchUno(state, catcherIdx) {\n  expireUnoWindow(state);\n  if (!state.unoWindow) return err('No hay nada que atrapar');\n  const offenderIdx = state.unoWindow.playerIdx;\n  if (offenderIdx === catcherIdx) return err('No puedes atraparte a ti mismo');\n\n  const offender = state.players[offenderIdx];\n  drawCardsInternal(state, offenderIdx, 2);\n  state.unoWindow = null;\n  log(state, `${state.players[catcherIdx].name} atrapó a ${offender.name} sin decir UNO: +2`, 'danger');\n  return ok();\n}\n\nexport function expireUnoWindow(state) {\n  if (!state.unoWindow) return false;\n  if (Date.now() < state.unoWindow.expires) return false;\n  const offenderIdx = state.unoWindow.playerIdx;\n  const offender = state.players[offenderIdx];\n  drawCardsInternal(state, offenderIdx, 2);\n  state.unoWindow = null;\n  log(state, `${offender.name} no dijo UNO a tiempo: +2`, 'danger');\n  return true;\n}\n\nfunction finishGame(state, winnerIdx) {\n  state.phase = 'gameOver';\n  state.winner = winnerIdx;\n  state.unoWindow = null;\n  state.pendingWild = null;\n  state.justDrew = null;\n  let points = 0;\n  state.players.forEach((p, i) => {\n    if (i !== winnerIdx) points += handPoints(p.hand);\n  });\n  state.lastRoundPoints = { winner: winnerIdx, points };\n  if (!state.scores || state.scores.length !== state.players.length) {\n    state.scores = state.players.map(() => 0);\n  }\n  state.scores[winnerIdx] += points;\n  log(state, `¡${state.players[winnerIdx].name} ganó la ronda (+${points} puntos)!`, 'win');\n}\n\n/* --------------------------- Vista privada --------------------------- */\n\nexport function sanitize(state, viewerIdx) {\n  if (!state) return null;\n  return {\n    players: state.players.map((p, i) => ({\n      name: p.name,\n      saidUno: !!p.saidUno,\n      handCount: p.hand.length,\n      hand: i === viewerIdx ? p.hand.map((c) => ({ ...c })) : null,\n    })),\n    deckCount: state.deck.length,\n    discardCount: state.discard.length,\n    discard: state.discard.slice(-3).map((c) => ({ ...c })),\n    topCard: getTop(state) ? { ...getTop(state) } : null,\n    current: state.current,\n    direction: state.direction,\n    activeColor: state.activeColor,\n    pendingDraw: state.pendingDraw,\n    pendingWild: state.pendingWild ? { ...state.pendingWild } : null,\n    justDrew: state.justDrew\n      ? {\n          playerIdx: state.justDrew.playerIdx,\n          cardId: state.justDrew.playerIdx === viewerIdx ? state.justDrew.cardId : null,\n        }\n      : null,\n    unoWindow: state.unoWindow\n      ? {\n          playerIdx: state.unoWindow.playerIdx,\n          expires: state.unoWindow.expires,\n          saidUno: !!state.unoWindow.saidUno,\n        }\n      : null,\n    phase: state.phase,\n    winner: state.winner,\n    lastRoundPoints: state.lastRoundPoints ? { ...state.lastRoundPoints } : null,\n    scores: state.scores ? state.scores.slice() : state.players.map(() => 0),\n    log: state.log.slice(-30),\n    turnCount: state.turnCount,\n  };\n}\n",
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map(); // code -> room

/* --------------------------- Utilidades --------------------------- */

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 20) || 'Jugador';
}

/* --------------------------- Salas --------------------------- */

function payloadFor(room, player) {
  const idx = room.players.findIndex((p) => p.id === player.id);
  return {
    type: 'state',
    serverTime: Date.now(),
    room: {
      code: room.code,
      hostId: room.hostId,
      inMatch: !!room.game,
      round: room.round,
    },
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.id === room.hostId,
    })),
    you: {
      playerId: player.id,
      index: idx,
      name: player.name,
      isHost: player.id === room.hostId,
    },
    game: room.game ? engine.sanitize(room.game, idx) : null,
  };
}

function broadcast(room) {
  room.version = (room.version || 0) + 1;
  for (const p of room.players) {
    if (p.sse) {
      try {
        p.sse.write(`data: ${JSON.stringify(payloadFor(room, p))}\n\n`);
      } catch {
        p.sse = null;
      }
    }
  }
  // Long-polling: despierta a los clientes en espera
  const waiters = room.waiters.splice(0);
  for (const w of waiters) {
    clearTimeout(w.timer);
    try {
      if (!room.players.includes(w.player)) {
        json(w.res, 200, { ok: false, error: 'out' });
      } else {
        json(w.res, 200, { ok: true, version: room.version, payload: payloadFor(room, w.player) });
      }
    } catch { /* cliente desconectado */ }
  }
}

function syncUnoTimer(room) {
  const w = room.game && room.game.unoWindow;
  if (!w) {
    if (room.unoTimer) {
      clearTimeout(room.unoTimer);
      room.unoTimer = null;
    }
    return;
  }
  if (room.unoTimer && room.unoTimer.forExpires === w.expires) return;
  if (room.unoTimer) clearTimeout(room.unoTimer);
  const ms = Math.max(0, w.expires - Date.now());
  const t = setTimeout(() => {
    room.unoTimer = null;
    if (room.game) {
      engine.expireUnoWindow(room.game);
      afterMutate(room);
    }
  }, ms + 50);
  t.forExpires = w.expires;
  room.unoTimer = t;
}

function afterMutate(room) {
  room.lastActivity = Date.now();
  syncUnoTimer(room);
  broadcast(room);
}

function findRoomAndPlayer(body) {
  const code = String(body.code || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return { error: 'Sala no encontrada. Revisa el código.' };
  const player = room.players.find((p) => p.id === body.playerId);
  if (!player) return { error: 'No perteneces a esta sala.' };
  return { room, player };
}

function playerIndex(room, player) {
  return room.players.findIndex((p) => p.id === player.id);
}

/* --------------------------- Acciones de sala --------------------------- */

function createRoom(name) {
  const code = makeCode();
  const hostId = crypto.randomUUID();
  const room = {
    code,
    hostId,
    round: 1,
    version: 1,
    waiters: [],
    players: [{ id: hostId, name: cleanName(name), sse: null, connected: true, lastPoll: Date.now() }],
    game: null,
    unoTimer: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function handleAction(body) {
  const action = String(body.action || '');
  const found = findRoomAndPlayer(body);
  if (found.error) return { status: 404, data: { ok: false, error: found.error } };
  const { room, player } = found;

  const guardPlaying = () => {
    if (!room.game) return { status: 400, data: { ok: false, error: 'La partida aún no comienza.' } };
    return null;
  };

  switch (action) {
    case 'join': {
      // Unirse a sala existente (code + name)
      return null; // manejado por /api/join
    }

    case 'start': {
      if (player.id !== room.hostId) {
        return { status: 403, data: { ok: false, error: 'Solo quien creó la sala puede iniciar.' } };
      }
      if (room.game) return { status: 400, data: { ok: false, error: 'La partida ya comenzó.' } };
      if (room.players.length < 2) {
        return { status: 400, data: { ok: false, error: 'Se necesitan al menos 2 jugadores.' } };
      }
      room.game = engine.createGame(room.players.map((p) => p.name));
      afterMutate(room);
      return { status: 200, data: { ok: true } };
    }

    case 'next-round': {
      if (player.id !== room.hostId) {
        return { status: 403, data: { ok: false, error: 'Solo quien creó la sala puede iniciar la ronda.' } };
      }
      const g = guardPlaying();
      if (g) return g;
      if (room.game.phase !== 'gameOver') {
        return { status: 400, data: { ok: false, error: 'La ronda actual aún no termina.' } };
      }
      const scores = room.game.scores;
      room.round += 1;
      room.game = engine.createGame(room.players.map((p) => p.name), scores);
      afterMutate(room);
      return { status: 200, data: { ok: true } };
    }

    case 'play': {
      const g = guardPlaying();
      if (g) return g;
      const idx = playerIndex(room, player);
      const result = engine.playCard(room.game, idx, body.cardId);
      if (!result.ok) return { status: 400, data: result };
      // Si jugó un comodín y ya eligió color, se resuelve en el mismo paso
      if (body.color && room.game.phase === 'colorPick' && room.game.pendingWild && room.game.pendingWild.playerIdx === idx) {
        const r2 = engine.chooseColor(room.game, idx, body.color);
        if (!r2.ok) return { status: 400, data: r2 };
      }
      afterMutate(room);
      return { status: 200, data: result };
    }

    case 'color': {
      const g = guardPlaying();
      if (g) return g;
      const result = engine.chooseColor(room.game, playerIndex(room, player), body.color);
      if (!result.ok) return { status: 400, data: result };
      afterMutate(room);
      return { status: 200, data: result };
    }

    case 'draw': {
      const g = guardPlaying();
      if (g) return g;
      const result = engine.drawAction(room.game, playerIndex(room, player));
      if (!result.ok) return { status: 400, data: result };
      afterMutate(room);
      return { status: 200, data: result };
    }

    case 'pass': {
      const g = guardPlaying();
      if (g) return g;
      const result = engine.passTurn(room.game, playerIndex(room, player));
      if (!result.ok) return { status: 400, data: result };
      afterMutate(room);
      return { status: 200, data: result };
    }

    case 'uno': {
      const g = guardPlaying();
      if (g) return g;
      const result = engine.declareUno(room.game, playerIndex(room, player));
      if (!result.ok) return { status: 400, data: result };
      afterMutate(room);
      return { status: 200, data: result };
    }

    case 'catch': {
      const g = guardPlaying();
      if (g) return g;
      const result = engine.catchUno(room.game, playerIndex(room, player));
      if (!result.ok) return { status: 400, data: result };
      afterMutate(room);
      return { status: 200, data: result };
    }

    case 'leave': {
      room.players = room.players.filter((p) => p.id !== player.id);
      if (room.players.length === 0) {
        if (room.unoTimer) clearTimeout(room.unoTimer);
        rooms.delete(room.code);
        return { status: 200, data: { ok: true, roomGone: true } };
      }
      if (room.hostId === player.id) room.hostId = room.players[0].id;
      // La partida en curso conserva el asiento (sin reemplazo): se marca desconectado
      // pero al salir explícito en partida, el jugador queda fuera de la lista.
      afterMutate(room);
      return { status: 200, data: { ok: true } };
    }

    default:
      return { status: 400, data: { ok: false, error: 'Acción desconocida.' } };
  }
}

/* --------------------------- HTTP --------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel).split('?')[0];
  const content = EMBEDDED[rel];
  if (content === undefined) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
    return;
  }
  const dot = rel.lastIndexOf('.');
  const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : '';
  const mime = MIME[ext] || 'text/plain; charset=utf-8';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // ---- API ----
  if (p === '/api/health') {
    return json(res, 200, { ok: true, rooms: rooms.size, time: Date.now() });
  }

  if (p === '/api/create' && req.method === 'POST') {
    const body = await readBody(req);
    const room = createRoom(body.name);
    const player = room.players[0];
    return json(res, 200, { ok: true, code: room.code, playerId: player.id, name: player.name });
  }

  if (p === '/api/join' && req.method === 'POST') {
    const body = await readBody(req);
    const code = String(body.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return json(res, 404, { ok: false, error: 'Sala no encontrada. Revisa el código.' });
    if (room.game) return json(res, 400, { ok: false, error: 'La partida ya comenzó en esta sala.' });
    if (room.players.length >= 6) return json(res, 400, { ok: false, error: 'La sala está llena (máx. 6).' });
    const player = { id: crypto.randomUUID(), name: cleanName(body.name), sse: null, connected: true, lastPoll: Date.now() };
    room.players.push(player);
    room.lastActivity = Date.now();
    broadcast(room);
    return json(res, 200, { ok: true, code: room.code, playerId: player.id, name: player.name });
  }

  if (p === '/api/state' && req.method === 'GET') {
    const code = (url.searchParams.get('code') || '').toUpperCase().trim();
    const playerId = url.searchParams.get('playerId') || '';
    const room = rooms.get(code);
    if (!room) return json(res, 404, { ok: false, error: 'Sala no encontrada.' });
    const player = room.players.find((x) => x.id === playerId);
    if (!player) return json(res, 404, { ok: false, error: 'No perteneces a esta sala.' });
    return json(res, 200, { ok: true, payload: payloadFor(room, player) });
  }

  if (p === '/api/action' && req.method === 'POST') {
    const body = await readBody(req);
    const result = handleAction(body);
    if (!result) return json(res, 400, { ok: false, error: 'Acción desconocida.' });
    return json(res, result.status, result.data);
  }

  // ---- Long-polling (funciona a través de cualquier proxy/CDN) ----
  if (p === '/api/poll' && req.method === 'GET') {
    const code = (url.searchParams.get('code') || '').toUpperCase().trim();
    const playerId = url.searchParams.get('playerId') || '';
    const after = Number(url.searchParams.get('after') || 0);
    const room = rooms.get(code);
    const player = room && room.players.find((x) => x.id === playerId);
    if (!room || !player) {
      return json(res, 404, { ok: false, error: 'Sala no encontrada.' });
    }
    player.lastPoll = Date.now();
    if (!player.connected) {
      player.connected = true;
      broadcast(room);
    }
    room.lastActivity = Date.now();

    // Si ya hay cambios desde la última versión del cliente, responde ya
    if ((room.version || 0) > after) {
      return json(res, 200, { ok: true, version: room.version, payload: payloadFor(room, player) });
    }

    // Si no, espera (máx. 25 s) a que haya un cambio
    const waiter = { res, player };
    waiter.timer = setTimeout(() => {
      room.waiters = room.waiters.filter((w) => w !== waiter);
      try {
        json(res, 200, { ok: true, version: room.version || 0, payload: payloadFor(room, waiter.player) });
      } catch { /* cliente desconectado */ }
    }, 25000);
    room.waiters.push(waiter);
    req.on('close', () => {
      clearTimeout(waiter.timer);
      room.waiters = room.waiters.filter((w) => w !== waiter);
    });
    return;
  }

  if (p === '/api/events' && req.method === 'GET') {
    const code = (url.searchParams.get('code') || '').toUpperCase().trim();
    const playerId = url.searchParams.get('playerId') || '';
    const room = rooms.get(code);
    const player = room && room.players.find((x) => x.id === playerId);
    if (!room || !player) {
      return json(res, 404, { ok: false, error: 'Sala no encontrada.' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(payloadFor(room, player))}\n\n`);

    player.sse = res;
    player.connected = true;
    room.lastActivity = Date.now();
    broadcast(room);

    req.on('close', () => {
      if (player.sse === res) player.sse = null;
      player.connected = false;
      room.lastActivity = Date.now();
      broadcast(room);
    });
    return;
  }

  // ---- Estáticos ----
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, p);
  }

  res.writeHead(405);
  res.end('Método no permitido');
});

/* --------------------------- Limpieza --------------------------- */

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = room.players.some((x) => x.sse);
    if (!anyConnected && now - room.lastActivity > 30 * 60 * 1000) {
      if (room.unoTimer) clearTimeout(room.unoTimer);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

// Latido SSE + presencia por long-polling
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const pl of room.players) {
      if (pl.sse) {
        try {
          pl.sse.write(': ping\n\n');
        } catch {
          pl.sse = null;
        }
      }
      // Marcado de desconexión si no hay actividad reciente
      const recent = (pl.lastPoll && now - pl.lastPoll < 30000) || !!pl.sse;
      if (pl.connected && !recent) {
        pl.connected = false;
        broadcast(room);
      }
    }
  }
}, 10 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`🃏 UNO Multijugador listo en http://${HOST}:${PORT}`);
});
