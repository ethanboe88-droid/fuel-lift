// Fuel & Lift — Cloudflare Worker API
// Static app lives in /public (served by Workers Assets). Everything under /api/* runs here.

const DEFAULT_GROUPS = {
  Chest: ["Bench press", "Incline dumbbell press", "Cable fly", "Dips"],
  Back: ["Pull-ups", "Barbell row", "Lat pulldown", "Seated cable row"],
  Shoulders: ["Overhead press", "Lateral raise", "Rear delt fly", "Face pull"],
  Biceps: ["Barbell curl", "Hammer curl", "Incline dumbbell curl"],
  Triceps: ["Rope pushdown", "Skull crushers", "Overhead extension"],
  Legs: ["Squat", "Romanian deadlift", "Leg press", "Leg curl", "Calf raise"],
  Abs: ["Hanging leg raise", "Cable crunch", "Plank"],
};
const DEFAULT_PLAN = {
  Mon: ["Chest", "Triceps"], Tue: ["Back", "Biceps"], Wed: ["Legs"], Thu: [],
  Fri: ["Shoulders", "Abs"], Sat: [], Sun: [],
};

const TEXT_MODEL = "claude-haiku-5-5";
const PHOTO_MODEL = "claude-sonnet-5-5";
const COOKIE = "fl_session";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: e.message || "Server error" }, e.status || 500);
    }
  },
};

// ---------- auth ----------
async function sessionToken(env) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.APP_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("fuel-lift-session-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function getCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function isAuthed(req, env) {
  if (!env.APP_PASSWORD) return false;
  return safeEqual(getCookie(req, COOKIE), await sessionToken(env));
}

