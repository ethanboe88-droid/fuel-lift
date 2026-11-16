// The Big EO Fitness — Cloudflare Worker API (multi-user, Clerk auth)
// Static app lives in /public (served by Workers Assets). Everything under /api/* runs here.
//
// Security model:
//   * Every /api/* route except /api/config requires "Authorization: Bearer <Clerk session token>".
//   * The token is verified here with Clerk's public key (CLERK_JWT_KEY): signature, expiry, and
//     that it was issued for this site's origin (azp). The user ID comes ONLY from the verified
//     token's `sub` claim, never from the request body or URL.
//   * Every query filters by that user ID, including UPDATE/DELETE by row id.

import { verifyToken } from "@clerk/backend";

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
const SETTING_KEYS = ["goal", "proteinGoal", "groups", "plan", "favorites", "goalWeight"];

const TEXT_MODEL = "claude-haiku-5-5";
const PHOTO_MODEL = "claude-sonnet-5-5";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
const httpError = (msg, status) => Object.assign(new Error(msg), { status });

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      if (!e.status || e.status >= 500) console.error(e);
      return json({ error: e.message || "Server error" }, e.status || 500);
    }
  },
};

// ---------- auth ----------
function allowedOrigins(env, url) {
  const extra = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [url.origin, ...extra];
}

// Returns the verified Clerk user ID, or throws 401.
async function requireUser(req, env, url) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) throw httpError("login", 401);
  if (!env.CLERK_JWT_KEY) throw httpError("CLERK_JWT_KEY is not configured", 500);
  let res;
  try {
    res = await verifyToken(token, {
      jwtKey: env.CLERK_JWT_KEY.replace(/\\n/g, "\n"),
      authorizedParties: allowedOrigins(env, url),
    });
  } catch (e) {
    throw httpError("login", 401);
  }
  const payload = res && res.data !== undefined ? res.data : res;
  if ((res && res.errors) || !payload || typeof payload.sub !== "string" || !payload.sub.startsWith("user_"))
    throw httpError("login", 401);
  return payload.sub;
}

// The owner's pre-accounts data (rows with no user_id + the old single-user settings/checks tables)
// is attached to OWNER_USER_ID the first time the owner signs in. Runs once; safe to re-run.
async function claimLegacyData(db, env, userId) {
  if (!env.OWNER_USER_ID || userId !== env.OWNER_USER_ID) return;
  const done = await db.prepare("SELECT value FROM app_meta WHERE key='legacy_claimed'").first();
  if (done) {
    // still sweep any rows the old app wrote after the first claim (e.g. during rollout)
    await db.batch([
      db.prepare("UPDATE meals SET user_id=? WHERE user_id IS NULL").bind(userId),
      db.prepare("UPDATE lifts SET user_id=? WHERE user_id IS NULL").bind(userId),
    ]);
    return;
  }
  await db.batch([
    db.prepare("UPDATE meals SET user_id=? WHERE user_id IS NULL").bind(userId),
    db.prepare("UPDATE lifts SET user_id=? WHERE user_id IS NULL").bind(userId),
    db.prepare(
      `INSERT OR IGNORE INTO user_settings(user_id,key,value)
       SELECT ?, key, value FROM settings WHERE key IN ('goal','proteinGoal','groups','plan','favorites')`
    ).bind(userId),
    db.prepare("INSERT OR IGNORE INTO user_checks(user_id,week,k) SELECT ?, week, k FROM checks").bind(userId),
    db.prepare("INSERT INTO app_meta(key,value) VALUES('legacy_claimed', ?)").bind(userId + " " + new Date().toISOString()),
  ]);
}

