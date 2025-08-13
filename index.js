// ===== Utils =====
const API_KEY_PREFIX = "sk-";
const API_KEY_LENGTH = 48; // panjang body tanpa prefix

function b62rand(n = API_KEY_LENGTH) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function generateApiKey() {
  return API_KEY_PREFIX + b62rand();
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,X-API-Key",
  };
}

function ok(text = "OK") {
  return new Response(text, { status: 200, headers: corsHeaders() });
}

function parseBearer(req) {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

async function readBodyMaybeJSON(req) {
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await req.json();
    if (ct.includes("application/x-www-form-urlencoded")) {
      const form = await req.formData();
      const obj = {};
      for (const [k, v] of form.entries()) obj[k] = v;
      return obj;
    }
    try { return await req.json(); } catch { /* fallthrough */ }
  }
  return null;
}

// ===== Core KV access =====
// Value schema: { owner: string, limit: number, usage: number, created_at: number, revoked?: boolean }
async function getApiRecord(env, key) {
  const raw = await env["Gen-api-txt2img"].get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function putApiRecord(env, key, obj) {
  await env["Gen-api-txt2img"].put(key, JSON.stringify(obj));
}

async function requireApiKey(env, req, url, { countUsage = true } = {}) {
  // Ambil dari header atau query
  const key =
    parseBearer(req) ||
    req.headers.get("x-api-key") ||
    url.searchParams.get("key");

  if (!key) {
    throw { status: 401, body: { error: "Missing API key" } };
  }
  if (!key.startsWith(API_KEY_PREFIX) || key.length < API_KEY_PREFIX.length + 16) {
    throw { status: 403, body: { error: "Invalid API key format" } };
  }

  const rec = await getApiRecord(env, key);
  if (!rec) throw { status: 403, body: { error: "Invalid API key" } };
  if (rec.revoked) throw { status: 403, body: { error: "API key revoked" } };

  if (rec.usage >= rec.limit) {
    // Auto-block bila habis
    throw { status: 429, body: { error: "API limit exceeded" } };
  }

  if (countUsage) {
    // NOTE: KV tidak atomic; untuk beban ringan ini cukup.
    rec.usage += 1;
    await putApiRecord(env, key, rec);
  }

  return { key, rec };
}

// ===== Telegram Bot helpers =====
async function tgSend(env, chatId, text, markdown = false) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: markdown ? "Markdown" : undefined,
    disable_web_page_preview: true,
  };
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function isAdmin(env, chatId) {
  return String(chatId) === String(env.ADMIN_ID);
}

function helpText() {
  return [
    "*Admin Commands*",
    "`/register <username> <limit>`  → generate API key baru",
    "`/revoke <api_key>`             → revoke API key",
    "`/setlimit <api_key> <limit>`   → update limit key",
    "`/info <api_key>`               → detail key",
  ].join("\n");
}

