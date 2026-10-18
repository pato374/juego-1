// ============================================================
//  Servidor multijugador de "Juego 1"  (sin dependencias)
//  Uso:   node servidor.js          (puerto 3000; otro: PORT=4000 node servidor.js)
//  Luego abre  http://localhost:3000  o el archivo juego1.html
//  Esta consola muestra los movimientos del Jugador 1 y del Jugador 2.
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 3000;
const NAMES = {
  control: 'Control Mental', hint: 'Pista', block: 'Bloqueo', double: 'Doble Turno', skip: 'Salto',
  skipopp: 'Salta al Rival', mirror: 'Espejo', chance: 'Un Chance Mas', steal: 'Robo', xray: 'Rayos X',
  swap: 'Intercambio', recycle: 'Reciclaje', detector: 'Detector', heal: 'Reparar Escudo', rerack: 'Reinicio',
  discard: 'Descarte Forzado', redirect: 'Desvio', draw: 'Cartas Nuevas', gamble: 'Apuesta'
};

let queue = [];            // jugadores buscando partida: {pid, last}
const matches = {};        // id -> partida
const pidMatch = {};       // pid -> id de partida
let nextId = 1;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Cache-Control': 'no-store'
};
const ts = () => new Date().toLocaleTimeString('es-CL', { hour12: false });
const log = (...a) => console.log('[' + ts() + ']', ...a);
const short = pid => String(pid || '?').slice(0, 8);