// ---------- router ----------
async function api(req, env, url) {
  const p = url.pathname, m = req.method;

  // Public, non-secret config the app needs before sign-in.
  if (p === "/api/config" && m === "GET") {
    return json({ clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || "" });
  }

  const uid = await requireUser(req, env, url);
  const db = env.DB;

  if (p === "/api/state" && m === "GET") {
    await claimLegacyData(db, env, uid);
    return json(await loadState(db, uid, url.searchParams.get("today"), env));
  }

  if (p === "/api/settings" && m === "POST") {
    const body = await req.json();
    const stmts = [];
    for (const k of SETTING_KEYS) {
      if (body[k] !== undefined) {
        const v = JSON.stringify(body[k]);
        if (v.length > 50000) throw httpError("Setting too large", 400);
        stmts.push(db.prepare(
          "INSERT INTO user_settings(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value"
        ).bind(uid, k, v));
      }
    }
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  if (p === "/api/meals" && m === "POST") {
    const b = await req.json();
    if (!DAY_RE.test(b.day) || !(+b.calories >= 0) || +b.calories > 20000) return json({ error: "Bad meal" }, 400);
    const r = await db.prepare("INSERT INTO meals(user_id,day,name,calories,protein) VALUES(?,?,?,?,?) RETURNING id")
      .bind(uid, b.day, String(b.name || "").slice(0, 120), Math.round(+b.calories), b.protein == null || b.protein === "" ? null : Math.round(+b.protein))
      .first();
    return json({ id: r.id });
  }
  if (p.startsWith("/api/meals/") && m === "DELETE") {
    const r = await db.prepare("DELETE FROM meals WHERE id=? AND user_id=?").bind(+p.split("/").pop(), uid).run();
    if (!r.meta.changes) return json({ error: "Not found" }, 404);
    return json({ ok: true });
  }

  if (p === "/api/check" && m === "POST") {
    const b = await req.json();
    if (!DAY_RE.test(b.week) || !b.k || String(b.k).length > 200) return json({ error: "Bad check" }, 400);
    if (b.on) await db.prepare("INSERT OR IGNORE INTO user_checks(user_id,week,k) VALUES(?,?,?)").bind(uid, b.week, String(b.k)).run();
    else await db.prepare("DELETE FROM user_checks WHERE user_id=? AND week=? AND k=?").bind(uid, b.week, String(b.k)).run();
    return json({ ok: true });
  }

  if (p === "/api/lifts" && m === "POST") {
    const r = await saveLift(db, uid, await req.json());
    return json({ id: r.id });
  }
  if (p.startsWith("/api/lifts/") && m === "DELETE") {
    const r = await db.prepare("DELETE FROM lifts WHERE id=? AND user_id=?").bind(+p.split("/").pop(), uid).run();
    if (!r.meta.changes) return json({ error: "Not found" }, 404);
    return json({ ok: true });
  }

  if (p === "/api/weights" && m === "POST") {
    const b = await req.json();
    const w = Math.round(+b.weight * 10) / 10;
    if (!DAY_RE.test(b.day) || !(w >= 50 && w <= 800)) return json({ error: "Enter a weight between 50 and 800 lb" }, 400);
    const r = await db.prepare(
      "INSERT INTO weights(user_id,day,weight) VALUES(?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET weight=excluded.weight RETURNING id"
    ).bind(uid, b.day, w).first();
    return json({ id: r.id, day: b.day, weight: w });
  }
  if (p.startsWith("/api/weights/") && m === "DELETE") {
    const r = await db.prepare("DELETE FROM weights WHERE id=? AND user_id=?").bind(+p.split("/").pop(), uid).run();
    if (!r.meta.changes) return json({ error: "Not found" }, 404);
    return json({ ok: true });
  }

  if (p === "/api/ai/parse" && m === "POST") {
    await useAiCredit(db, env, uid);
    return json(await aiParse(env, await req.json()));
  }
  if (p === "/api/ai/recap" && m === "POST") {
    await useAiCredit(db, env, uid);
    return json(await aiRecap(env, await req.json()));
  }

  return json({ error: "Not found" }, 404);
}

// Daily AI cap per user (owner is exempt). AI_DAILY_LIMIT defaults to 30.
async function useAiCredit(db, env, uid) {
  if (env.OWNER_USER_ID && uid === env.OWNER_USER_ID) return;
  const limit = Number(env.AI_DAILY_LIMIT || 30);
  const day = new Date().toISOString().slice(0, 10);
  const row = await db.prepare(
    "INSERT INTO ai_usage(user_id,day,n) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET n=n+1 RETURNING n"
  ).bind(uid, day).first();
  if (row.n > limit) throw httpError(`Daily AI limit reached (${limit}/day). Log manually or try again tomorrow.`, 429);
}

async function saveLift(db, uid, b) {
  if (!DAY_RE.test(b.day) || !b.exercise) throw httpError("Bad lift", 400);
  const n = (v) => (v == null || v === "" || isNaN(+v) ? null : +v);
  return db.prepare("INSERT INTO lifts(user_id,day,exercise,weight,reps,sets) VALUES(?,?,?,?,?,?) RETURNING id")
    .bind(uid, b.day, String(b.exercise).slice(0, 80), n(b.weight), n(b.reps) && Math.round(n(b.reps)), n(b.sets) && Math.round(n(b.sets)))
    .first();
}

function addDays(day, n) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function loadState(db, uid, today, env) {
  if (!DAY_RE.test(today || "")) today = new Date().toISOString().slice(0, 10);
  const [settings, meals, checks, lifts, weights] = await db.batch([
    db.prepare("SELECT key,value FROM user_settings WHERE user_id=?").bind(uid),
    db.prepare("SELECT id,day,name,calories,protein FROM meals WHERE user_id=? AND day>=? ORDER BY id").bind(uid, addDays(today, -60)),
    db.prepare("SELECT week,k FROM user_checks WHERE user_id=? AND week>=?").bind(uid, addDays(today, -21)),
    db.prepare("SELECT id,day,exercise,weight,reps,sets FROM lifts WHERE user_id=? AND day>=? ORDER BY day DESC, id DESC").bind(uid, addDays(today, -120)),
    db.prepare("SELECT id,day,weight FROM weights WHERE user_id=? AND day>=? ORDER BY day").bind(uid, addDays(today, -400)),
  ]);
  const s = {};
  for (const r of settings.results) s[r.key] = JSON.parse(r.value);
  return {
    goal: s.goal || 0,
    proteinGoal: s.proteinGoal || 0,
    groups: s.groups || DEFAULT_GROUPS,
    plan: s.plan || DEFAULT_PLAN,
    favorites: s.favorites || [],
    meals: meals.results,
    checks: checks.results,
    lifts: lifts.results,
    weights: weights.results,
    goalWeight: s.goalWeight || 0,
    isOwner: !!(env.OWNER_USER_ID && uid === env.OWNER_USER_ID),
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

async function aiParse(env, { text, image, exercises = [], favorites = [] }) {
  const system =
    "You turn a gym-goer's quick notes or a meal photo into log entries. " +
    "Food: estimate realistic calories and protein for typical US portions (restaurant chains: use their published numbers when you know them). " +
    "If one message lists several foods eaten together, return one combined meal unless they are clearly separate. " +
    "Lifts: weight in lbs. '185x5x3' or '185 for 5, 3 sets' = weight 185, reps 5, sets 3. " +
    "Map exercise names to this list when they match (case/wording can differ): " + JSON.stringify(exercises.slice(0, 200)) + ". " +
    (favorites.length ? "The user's saved foods (use these exact numbers when they mention one, e.g. 'my usual shake'): " + JSON.stringify(favorites.slice(0, 100)) + ". " : "") +
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
