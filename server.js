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
import * as engine from './public/game.js';

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
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Prohibido');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
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
