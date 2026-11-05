// Cloudflare Worker: relays Sina real-time futures quotes to the browser.
// Sina requires a Referer header and sends no CORS headers, so a static site cannot call it directly.
//
// Deploy:  npx wrangler deploy   (from this folder)
// Then set CONFIG.quoteProxy in assets/js/config.js to the worker URL.
//
// Only "nf_" futures symbols are relayed, so the worker cannot be used as an open proxy.

const ALLOWED_ORIGINS = [
  "https://sock-wy.github.io",
  "http://localhost:8000",
];
const SYMBOL = /^nf_[A-Z]{1,2}\d{0,4}$/;

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const list = (new URL(request.url).searchParams.get("list") || "").split(",").filter(Boolean);
    if (!list.length || list.length > 20 || !list.every((s) => SYMBOL.test(s))) {
      return new Response("bad symbol list", { status: 400, headers: cors });
    }
    const upstream = await fetch(`https://hq.sinajs.cn/list=${list.join(",")}`, {
      headers: { Referer: "https://finance.sina.com.cn" },
      cf: { cacheTtl: 3 },
    });
    const buf = await upstream.arrayBuffer();
    const text = new TextDecoder("gbk").decode(buf);
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "max-age=3" },
    });
  },
};
