// Disney Trivia — game engine (serverless, Upstash Redis via REST).
//
// Category-driven rounds with a "spin the wheel" picker:
//   lobby -> picking (spin wheel -> chosen player picks a category)
//         -> question -> reveal -> picking (next round) -> ... -> ended
//
// One endpoint, action-based (POST body.action or ?action=).
//   create  {}                               -> { code, hostToken }
//   join    {code, name}                     -> { playerId, name }
//   start   {code, hostToken, rounds, seconds}
//   spin    {code, hostToken}                -> picks a random player for this round
//   pick    {code, hostToken, category}      -> serves a question from that category
//   answer  {code, playerId, choice}         -> record a player's answer (server-timed)
//   reveal  {code, hostToken}                -> lock the current question
//   next    {code, hostToken}                -> advance (reveal -> next round / ended)
//   reset   {code, hostToken}                -> back to lobby, scores zeroed
//   state   {code, playerId?, host?}         -> current state (safe for that viewer)
//
// Storage keys (all expire after a few hours so games self-clean):
//   dt:game:CODE      string JSON  -> meta
//   dt:players:CODE   hash         -> field = playerId, value = JSON player
//   dt:answered:CODE  integer      -> # answered on the current question (atomic INCR)
//
// Scoring rewards SPEED + ACCURACY: correct = 500..1000 pts (instant = 1000,
// at the buzzer = 500), + up to +250 streak bonus. Wrong / no answer = 0.

const QUESTIONS = require("./questions.js");
const CATEGORIES = QUESTIONS.CATEGORIES;

const BASE_POINTS = 1000;
const MIN_CORRECT = 500;
const MAX_PLAYERS = 40;         // party cap (comfortably covers "up to 35")
const GAME_TTL = 60 * 60 * 4;   // 4 hours
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I

// ---- Redis plumbing ------------------------------------------------------

function getConn() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.STORAGE_KV_REST_API_URL ||
    null;
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.STORAGE_KV_REST_API_TOKEN ||
    null;
  if (!url || !token) return null;
  return { url, token };
}

async function redis(command) {
  const conn = getConn();
  if (!conn) return { error: "no-storage" };
  const r = await fetch(conn.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  return r.json();
}

const gameKey = (c) => "dt:game:" + c;
const playersKey = (c) => "dt:players:" + c;
const answeredKey = (c) => "dt:answered:" + c;

async function getMeta(code) {
  const res = await redis(["GET", gameKey(code)]);
  if (res.error === "no-storage") return "no-storage";
  if (!res.result) return null;
  try { return JSON.parse(res.result); } catch { return null; }
}
async function setMeta(code, meta) {
  await redis(["SET", gameKey(code), JSON.stringify(meta), "EX", String(GAME_TTL)]);
}
async function getPlayer(code, id) {
  const res = await redis(["HGET", playersKey(code), id]);
  if (!res.result) return null;
  try { return JSON.parse(res.result); } catch { return null; }
}
async function setPlayer(code, id, player) {
  await redis(["HSET", playersKey(code), id, JSON.stringify(player)]);
  await redis(["EXPIRE", playersKey(code), String(GAME_TTL)]);
}
async function allPlayers(code) {
  const res = await redis(["HGETALL", playersKey(code)]);
  const flat = res.result || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { out.push(Object.assign({ id: flat[i] }, JSON.parse(flat[i + 1]))); } catch { /* skip */ }
  }
  return out;
}

// ---- helpers -------------------------------------------------------------

function randId(len, chars) {
  let s = "";
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function currentQuestion(meta) {
  if (!meta || meta.current < 0) return null;
  return QUESTIONS[meta.current];
}

function leaderboard(players) {
  return players
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (a.name || "").localeCompare(b.name || ""))
    .map((p, i) => ({
      rank: i + 1, name: p.name, score: p.score || 0, streak: p.streak || 0,
      lastPoints: p.lastPoints || 0, lastCorrect: !!p.lastCorrect, id: p.id,
    }));
}

// Categories that still have at least one unused question.
function availableCategories(meta) {
  const used = new Set(meta.used || []);
  const live = new Set();
  QUESTIONS.forEach((q, i) => { if (!used.has(i)) live.add(q.cat); });
  return CATEGORIES.filter((c) => live.has(c.key));
}

