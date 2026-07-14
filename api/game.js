// Disney Trivia — game engine (serverless, Upstash Redis via REST).
//
// One endpoint, action-based (POST body.action or ?action=).
//   create  {}                              -> { code, hostToken }
//   start   {code, hostToken, num, seconds} -> begins round 1
//   next    {code, hostToken}               -> question -> reveal -> next question -> ... -> ended
//   reveal  {code, hostToken}               -> lock current question, show the answer
//   answer  {code, playerId, choice}        -> record a player's answer (server-timed)
//   join    {code, name}                    -> { playerId, name }
//   state   {code, playerId?, host?}        -> current game state (safe for that viewer)
//   reset   {code, hostToken}               -> back to lobby, keep players, scores zeroed
//
// Storage keys (all expire after a few hours so games self-clean):
//   dt:game:CODE      string JSON  -> meta (status, current question, timing, settings)
//   dt:players:CODE   hash         -> field = playerId, value = JSON player {name,score,...}
//   dt:answered:CODE  integer      -> # answered on the current question (atomic INCR)
//
// Scoring rewards SPEED + ACCURACY, Kahoot-style:
//   correct answer -> 500..1000 pts (instant = 1000, at the buzzer = 500)
//   + streak bonus -> up to +250 for a hot streak
//   wrong / no answer -> 0

const QUESTIONS = require("./questions.js");

const BASE_POINTS = 1000;
const MIN_CORRECT = 500;
const MAX_PLAYERS = 40;      // party cap (comfortably covers "up to 35")
const GAME_TTL = 60 * 60 * 4; // 4 hours
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I

// ---- Redis plumbing (same pattern as the Win Wall app) -------------------

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
    headers: {
      Authorization: `Bearer ${conn.token}`,
      "Content-Type": "application/json",
    },
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

// Returns array of {id, ...player}
async function allPlayers(code) {
  const res = await redis(["HGETALL", playersKey(code)]);
  const flat = res.result || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try {
      const p = JSON.parse(flat[i + 1]);
      out.push(Object.assign({ id: flat[i] }, p));
    } catch { /* skip */ }
  }
  return out;
}

// ---- helpers -------------------------------------------------------------