function send(res, obj, code = 200) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, CORS));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function describe(turn) {
  if (!Array.isArray(turn) || !turn.length) return 'turno vacio';
  return turn.map(a => {
    if (a.a === 'card') return 'uso ' + (NAMES[a.t] || a.t);
    if (a.a === 'press') return 'presiono el boton' + (a.res === 'hit' ? ' -> PELIGRO (recibe dano)' : a.res === 'safe' ? ' -> seguro' : '');
    if (a.a === 'skip') return 'salto su turno';
    if (a.a === 'forced') return 'fue controlado por el rival (Control Mental)';
    return a.a;
  }).join(', ');
}
function matchInfo(m, pid) {
  const seat = m.p[1].pid === pid ? 1 : 2;
  return { state: 'matched', match: m.id, seat, seed: m.seed };
}
function cleanup() {
  const now = Date.now();
  queue = queue.filter(q => now - q.last < 6000);
  for (const id of Object.keys(matches)) {
    const m = matches[id];
    const idle = Math.max(now - m.p[1].last, now - m.p[2].last);
    if (idle > 10 * 60 * 1000) { delete matches[id]; }
  }
}
setInterval(cleanup, 5000);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const q = u.searchParams;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // ---- el propio juego ----
  if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/juego1.html' || u.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Pon index.html en la misma carpeta que servidor.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ---- buscar partida ----
  if (u.pathname === '/api/find') {
    const pid = q.get('pid'); if (!pid) return send(res, { error: 'pid' }, 400);
    const now = Date.now();
    queue = queue.filter(x => now - x.last < 6000 || x.pid === pid);
    if (pidMatch[pid] && matches[pidMatch[pid]]) return send(res, matchInfo(matches[pidMatch[pid]], pid));
    let me = queue.find(x => x.pid === pid);
    if (!me) { me = { pid, last: now }; queue.push(me); log('BUSCANDO  jugador ' + short(pid) + ' entro a la cola (en cola: ' + queue.length + ')'); }
    me.last = now;
    const other = queue.find(x => x.pid !== pid);
    if (other) {
      const first = queue.indexOf(me) < queue.indexOf(other) ? me : other;
      const second = first === me ? other : me;
      const id = nextId++;
      const seed = Math.random().toString(36).slice(2, 10);
      const t = Date.now();
      const m = { id, seed, created: t, winner: 0,
        p: { 1: { pid: first.pid, last: t, started: false, turns: [], done: false, left: false },
             2: { pid: second.pid, last: t, started: false, turns: [], done: false, left: false } } };
      matches[id] = m; pidMatch[first.pid] = id; pidMatch[second.pid] = id;
      queue = queue.filter(x => x !== first && x !== second);
      log('PARTIDA #' + id + ' creada  | Jugador 1 = ' + short(first.pid) + '  | Jugador 2 = ' + short(second.pid) + '  | semilla ' + seed);
      return send(res, matchInfo(m, pid));
    }
    return send(res, { state: 'searching', waiting: queue.length });
  }
  if (u.pathname === '/api/cancel') {
    const pid = q.get('pid'); const before = queue.length;
    queue = queue.filter(x => x.pid !== pid);
    if (queue.length !== before) log('CANCELO   jugador ' + short(pid) + ' dejo de buscar partida');
    return send(res, { ok: true });
  }

  // ---- movimientos ----
  if (u.pathname === '/api/move' && req.method === 'POST') {
    const b = await readBody(req); const m = matches[b.match];
    if (!m || !m.p[b.seat]) return send(res, { ok: false });
    const pl = m.p[b.seat]; pl.turns.push(b.turn || []); pl.last = Date.now(); pl.started = true;
    const hp = Array.isArray(b.hp) ? '  [escudos ' + b.hp[0] + ' / corazon ' + b.hp[1] + ']' : '';
    log('#' + m.id + '  JUGADOR ' + b.seat + ' (' + short(pl.pid) + ')  ronda ' + b.round + ': ' + describe(b.turn) + hp);
    return send(res, { ok: true });
  }
  if (u.pathname === '/api/moves') {
    const m = matches[q.get('match')]; const seat = +q.get('seat'); const from = +q.get('from') || 0;
    if (!m || !m.p[seat]) return send(res, { turns: [], gone: true });
    const me = m.p[seat], o = m.p[3 - seat];
    me.last = Date.now(); me.started = true;
    const gone = o.left || o.done || (o.started ? Date.now() - o.last > 12000 : Date.now() - m.created > 45000);
    return send(res, { turns: o.turns.slice(from), gone });
  }
  if (u.pathname === '/api/end' && req.method === 'POST') {
    const b = await readBody(req); const m = matches[b.match];
    if (!m || !m.p[b.seat]) return send(res, { winner: 0 });
    const pl = m.p[b.seat]; pl.done = true; pl.last = Date.now();
    if (!m.winner) m.winner = b.result === 'win' ? b.seat : 3 - b.seat;
    log('#' + m.id + '  JUGADOR ' + b.seat + ' termino su partida: ' + (b.result === 'win' ? 'derroto a su replica' : 'fue derrotado') + ' (ronda ' + b.round + ')  ->  GANADOR: JUGADOR ' + m.winner);
    return send(res, { winner: m.winner });
  }
  if (u.pathname === '/api/leave' && req.method === 'POST') {
    const b = await readBody(req); const m = matches[b.match];
    if (!m || !m.p[b.seat]) return send(res, { ok: true });
    const pl = m.p[b.seat];
    if (!pl.left) {
      pl.left = true;
      if (!m.winner && !pl.done) { m.winner = 3 - b.seat; log('#' + m.id + '  JUGADOR ' + b.seat + ' abandono la partida  ->  GANADOR: JUGADOR ' + m.winner); }
      else log('#' + m.id + '  JUGADOR ' + b.seat + ' salio de la partida');
    }
    return send(res, { ok: true });
  }
  if (u.pathname === '/api/status') {
    return send(res, { cola: queue.length, partidas: Object.keys(matches).length });
  }
  res.writeHead(404, CORS); res.end('No encontrado');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  Servidor de Juego 1 listo en el puerto ' + PORT);
  console.log('  Abre:  http://localhost:' + PORT);
  console.log('  Esperando jugadores... (aqui veras sus movimientos)');
  console.log('==============================================');
});
