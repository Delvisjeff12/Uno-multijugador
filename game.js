/* ============================================================
   Motor del juego UNO — lógica pura compartida
   Funciona tanto en el navegador (modo local) como en Node
   (servidor de salas en línea). Sin dependencias.
   ============================================================ */

export const COLORS = ['red', 'yellow', 'green', 'blue'];

export const COLOR_NAMES = {
  red: 'rojo',
  yellow: 'amarillo',
  green: 'verde',
  blue: 'azul',
};

export const UNO_WINDOW_MS = 7000;

const COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
const KIND_ORDER = { number: 0, skip: 1, reverse: 2, draw2: 3, wild: 4, draw4: 5 };

let cardCounter = 0;
const uid = () => 'c' + ++cardCounter;

/* ---------------------------- Mazo ---------------------------- */

export function createDeck() {
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

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

export function sortHand(hand) {
  hand.sort((a, b) =>
    (COLOR_ORDER[a.color] - COLOR_ORDER[b.color]) ||
    (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) ||
    ((a.value ?? -1) - (b.value ?? -1))
  );
  return hand;
}

/* --------------------------- Utilidades --------------------------- */

export function getTop(state) {
  if (state.discard && state.discard.length) return state.discard[state.discard.length - 1];
  return state.topCard || null;
}

export function nextIndex(state) {
  const n = state.players.length;
  return ((state.current + state.direction) % n + n) % n;
}

export function cardLabel(card) {
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

export function handPoints(hand) {
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

export function createGame(playerNames, prevScores = null) {
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

export function canPlayCard(state, playerIdx, card) {
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

export function playableCards(state, playerIdx) {
  const p = state.players[playerIdx];
  if (!p || !p.hand) return [];
  return p.hand.filter((c) => canPlayCard(state, playerIdx, c)).map((c) => c.id);
}

/* --------------------------- Acciones --------------------------- */

export function playCard(state, playerIdx, cardId) {
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

export function chooseColor(state, playerIdx, color) {
  if (state.phase === 'gameOver') return err('La ronda ya terminó');
  if (!state.pendingWild || state.pendingWild.playerIdx !== playerIdx) {
    return err('No puedes elegir color ahora');
  }
  if (!COLORS.includes(color)) return err('Color inválido');

  state.activeColor = color;
  const advance = state.pendingWild.advance || 1;
  state.pendingWild = null;
  state.phase = 'playing';
  for (let i = 0; i < advance; i++) state.current = nextIndex(state);
  state.turnCount++;

  log(state, `${state.players[playerIdx].name} eligió el color ${COLOR_NAMES[color]}`);
  return ok();
}

export function drawAction(state, playerIdx) {
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
    state.current = nextIndex(state);
    state.turnCount++;
    return ok({ drew: 0 });
  }
  const card = drawn[0];
  state.justDrew = { playerIdx, cardId: card.id };
  log(state, `${player.name} robó una carta`);
  return ok({ drew: 1, cardId: card.id });
}

export function passTurn(state, playerIdx) {
  if (state.phase === 'gameOver') return err('La ronda ya terminó');
  if (state.phase === 'colorPick') return err('Primero elige un color');
  if (state.current !== playerIdx) return err('No es tu turno');
  if (!state.justDrew || state.justDrew.playerIdx !== playerIdx) {
    return err('Debes jugar una carta o robar antes de pasar');
  }
  state.justDrew = null;
  log(state, `${state.players[playerIdx].name} pasó`);
  state.current = nextIndex(state);
  state.turnCount++;
  return ok();
}

export function declareUno(state, playerIdx) {
  if (!state.unoWindow || state.unoWindow.playerIdx !== playerIdx) {
    return err('No es momento de decir UNO');
  }
  if (state.players[playerIdx].hand.length !== 1) return err('No tienes una sola carta');

  state.players[playerIdx].saidUno = true;
  state.unoWindow = null;
  log(state, `¡${state.players[playerIdx].name} dijo UNO!`, 'uno');
  return ok();
}

export function catchUno(state, catcherIdx) {
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

export function expireUnoWindow(state) {
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

export function sanitize(state, viewerIdx) {
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