// Pick a random unused question index from a category (fallback: any unused).
function pickQuestion(meta, catKey) {
  const used = new Set(meta.used || []);
  let pool = [];
  QUESTIONS.forEach((q, i) => { if (!used.has(i) && q.cat === catKey) pool.push(i); });
  if (!pool.length) QUESTIONS.forEach((q, i) => { if (!used.has(i)) pool.push(i); });
  if (!pool.length) return -1;
  return pool[Math.floor(Math.random() * pool.length)];
}

function bodyOf(req) {
  let b = req.body;
  if (b && typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  return b || {};
}
function paramOf(req, body, name) {
  if (body && body[name] != null) return body[name];
  if (req.query && req.query[name] != null) return req.query[name];
  const m = (req.url || "").match(new RegExp("[?&]" + name + "=([^&]+)"));
  return m ? decodeURIComponent(m[1]) : undefined;
}

// ---- handler -------------------------------------------------------------

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (getConn() === null) { res.status(200).json({ ok: false, error: "storage-not-connected" }); return; }

  const body = bodyOf(req);
  const action = (paramOf(req, body, "action") || "").toString();
  const code = (paramOf(req, body, "code") || "").toString().toUpperCase().trim();
  const now = Date.now();

  try {
    // ---- CREATE ----------------------------------------------------------
    if (action === "create") {
      let newCode = "";
      for (let tries = 0; tries < 8; tries++) {
        const candidate = randId(4, CODE_CHARS);
        const existing = await redis(["GET", gameKey(candidate)]);
        if (!existing.result) { newCode = candidate; break; }
      }
      if (!newCode) { res.status(500).json({ ok: false, error: "code-collision" }); return; }
      const hostToken = randId(16, "abcdefghijklmnopqrstuvwxyz0123456789");
      const meta = {
        code: newCode, hostToken,
        status: "lobby",         // lobby | picking | question | reveal | ended
        rounds: 10, round: 0,
        seconds: 20,
        used: [], current: -1, qStart: 0,
        picker: null, lastPickerId: null, category: null,
        total: QUESTIONS.length, createdAt: now, lastActive: now,
      };
      await setMeta(newCode, meta);
      await redis(["DEL", playersKey(newCode)]);
      await redis(["DEL", answeredKey(newCode)]);
      res.status(200).json({ ok: true, code: newCode, hostToken });
      return;
    }

    const meta = await getMeta(code);
    if (meta === "no-storage") { res.status(200).json({ ok: false, error: "storage-not-connected" }); return; }
    if (!meta) { res.status(404).json({ ok: false, error: "game-not-found" }); return; }
    const isHost = () => (paramOf(req, body, "hostToken") || "") === meta.hostToken;

    // ---- JOIN ------------------------------------------------------------
    if (action === "join") {
      if (meta.status !== "lobby") { res.status(200).json({ ok: false, error: "game-started" }); return; }
      let name = (paramOf(req, body, "name") || "").toString().trim().slice(0, 20);
      if (!name) { res.status(200).json({ ok: false, error: "name-required" }); return; }
      const players = await allPlayers(code);
      if (players.length >= MAX_PLAYERS) { res.status(200).json({ ok: false, error: "game-full" }); return; }
      const taken = new Set(players.map((p) => (p.name || "").toLowerCase()));
      if (taken.has(name.toLowerCase())) {
        let n = 2;
        while (taken.has((name + " " + n).toLowerCase())) n++;
        name = name + " " + n;
      }
      const playerId = randId(12, "abcdefghijklmnopqrstuvwxyz0123456789");
      await setPlayer(code, playerId, { name, score: 0, streak: 0, answeredQ: -1, lastChoice: -1, lastCorrect: false, lastPoints: 0, joinedAt: now });
      meta.lastActive = now; await setMeta(code, meta);
      res.status(200).json({ ok: true, playerId, name });
      return;
    }

    // ---- START -> first picking round ------------------------------------
    if (action === "start") {
      if (!isHost()) { res.status(403).json({ ok: false, error: "not-host" }); return; }
      let rounds = parseInt(paramOf(req, body, "rounds"), 10);
      let seconds = parseInt(paramOf(req, body, "seconds"), 10);
      if (!rounds || rounds < 1) rounds = 10;
      rounds = Math.min(rounds, QUESTIONS.length);
      if (!seconds || seconds < 5) seconds = 20;
      seconds = Math.min(seconds, 60);
      meta.rounds = rounds;
      meta.seconds = seconds;
      meta.round = 1;
      meta.used = [];
      meta.current = -1;
      meta.picker = null;
      meta.lastPickerId = null;
      meta.category = null;
      meta.status = "picking";
      meta.lastActive = now;
      await setMeta(code, meta);
      res.status(200).json({ ok: true });
      return;
    }

    // ---- SPIN (choose who picks the category) ----------------------------
    if (action === "spin") {
      if (!isHost()) { res.status(403).json({ ok: false, error: "not-host" }); return; }
      if (meta.status !== "picking") { res.status(200).json({ ok: false, error: "not-picking" }); return; }
      const players = await allPlayers(code);
      if (!players.length) { res.status(200).json({ ok: false, error: "no-players" }); return; }
      // Prefer someone other than last round's picker when possible.
      let pool = players;
      if (players.length > 1 && meta.lastPickerId) {
        const filtered = players.filter((p) => p.id !== meta.lastPickerId);
        if (filtered.length) pool = filtered;
      }
      const winner = pool[Math.floor(Math.random() * pool.length)];
      meta.picker = { id: winner.id, name: winner.name };
      meta.lastActive = now;
      await setMeta(code, meta);
      res.status(200).json({ ok: true, picker: meta.picker });
      return;
    }

    // ---- PICK CATEGORY -> serve a question -------------------------------
    if (action === "pick") {
      if (!isHost()) { res.status(403).json({ ok: false, error: "not-host" }); return; }
      if (meta.status !== "picking") { res.status(200).json({ ok: false, error: "not-picking" }); return; }
      const category = (paramOf(req, body, "category") || "").toString();
      const qi = pickQuestion(meta, category);
      if (qi < 0) { meta.status = "ended"; await setMeta(code, meta); res.status(200).json({ ok: true, status: "ended" }); return; }
      meta.used = (meta.used || []).concat([qi]);
      meta.current = qi;
      meta.category = category;
      meta.status = "question";
      meta.qStart = now;
      meta.lastActive = now;
      await redis(["SET", answeredKey(code), "0", "EX", String(GAME_TTL)]);
      await setMeta(code, meta);
      res.status(200).json({ ok: true });
      return;
    }

    // ---- REVEAL ----------------------------------------------------------
    if (action === "reveal") {
      if (!isHost()) { res.status(403).json({ ok: false, error: "not-host" }); return; }
      if (meta.status === "question") { meta.status = "reveal"; meta.lastActive = now; await setMeta(code, meta); }
      res.status(200).json({ ok: true });
      return;
    }

    // ---- NEXT ------------------------------------------------------------
    if (action === "next") {
      if (!isHost()) { res.status(403).json({ ok: false, error: "not-host" }); return; }
      if (meta.status === "question") {
        meta.status = "reveal";
      } else if (meta.status === "reveal") {
        meta.lastPickerId = meta.picker ? meta.picker.id : meta.lastPickerId;
        if (meta.round >= meta.rounds || !availableCategories(meta).length) {
          meta.status = "ended";
        } else {
          meta.round += 1;
          meta.status = "picking";
          meta.picker = null;
          meta.category = null;
          meta.current = -1;
        }
      }
      meta.lastActive = now;
      await setMeta(code, meta);
      res.status(200).json({ ok: true, status: meta.status });
      return;
    }

    // ---- RESET -----------------------------------------------------------
    if (action === "reset") {
      if (!isHost()) { res.status(403).json({ ok: false, error: "not-host" }); return; }
      const players = await allPlayers(code);
      for (const p of players) {
        await setPlayer(code, p.id, { name: p.name, score: 0, streak: 0, answeredQ: -1, lastChoice: -1, lastCorrect: false, lastPoints: 0, joinedAt: p.joinedAt || now });
      }
      meta.status = "lobby";
      meta.round = 0; meta.used = []; meta.current = -1; meta.qStart = 0;
      meta.picker = null; meta.lastPickerId = null; meta.category = null;
      meta.lastActive = now;
      await redis(["SET", answeredKey(code), "0", "EX", String(GAME_TTL)]);
      await setMeta(code, meta);
      res.status(200).json({ ok: true });
      return;
    }

    // ---- ANSWER ----------------------------------------------------------
    if (action === "answer") {
      const playerId = (paramOf(req, body, "playerId") || "").toString();
      const choice = parseInt(paramOf(req, body, "choice"), 10);
      if (meta.status !== "question") { res.status(200).json({ ok: false, error: "not-accepting" }); return; }
      const player = await getPlayer(code, playerId);
      if (!player) { res.status(200).json({ ok: false, error: "unknown-player" }); return; }
      if (player.answeredQ === meta.current) { res.status(200).json({ ok: true, already: true }); return; }
      if (!(choice >= 0 && choice <= 3)) { res.status(200).json({ ok: false, error: "bad-choice" }); return; }

      const q = currentQuestion(meta);
      const limitMs = meta.seconds * 1000;
      let elapsed = now - meta.qStart;
      if (elapsed < 0) elapsed = 0;
      if (elapsed > limitMs + 1500) { res.status(200).json({ ok: true, late: true }); return; }
      const usedMs = Math.min(elapsed, limitMs);

      const correct = choice === q.correct;
      let points = 0;
      if (correct) {
        const speed = 1 - (usedMs / limitMs) * 0.5;
        points = Math.round(BASE_POINTS * speed);
        if (points < MIN_CORRECT) points = MIN_CORRECT;
        points += Math.min(player.streak || 0, 5) * 50;
      }
      player.answeredQ = meta.current;
      player.lastChoice = choice;
      player.lastCorrect = correct;
      player.lastPoints = points;
      player.streak = correct ? (player.streak || 0) + 1 : 0;
      player.score = (player.score || 0) + points;
      await setPlayer(code, playerId, player);
      await redis(["INCR", answeredKey(code)]);
      res.status(200).json({ ok: true, locked: true });
      return;
    }

    // ---- STATE -----------------------------------------------------------
    if (action === "state") {
      const playerId = (paramOf(req, body, "playerId") || "").toString();
      const wantHost = !!paramOf(req, body, "host");
      const q = currentQuestion(meta);
      const revealing = meta.status === "reveal" || meta.status === "ended";

      const out = {
        ok: true, status: meta.status, code: meta.code,
        round: meta.round, rounds: meta.rounds, seconds: meta.seconds,
        current: meta.current, qStart: meta.qStart, now,
        picker: meta.picker || null, category: meta.category || null,
      };

      if (q && meta.current >= 0) {
        out.question = { text: q.q, cat: q.cat, options: q.options };
        if (revealing) { out.question.correct = q.correct; out.question.fact = q.fact; }
      }

      if (playerId) {
        const me = await getPlayer(code, playerId);
        out.you = me ? {
          id: playerId, name: me.name, score: me.score || 0, streak: me.streak || 0,
          answeredThisQ: me.answeredQ === meta.current,
          lastChoice: me.answeredQ === meta.current ? me.lastChoice : -1,
          lastCorrect: !!me.lastCorrect, lastPoints: me.lastPoints || 0,
        } : null;
      }

      if (meta.status === "question") {
        const a = await redis(["GET", answeredKey(code)]);
        out.answered = parseInt(a.result, 10) || 0;
      }

      // Heavier lists only when NOT in the answer-hammer phase.
      const needLists = wantHost || meta.status !== "question";
      if (needLists) {
        const players = await allPlayers(code);
        out.playerCount = players.length;
        out.board = leaderboard(players);
        if (meta.status === "lobby" || meta.status === "picking") {
          out.roster = players.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
        }
        if (meta.status === "picking") out.availableCategories = availableCategories(meta);
        if (revealing && q) {
          const dist = [0, 0, 0, 0];
          for (const p of players) if (p.answeredQ === meta.current && p.lastChoice >= 0 && p.lastChoice <= 3) dist[p.lastChoice]++;
          out.question.dist = dist;
        }
      } else {
        const players = await allPlayers(code);
        out.playerCount = players.length;
      }

      res.status(200).json(out);
      return;
    }

    res.status(400).json({ ok: false, error: "unknown-action" });
  } catch (err) {
    res.status(500).json({ ok: false, error: "server-error", detail: String(err) });
  }
};
