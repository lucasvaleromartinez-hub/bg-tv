// Relais BG TV (Cloudflare Worker)
// La page BG TV est en https : le navigateur refuse les flux en http.
// Ce relais va chercher le flux (http, adresse IP, port exotique, serveur Shoutcast « ICY »)
// et le renvoie en https, avec les en-têtes CORS. Les listes HLS (.m3u8) sont réécrites
// pour que chaque segment passe aussi par le relais.
// Utilisation : https://<ton-relais>.workers.dev/r?u=<lien du flux encodé>
import { connect } from "cloudflare:sockets";

const ALLOWED_ORIGINS = ["https://lucasvaleromartinez-hub.github.io"];
const UA = "VLC/3.0.20 LibVLC/3.0.20";

const cors = (origin) => ({
  "access-control-allow-origin": origin || "*",
  "access-control-allow-headers": "icy-metadata, range",
  "access-control-expose-headers": "icy-metaint, icy-name, content-type",
  "vary": "origin",
});

const isPlaylist = (url, type) => /mpegurl/i.test(type || "") || /\.m3u8(\?|$)/i.test(url);

function rewritePlaylist(text, base, self) {
  const wrap = (u) => self + "?u=" + encodeURIComponent(new URL(u, base).href);
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
    return wrap(t);
  }).join("\n");
}

// Requête HTTP/1.0 « à la main » par socket TCP : marche avec les adresses IP,
// tous les ports, et les vieux serveurs Shoutcast qui répondent « ICY 200 OK ».
async function rawHttp(url, extra) {
  const port = Number(url.port) || 80;
  const socket = connect({ hostname: url.hostname, port });
  const writer = socket.writable.getWriter();
  const lines = [
    `GET ${url.pathname || "/"}${url.search} HTTP/1.0`,
    `Host: ${url.host}`,
    `User-Agent: ${UA}`,
    "Accept: */*",
    "Connection: close",
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    "", "",
  ];
  await writer.write(new TextEncoder().encode(lines.join("\r\n")));
  writer.releaseLock();

  const reader = socket.readable.getReader();
  let buf = new Uint8Array(0);
  let headEnd = -1;
  while (headEnd < 0) {
    const { value, done } = await reader.read();
    if (done) throw new Error("connexion fermée");
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf); next.set(value, buf.length);
    buf = next;
    for (let i = 3; i < buf.length; i++) {
      if (buf[i - 3] === 13 && buf[i - 2] === 10 && buf[i - 1] === 13 && buf[i] === 10) { headEnd = i + 1; break; }
    }
    if (headEnd < 0 && buf.length > 16384) throw new Error("en-têtes trop longs");
  }
  const head = new TextDecoder("latin1").decode(buf.slice(0, headEnd)).split("\r\n");
  const status = Number((head[0].match(/^\S+\s+(\d{3})/) || [])[1] || 0);
  const headers = new Headers();
  for (const l of head.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) { try { headers.append(l.slice(0, i).trim(), l.slice(i + 1).trim()); } catch {} }
  }
  const rest = buf.slice(headEnd);
  const body = new ReadableStream({
    start(c) { if (rest.length) c.enqueue(rest); },
    async pull(c) {
      const { value, done } = await reader.read();
      if (done) { c.close(); return; }
      c.enqueue(value);
    },
    cancel() { try { socket.close(); } catch {} },
  });
  return { status, headers, body };
}

async function getStream(target, extra) {
  let url = new URL(target);
  for (let hop = 0; hop < 6; hop++) {
    let r;
    if (url.protocol === "https:") {
      const res = await fetch(url.href, { headers: { "user-agent": UA, ...extra }, redirect: "manual" });
      r = { status: res.status, headers: res.headers, body: res.body };
    } else {
      r = await rawHttp(url, extra);
    }
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      try { r.body && r.body.cancel(); } catch {}
      url = new URL(loc, url);
      continue;
    }
    return { ...r, finalUrl: url.href };
  }
  throw new Error("trop de redirections");
}

export default {
  async fetch(req, env) {
    const here0 = new URL(req.url);
    // Hors /r : on sert l'appli BG TV elle-même (fichiers du dépôt).
    if (here0.pathname !== "/r" && env && env.ASSETS) return env.ASSETS.fetch(req);
    const origin = req.headers.get("origin") || "";
    const referer = req.headers.get("referer") || "";
    const allowed = [...ALLOWED_ORIGINS, here0.origin];
    const okOrigin = !origin || allowed.includes(origin);
    const okReferer = !referer || allowed.some((o) => referer.startsWith(o));
    if (!okOrigin || !okReferer) return new Response("Accès refusé", { status: 403 });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

    const here = new URL(req.url);
    if (here.pathname !== "/r") return new Response("Relais BG TV : OK", { headers: cors(origin) });
    let target;
    try { target = new URL(here.searchParams.get("u") || ""); } catch { return new Response("Lien manquant", { status: 400, headers: cors(origin) }); }
    if (!/^https?:$/.test(target.protocol)) return new Response("Lien refusé", { status: 400, headers: cors(origin) });

    const extra = {};
    const icy = req.headers.get("icy-metadata");
    if (icy) extra["Icy-MetaData"] = icy;
    const range = req.headers.get("range");
    if (range) extra["Range"] = range;

    let r;
    try { r = await getStream(target.href, extra); }
    catch (e) { return new Response("Flux injoignable : " + e.message, { status: 502, headers: cors(origin) }); }

    const type = r.headers.get("content-type") || "";
    const out = new Headers(cors(origin));
    for (const h of ["content-type", "icy-metaint", "icy-name", "content-range", "accept-ranges"]) {
      const v = r.headers.get(h);
      if (v) out.set(h, v);
    }
    // Les vieux serveurs Shoutcast n'annoncent pas toujours le type : on le devine.
    if (!type) out.set("content-type", /\.aac/i.test(r.finalUrl) ? "audio/aac" : /\.ogg|\.opus/i.test(r.finalUrl) ? "audio/ogg" : "audio/mpeg");
    out.set("cache-control", "no-store");
    const status = r.status === 0 || r.status === 200 ? 200 : r.status;

    if (status < 300 && isPlaylist(r.finalUrl, type)) {
      const text = await new Response(r.body).text();
      if (text.trimStart().startsWith("#EXTM3U")) {
        out.set("content-type", "application/vnd.apple.mpegurl");
        return new Response(rewritePlaylist(text, r.finalUrl, here.origin + here.pathname), { status: 200, headers: out });
      }
      return new Response(text, { status, headers: out });
    }
    return new Response(r.body, { status, headers: out });
  },
};