function randId(len, chars) {
  let s = "";
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function currentQuestion(meta) {
  if (!meta || meta.current < 0 || !meta.order) return null;
  const qi = meta.order[meta.current];
  return QUESTIONS[qi];
}

// Board = players ranked by score desc, then name.
function leaderboard(players) {
  return players
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (a.name || "").localeCompare(b.name || ""))
    .map((p, i) => ({
      rank: i + 1,
      name: p.name,
      score: p.score || 0,
      streak: p.streak || 0,
      lastPoints: p.lastPoints || 0,
      lastCorrect: !!p.lastCorrect,
      id: p.id,
    }));
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

  if (getConn() === null) {
    res.status(200).json({ ok: false, error: "storage-not-connected" });
    return;
  }

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
        code: newCode,
        hostToken,
        status: "lobby",     // lobby | question | reveal | ended
        current: -1,
        order: [],
        seconds: 20,
        total: QUESTIONS.length,
        createdAt: now,
        lastActive: now,
        qStart: 0,
      };
      await setMeta(newCode, meta);
      // Initialise empty players hash so it exists with a TTL.
      await redis(["DEL", playersKey(newCode)]);
      await redis(["DEL", answeredKey(newCode)]);
      res.status(200).json({ ok: true, code: newCode, hostToken });
      return;
    }

    // Everything past here needs a real game.
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
      // Nudge duplicate names so the board stays readable.
      const taken = new Set(players.map((p) => (p.name || "").toLowerCase()));
      if (taken.has(name.toLowerCase())) {
        let n = 2;
        while (taken.has((name + " " + n).toLowerCase())) n++;
        name = name + " " + n;
      }
      const playerId = randId(12, "abcdefghijklmnopqrstuvwxyz0123456789");
      const player = { name, score: 0, streak: 0, answeredQ: -1, lastChoice: -1, lastCorrect: false, lastPoints: 0, joinedAt: now };
      await setPlayer(code, playerId, player);
      meta.lastActive = now;
      await setMeta(code, meta);
      res.status(200).json({ ok: true, playerId, name });
      return;
    }

    // ---- START -----------------------------------------------------------
    if (action === "start") {
      if (!isHost()) { res.status(403).json({ ok: false, error: "not-host" }); return; }
      let num = parseInt(paramOf(req, body, "num"), 10);
      let seconds = parseInt(paramOf(req, body, "seconds"), 10);
      if (!num || num < 1) num = Math.min(12, QUESTIONS.length);
      num = Math.min(num, QUESTIONS.length);
      if (!seconds || seconds < 5) seconds = 20;
      seconds = Math.min(seconds, 60);
      meta.order = shuffle(QUESTIONS.map((_, i) => i)).slice(0, num);
      meta.seconds = seconds;
      meta.current = 0;
      meta.status = "question";
      meta.qStart = now;
      meta.lastActive = now;
      await redis(["SET", answeredKey(code), "0", "EX", String(GAME_TTL)]);
      await setMeta(code, meta);
      res.status(200).json({ ok: true });
      return;
    }

    // ---- REVEAL (lock current question) ----------------------------------
    if (action === "reveal") {
      if (!isHost()) { res.status(403).json({ ok: false, error: "not-host" }); return; }
      if (meta.status === "question") {
        meta.status = "reveal";
        meta.lastActive = now;
        await setMeta(code, meta);
      }
      res.status(200).json({ ok: true });
      return;
    }

    // ---- NEXT ------------------------------------------------------------
    if (action === "next") {
      if (!isHost()) { res.status(403).json({ ok: false, error: "not-host" }); return; }
      // From a live question, "next" first reveals it.
      if (meta.status === "question") {
        meta.status = "reveal";
      } else if (meta.status === "reveal" || meta.status === "lobby") {
        const nextIdx = meta.current + 1;
        if (nextIdx >= meta.order.length) {
          meta.status = "ended";
        } else {
          meta.current = nextIdx;
          meta.status = "question";
          meta.qStart = now;
          await redis(["SET", answeredKey(code), "0", "EX", String(GAME_TTL)]);
        }
      }
      meta.lastActive = now;
      await setMeta(code, meta);
      res.status(200).json({ ok: true, status: meta.status });
      return;
    }

    // ---- RESET (play again with same crowd) ------------------------------
    if (action === "reset") {
      if (!isHost()) { res.status(403).json({ ok: false, error: "not-host" }); return; }
      const players = await allPlayers(code);
      for (const p of players) {
        await setPlayer(code, p.id, {
          name: p.name, score: 0, streak: 0, answeredQ: -1,
          lastChoice: -1, lastCorrect: false, lastPoints: 0, joinedAt: p.joinedAt || now,
        });
      }
      meta.status = "lobby";
      meta.current = -1;
      meta.order = [];
      meta.qStart = 0;
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
      // Small grace window for network latency past the buzzer.
      if (elapsed > limitMs + 1500) { res.status(200).json({ ok: true, late: true }); return; }
      const usedMs = Math.min(elapsed, limitMs);

      const correct = choice === q.correct;
      let points = 0;
      if (correct) {
        const speed = 1 - (usedMs / limitMs) * 0.5;      // 1.0 instant -> 0.5 at buzzer
        points = Math.round(BASE_POINTS * speed);
        if (points < MIN_CORRECT) points = MIN_CORRECT;
        const priorStreak = player.streak || 0;           // streak BEFORE this answer
        points += Math.min(priorStreak, 5) * 50;          // up to +250 hot-streak bonus
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
        ok: true,
        status: meta.status,
        code: meta.code,
        current: meta.current,
        qNumber: meta.current + 1,
        qCount: meta.order ? meta.order.length : 0,
        seconds: meta.seconds,
        qStart: meta.qStart,
        now,
      };

      if (q && meta.current >= 0) {
        out.question = {
          text: q.q,
          category: q.category,
          options: q.options,
        };
        if (revealing) {
          out.question.correct = q.correct;
          out.question.fact = q.fact;
        }
      }

      // Player-specific slice ("you").
      if (playerId) {
        const me = await getPlayer(code, playerId);
        if (me) {
          out.you = {
            name: me.name,
            score: me.score || 0,
            streak: me.streak || 0,
            answeredThisQ: me.answeredQ === meta.current,
            lastChoice: me.answeredQ === meta.current ? me.lastChoice : -1,
            lastCorrect: !!me.lastCorrect,
            lastPoints: me.lastPoints || 0,
          };
        } else {
          out.you = null; // player was reset/removed
        }
      }

      // How many have locked in this question (cheap atomic counter).
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
        // Answer distribution for the just-revealed question.
        if (revealing && q) {
          const dist = [0, 0, 0, 0];
          for (const p of players) {
            if (p.answeredQ === meta.current && p.lastChoice >= 0 && p.lastChoice <= 3) dist[p.lastChoice]++;
          }
          out.question.dist = dist;
        }
        if (meta.status === "lobby") {
          out.lobby = players.map((p) => ({ name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
        }
      } else {
        // Lightweight count during the hammer phase.
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
