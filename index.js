export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Webhook endpoint Telegram
    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      const data = await request.json();
      const chatId = data.message?.chat?.id;
      const text = data.message?.text?.trim();

      // Pastikan hanya admin yang bisa tambah API key
      if (chatId !== parseInt(env.ADMIN_ID)) {
        await sendMessage(env, chatId, "❌ Kamu tidak punya akses.");
        return new Response("Forbidden", { status: 403 });
      }

      // Perintah untuk tambah API key
      if (text?.startsWith("/add_api")) {
        try {
          // Format: /add_api <apikey> <owner> <limit>
          const [, apiKey, owner, limitStr] = text.split(" ");
          if (!apiKey || !owner || !limitStr) {
            await sendMessage(env, chatId, "⚠ Format salah!\nGunakan: `/add_api key owner limit`", true);
            return new Response("Bad Request", { status: 400 });
          }

          const limit = parseInt(limitStr);
          if (isNaN(limit)) {
            await sendMessage(env, chatId, "⚠ Limit harus angka.");
            return new Response("Bad Request", { status: 400 });
          }

          const value = JSON.stringify({
            owner,
            limit,
            usage: 0,
            created_at: Date.now()
          });

          await env["Gen-api-txt2img"].put(apiKey, value);

          await sendMessage(env, chatId, `✅ API key berhasil disimpan.\nKey: \`${apiKey}\`\nOwner: ${owner}\nLimit: ${limit}`, true);
        } catch (err) {
          await sendMessage(env, chatId, `⚠ Error: ${err.message}`);
        }
      }

      return new Response("OK");
    }

    // Endpoint untuk cek API key
    if (url.pathname === "/check") {
      const key = url.searchParams.get("key");
      if (!key) return new Response(JSON.stringify({ error: "No key" }), { status: 400 });

      const value = await env["Gen-api-txt2img"].get(key);
      if (!value) return new Response(JSON.stringify({ error: "Invalid key" }), { status: 404 });

      return new Response(value, { headers: { "Content-Type": "application/json" } });
    }

    return new Response("Hello Worker KV API");
  }
};

async function sendMessage(env, chatId, text, markdown = false) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: markdown ? "Markdown" : undefined
  };

  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}