// ---------- router ----------
async function api(req, env, url) {
  const p = url.pathname, m = req.method;

  if (p === "/api/login" && m === "POST") {
    if (!env.APP_PASSWORD) return json({ error: "APP_PASSWORD secret is not set in Cloudflare yet." }, 500);
    const { password } = await req.json();
    if (!safeEqual(String(password || ""), env.APP_PASSWORD)) {
      await new Promise((r) => setTimeout(r, 800));
      return json({ error: "Wrong password" }, 401);
    }
    const tok = await sessionToken(env);
    return json({ ok: true }, 200, {
      "set-cookie": `${COOKIE}=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
    });
  }
  if (p === "/api/logout" && m === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  if (!(await isAuthed(req, env))) return json({ error: "login" }, 401);
  const db = env.DB;

  if (p === "/api/state" && m === "GET") return json(await loadState(db, url.searchParams.get("today")));

  if (p === "/api/settings" && m === "POST") {
    const body = await req.json();
    const stmts = [];
    for (const k of ["goal", "proteinGoal", "groups", "plan"]) {
      if (body[k] !== undefined)
        stmts.push(db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .bind(k, JSON.stringify(body[k])));
    }
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  if (p === "/api/meals" && m === "POST") {
    const b = await req.json();
    if (!DAY_RE.test(b.day) || !(+b.calories >= 0)) return json({ error: "Bad meal" }, 400);
    const r = await db.prepare("INSERT INTO meals(day,name,calories,protein) VALUES(?,?,?,?) RETURNING id")
      .bind(b.day, String(b.name || "").slice(0, 120), Math.round(+b.calories), b.protein == null || b.protein === "" ? null : Math.round(+b.protein))
      .first();
    return json({ id: r.id });
  }
  if (p.startsWith("/api/meals/") && m === "DELETE") {
    await db.prepare("DELETE FROM meals WHERE id=?").bind(+p.split("/").pop()).run();
    return json({ ok: true });
  }

  if (p === "/api/check" && m === "POST") {
    const b = await req.json();
    if (!DAY_RE.test(b.week) || !b.k) return json({ error: "Bad check" }, 400);
    if (b.on) await db.prepare("INSERT OR IGNORE INTO checks(week,k) VALUES(?,?)").bind(b.week, b.k).run();
    else await db.prepare("DELETE FROM checks WHERE week=? AND k=?").bind(b.week, b.k).run();
    return json({ ok: true });
  }

  if (p === "/api/lifts" && m === "POST") {
    const b = await req.json();
    const r = await saveLift(db, b);
    return json({ id: r.id });
  }
  if (p.startsWith("/api/lifts/") && m === "DELETE") {
    await db.prepare("DELETE FROM lifts WHERE id=?").bind(+p.split("/").pop()).run();
    return json({ ok: true });
  }

  if (p === "/api/ai/parse" && m === "POST") return json(await aiParse(env, await req.json()));
  if (p === "/api/ai/recap" && m === "POST") return json(await aiRecap(env, await req.json()));

  return json({ error: "Not found" }, 404);
}

async function saveLift(db, b) {
  if (!DAY_RE.test(b.day) || !b.exercise) throw Object.assign(new Error("Bad lift"), { status: 400 });
  const n = (v) => (v == null || v === "" || isNaN(+v) ? null : +v);
  return db.prepare("INSERT INTO lifts(day,exercise,weight,reps,sets) VALUES(?,?,?,?,?) RETURNING id")
    .bind(b.day, String(b.exercise).slice(0, 80), n(b.weight), n(b.reps) && Math.round(n(b.reps)), n(b.sets) && Math.round(n(b.sets)))
    .first();
}

function addDays(day, n) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function loadState(db, today) {
  if (!DAY_RE.test(today || "")) today = new Date().toISOString().slice(0, 10);
  const since = addDays(today, -60);
  const [settings, meals, checks, lifts] = await db.batch([
    db.prepare("SELECT key,value FROM settings"),
    db.prepare("SELECT id,day,name,calories,protein FROM meals WHERE day>=? ORDER BY id").bind(since),
    db.prepare("SELECT week,k FROM checks WHERE week>=?").bind(addDays(today, -21)),
    db.prepare("SELECT id,day,exercise,weight,reps,sets FROM lifts WHERE day>=? ORDER BY day DESC, id DESC").bind(addDays(today, -120)),
  ]);
  const s = {};
  for (const r of settings.results) s[r.key] = JSON.parse(r.value);
  return {
    goal: s.goal || 0,
    proteinGoal: s.proteinGoal || 0,
    groups: s.groups || DEFAULT_GROUPS,
    plan: s.plan || DEFAULT_PLAN,
    meals: meals.results,
    checks: checks.results,
    lifts: lifts.results,
  };
}

// ---------- AI ----------
async function claude(env, { model, system, content, tool, maxTokens = 800 }) {
  if (!env.ANTHROPIC_API_KEY) throw Object.assign(new Error("ANTHROPIC_API_KEY secret is not set in Cloudflare yet."), { status: 500 });
  const body = { model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] };
  if (tool) { body.tools = [tool]; body.tool_choice = { type: "tool", name: tool.name }; }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error("AI error: " + (data.error?.message || r.status)), { status: 502 });
  if (tool) return data.content.find((c) => c.type === "tool_use")?.input || {};
  return data.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

const LOG_TOOL = {
  name: "log_entries",
  description: "Record food eaten and/or lifts performed.",
  input_schema: {
    type: "object",
    properties: {
      meals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short food name, e.g. 'Chipotle bowl (double chicken)'" },
            calories: { type: "integer" },
            protein: { type: "integer", description: "grams" },
          },
          required: ["name", "calories", "protein"],
        },
      },
      lifts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            exercise: { type: "string", description: "Use the exact name from the user's exercise list when it matches" },
            weight: { type: "number", description: "lbs; omit for bodyweight" },
            reps: { type: "integer" },
            sets: { type: "integer" },
          },
          required: ["exercise"],
        },
      },
      note: { type: "string", description: "One short line if anything was unclear or estimated loosely; otherwise empty" },
    },
    required: ["meals", "lifts"],
  },
};

async function aiParse(env, { text, image, exercises = [] }) {
  const system =
    "You turn a gym-goer's quick notes or a meal photo into log entries. " +
    "Food: estimate realistic calories and protein for typical US portions (restaurant chains: use their published numbers when you know them). " +
    "If one message lists several foods eaten together, return one combined meal unless they are clearly separate. " +
    "Lifts: weight in lbs. '185x5x3' or '185 for 5, 3 sets' = weight 185, reps 5, sets 3. " +
    "Map exercise names to this list when they match (case/wording can differ): " + JSON.stringify(exercises.slice(0, 200)) + ". " +
    "Return empty arrays for anything not mentioned. Always call log_entries.";
  const content = [];
  if (image) {
    const m = String(image).match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!m) throw Object.assign(new Error("Bad image"), { status: 400 });
    content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  content.push({ type: "text", text: (text || "").slice(0, 2000) || "Estimate this meal." });
  return claude(env, { model: image ? PHOTO_MODEL : TEXT_MODEL, system, content, tool: LOG_TOOL });
}

async function aiRecap(env, { summary }) {
  const system =
    "You are a blunt, encouraging training coach. Given one week of data, reply with exactly 3 short lines, no headers: " +
    "1) calories vs goal (average and how many days on target), 2) workouts done vs planned and any lift progress, " +
    "3) the single most useful thing to fix next week. Use only the numbers given; don't invent data.";
  const text = await claude(env, { model: TEXT_MODEL, system, content: [{ type: "text", text: JSON.stringify(summary).slice(0, 12000) }], maxTokens: 300 });
  return { text };
}