// ===== Handlers =====
async function handleTelegramWebhook(env, req) {
  const update = await req.json().catch(() => ({}));
  const msg = update.message || update.edited_message || {};
  const chatId = msg.chat?.id;
  const text = (msg.text || "").trim();

  if (!isAdmin(env, chatId)) {
    if (chatId) await tgSend(env, chatId, "❌ Kamu tidak punya akses.");
    return ok();
  }

  if (!text || text === "/start") {
    await tgSend(env, chatId, "Hai admin 👋\n\n" + helpText(), true);
    return ok();
  }

  // /register <username> <limit>
  if (text.startsWith("/register")) {
    const [, username, limitStr] = text.split(/\s+/);
    if (!username || !limitStr) {
      await tgSend(env, chatId, "⚠️ Format salah.\n`/register <username> <limit>`", true);
      return ok();
    }
    const limit = parseInt(limitStr);
    if (Number.isNaN(limit) || limit < 1) {
      await tgSend(env, chatId, "⚠️ Limit harus angka > 0.");
      return ok();
    }

    const apiKey = generateApiKey();
    const record = {
      owner: username,
      limit,
      usage: 0,
      created_at: Date.now(),
    };
    await putApiRecord(env, apiKey, record);

    await tgSend(
      env,
      chatId,
      [
        "✅ API key berhasil dibuat.",
        `*Username*: ${username}`,
        `*Key*: \`${apiKey}\``,
        `*Limit*: ${limit}`,
      ].join("\n"),
      true
    );
    return ok();
  }

  // /revoke <api_key>
  if (text.startsWith("/revoke")) {
    const [, apiKey] = text.split(/\s+/);
    if (!apiKey) {
      await tgSend(env, chatId, "⚠️ Format salah.\n`/revoke <api_key>`", true);
      return ok();
    }
    const rec = await getApiRecord(env, apiKey);
    if (!rec) {
      await tgSend(env, chatId, "❌ Key tidak ditemukan.");
      return ok();
    }
    rec.revoked = true;
    await putApiRecord(env, apiKey, rec);
    await tgSend(env, chatId, "✅ Key sudah *revoked*.", true);
    return ok();
  }

  // /setlimit <api_key> <limit>
  if (text.startsWith("/setlimit")) {
    const [, apiKey, limitStr] = text.split(/\s+/);
    const limit = parseInt(limitStr);
    if (!apiKey || Number.isNaN(limit) || limit < 1) {
      await tgSend(env, chatId, "⚠️ Format salah.\n`/setlimit <api_key> <limit>`", true);
      return ok();
    }
    const rec = await getApiRecord(env, apiKey);
    if (!rec) {
      await tgSend(env, chatId, "❌ Key tidak ditemukan.");
      return ok();
    }
    rec.limit = limit;
    if (rec.usage > rec.limit) rec.usage = rec.limit; // clamp
    await putApiRecord(env, apiKey, rec);
    await tgSend(env, chatId, `✅ Limit diupdate ke *${limit}*.`, true);
    return ok();
  }

  // /info <api_key>
  if (text.startsWith("/info")) {
    const [, apiKey] = text.split(/\s+/);
    if (!apiKey) {
      await tgSend(env, chatId, "⚠️ Format salah.\n`/info <api_key>`", true);
      return ok();
    }
    const rec = await getApiRecord(env, apiKey);
    if (!rec) {
      await tgSend(env, chatId, "❌ Key tidak ditemukan.");
      return ok();
    }
    const remain = Math.max(0, rec.limit - rec.usage);
    await tgSend(
      env,
      chatId,
      [
        "*Key Info*",
        `Owner: ${rec.owner}`,
        `Usage: ${rec.usage}/${rec.limit} (sisa ${remain})`,
        `Created: ${new Date(rec.created_at).toISOString()}`,
        `Revoked: ${rec.revoked ? "ya" : "tidak"}`,
      ].join("\n"),
      true
    );
    return ok();
  }

  await tgSend(env, chatId, "🙃 Perintah tidak dikenal.\n\n" + helpText(), true);
  return ok();
}

// Public API: protected by API key
async function handleV1(env, req, url) {
  const path = url.pathname;

  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Semua endpoint v1 harus pakai API key
  let auth;
  try {
    // /v1/me tidak menambah usage ketika cek status
    const count = !path.endsWith("/me");
    auth = await requireApiKey(env, req, url, { countUsage: count });
  } catch (e) {
    const { status = 403, body = { error: "Forbidden" } } = e || {};
    return json(body, status, corsHeaders());
  }

  if (path.endsWith("/hello")) {
    return json(
      {
        message: "Hello from kv-api 👋",
        owner: auth.rec.owner,
        usage: auth.rec.usage,
        limit: auth.rec.limit,
      },
      200,
      corsHeaders()
    );
  }

  if (path.endsWith("/echo")) {
    const body = (await readBodyMaybeJSON(req)) ?? {};
    return json(
      {
        ok: true,
        echo: body,
        usage: auth.rec.usage,
        limit: auth.rec.limit,
      },
      200,
      corsHeaders()
    );
  }

  if (path.endsWith("/me")) {
    // Tidak menambah usage; tampilkan status key saat ini
    const rec = await getApiRecord(env, auth.key);
    const remain = Math.max(0, rec.limit - rec.usage);
    return json(
      {
        key_prefix: auth.key.slice(0, 12) + "...",
        owner: rec.owner,
        usage: rec.usage,
        limit: rec.limit,
        remaining: remain,
        revoked: !!rec.revoked,
        created_at: rec.created_at,
      },
      200,
      corsHeaders()
    );
  }

  return json({ error: "Not Found" }, 404, corsHeaders());
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight global
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Telegram webhook admin only
    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      return handleTelegramWebhook(env, request);
    }

    // Protected API namespace
    if (url.pathname.startsWith("/v1/")) {
      return handleV1(env, request, url);
    }

    // Health
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ status: "ok", service: "kv-api" }, 200, corsHeaders());
    }

    return json({ error: "Not Found" }, 404, corsHeaders());
  },
};
