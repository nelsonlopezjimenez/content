// Offline MDN server: serves the rari build (build/) rendered through Fred's
// SSR, the Fred client assets, and the offline mirror (offline/mirror/), with
// no network access and no rari/fred processes.
//
// Usage: npm run build && node scripts/offline/server.js
//
// Environment:
//   PORT          main site port (default 5042)
//   PLAY_PORT     live-sample runner port (default PORT + 1)
//   ORIGIN_MAIN   hostname clients use to reach this server (default localhost);
//                 the runner rejects iframes embedded from any other host.
//   BUILD_ROOT    rari build output (default build)
//   OFFLINE_ROOT  output of inventory.js/download.js (default offline)

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

import { BCD_HOST, BCD_PREFIX, localPathFor } from "./download.js";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const PORT = Number(process.env.PORT || 5042);
const PLAY_PORT = Number(process.env.PLAY_PORT || PORT + 1);
const BUILD_ROOT = path.resolve(REPO, process.env.BUILD_ROOT || "build");
const OFFLINE_ROOT = path.resolve(REPO, process.env.OFFLINE_ROOT || "offline");
const MIRROR = path.join(OFFLINE_ROOT, "mirror");
const FRED = path.join(REPO, "node_modules", "@mdn", "fred");
const FRED_OUT = path.join(FRED, "out");

// Fred reads these when its modules load, so set them before importing it.
Object.assign(process.env, {
  NODE_ENV: "production",
  FRED_PORT: String(PORT),
  FRED_PLAYGROUND_PORT: String(PLAY_PORT),
  FRED_PLAYGROUND_LOCAL: "true",
  ORIGIN_MAIN: process.env.ORIGIN_MAIN || "localhost",
});

const importFred = (rel) => import(pathToFileURL(path.join(FRED, rel)).href);
const { render } = await importFred("build/render.js");
const { handleRunner } = await importFred("vendor/yari/libs/play/index.js");
const { default: express } = await import("express");
const { default: cookieParser } = await import("cookie-parser");
const { default: compression } = await import("compression");

// --- Offline mirror ----------------------------------------------------------

const manifest = readJson(path.join(OFFLINE_ROOT, "manifest.json")) ?? {};
const contentTypeByPath = new Map(
  Object.values(manifest)
    .filter((e) => e.status === "ok" && e.contentType)
    .map((e) => [e.path, e.contentType]),
);
const mirrorCache = new Map();

/** Returns the local /_mirror/… URL for an external URL, or null. */
function mirrorUrl(rawUrl) {
  const url = rawUrl.replaceAll("&amp;", "&");
  if (mirrorCache.has(url)) return mirrorCache.get(url);
  let result = null;
  try {
    const [base, hash = ""] = url.split(/(?=#)/);
    const entry = manifest[base];
    let rel = entry?.status === "ok" ? entry.path : localPathFor(base);
    let abs = path.join(MIRROR, rel);
    if (isDir(abs) && isFile(path.join(abs, "index.html"))) {
      rel = path.posix.join(rel, "index.html");
      abs = path.join(MIRROR, rel);
    }
    if (isFile(abs)) result = `/_mirror/${encodeURI(rel)}${hash}`;
  } catch {
    // Not a URL we can map.
  }
  mirrorCache.set(url, result);
  return result;
}

function serveMirror() {
  return express.static(MIRROR, {
    setHeaders(res, filePath) {
      const rel = path.relative(MIRROR, filePath).split(path.sep).join("/");
      const type =
        contentTypeByPath.get(rel) ??
        (rel.startsWith("fonts.googleapis.com/") ? "text/css" : null);
      if (type) res.setHeader("Content-Type", type);
    },
  });
}

// --- HTML rewriting ----------------------------------------------------------

const RESOURCE_TAG =
  /<(a|area|link|img|image|source|video|audio|track|iframe|script|embed|object|input)\b[^>]*>/gi;
const URL_ATTR =
  /(\s(?:src|href|poster|data|xlink:href)=")(https?:\/\/[^"]+)(")/gi;
const SRCSET_ATTR = /(\ssrcset=")([^"]+)(")/gi;
const YOUTUBE_IFRAME =
  /<iframe\b[^>]*\ssrc="https:\/\/www\.youtube(?:-nocookie)?\.com\/embed\/([\w-]+)[^"]*"[^>]*>\s*<\/iframe>/gi;

const OFFLINE_STYLE = `<style>
a[data-offline-unavailable] { text-decoration-style: dotted; cursor: help; }
.offline-placeholder { display: grid; place-items: center; min-height: 12rem;
  padding: 1rem; border: 1px dashed currentColor; opacity: .7; text-align: center; }
.offline-scrim { min-height: 0; gap: .5rem; opacity: 1; border-radius: .5rem; }
.offline-scrim p { margin: 0; }
.offline-scrim code { overflow-wrap: anywhere; font-size: .8em; opacity: .7; }
</style>`;

// --- Scrimba embeds ----------------------------------------------------------

// Scrimba lessons are interactive recordings streamed from scrimba.com; there
// is nothing to mirror. Replace each embed with a notice and, when the page
// has exercise code next to it, a link that opens that code in the local
// Playground (/play runs on the offline runner like any live sample).

// Also swallows a wrapping <p>, since the placeholder is a block element.
const SCRIM_TAG =
  /(?:<p>\s*)?<(?:mdn-)?scrim-inline\b([^>]*)>[\s\S]*?<\/(?:mdn-)?scrim-inline>(?:\s*<\/p>)?/gi;
const attr = (attrs, name) =>
  attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1] ?? "";

function scrimPlaceholder(attrs, playUrl) {
  const title = attr(attrs, "scrimtitle");
  const url = attr(attrs, "url");
  return `<div class="offline-placeholder offline-scrim">
<p><strong>Interactive Scrimba lesson${title ? `: ${title}` : ""}</strong></p>
<p>This lesson streams from scrimba.com and is not available offline.</p>
${url ? `<p><code>${url}</code></p>` : ""}
${playUrl ? `<p><a class="button" data-variant="primary" href="${playUrl}">Practice with this exercise's code in the Playground</a></p>` : ""}
</div>`;
}

const decodeEntities = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&amp;/g, "&");

/** Code of the first live sample in a section, as Playground state. */
function sectionCode(content) {
  const blocks = [
    ...(content ?? "").matchAll(
      /<pre class="([^"]*)"><code>([\s\S]*?)<\/code><\/pre>/g,
    ),
  ]
    .map(([, cls, code]) => ({
      lang: cls.match(/\bbrush: (html|css|js)\b/)?.[1],
      ids: [...cls.matchAll(/\blive-sample___([\w-]+)/g)].map((m) => m[1]),
      code: decodeEntities(code),
    }))
    .filter((b) => b.lang);
  const id = blocks.flatMap((b) => b.ids).find((i) => !i.endsWith("-finish"));
  const picked = id ? blocks.filter((b) => b.ids.includes(id)) : blocks;
  if (picked.length === 0) return null;
  const code = { html: "", css: "", js: "" };
  for (const b of picked) code[b.lang] += b.code;
  return code;
}

function playUrl(code, srcPrefix) {
  const state = zlib.deflateRawSync(JSON.stringify(code)).toString("base64");
  const params = new URLSearchParams({ state, srcPrefix });
  return `/en-US/play?${params}`;
}

/** Replaces scrims in page content; the exercise is in this or a nearby section. */
function replaceScrims(page) {
  const body = page.doc?.body;
  if (!Array.isArray(body)) return;
  body.forEach((section, i) => {
    const content = section.value?.content;
    if (!content?.includes("scrim-inline")) return;
    const code = [body[i], body[i + 1], body[i - 1]]
      .map((s) => sectionCode(s?.value?.content))
      .find(Boolean);
    const link = code && playUrl(code, page.doc.mdn_url);
    section.value.content = content.replace(SCRIM_TAG, (_, attrs) =>
      scrimPlaceholder(attrs, link),
    );
  });
}

/**
 * Rewrites rendered page HTML: resources and links that exist in the mirror
 * point to /_mirror/…, other external links are flagged as unavailable, and
 * YouTube embeds become placeholders. Code shown in <pre> blocks is escaped
 * (`src=&quot;…`), so it is never matched and stays as the author wrote it.
 */
function rewritePage(html) {
  html = html
    .replaceAll(BCD_HOST, "")
    .replace(
      YOUTUBE_IFRAME,
      (_, id) =>
        `<div class="offline-placeholder">Video unavailable offline (YouTube ${id})</div>`,
    )
    // Scrims rendered by Fred templates (e.g. the curriculum landing page).
    .replace(SCRIM_TAG, (_, attrs) => scrimPlaceholder(attrs))
    .replace(RESOURCE_TAG, (tag, name) => {
      let unavailable = false;
      tag = tag
        .replace(URL_ATTR, (m, pre, url, post) => {
          const local = siteUrl(url) ?? mirrorUrl(url);
          if (local) return pre + local + post;
          if (/^a(rea)?$/i.test(name)) unavailable = true;
          return m;
        })
        .replace(
          SRCSET_ATTR,
          (m, pre, value, post) =>
            pre +
            value.replace(/https?:\/\/[^\s,]+/g, (u) => mirrorUrl(u) ?? u) +
            post,
        );
      if (unavailable && !tag.includes("data-offline-unavailable")) {
        const title = /\stitle="/i.test(tag)
          ? ""
          : ` title="External link, unavailable offline"`;
        tag = tag.replace(
          /^<a(rea)?\b/i,
          (open) => `${open} data-offline-unavailable${title}`,
        );
      }
      return tag;
    });
  return html.replace("</head>", `${OFFLINE_STYLE}</head>`);
}

/** Links to MDN itself become same-site paths. */
function siteUrl(url) {
  const m = url.match(/^https?:\/\/developer\.mozilla\.org(\/[^"]*)?$/i);
  return m ? m[1] || "/" : null;
}

/** Live samples are executable code, so every mirrored URL is rewritten. */
function rewriteRunner(html) {
  return html.replace(/https?:\/\/[^\s"'`<>)\\]+/g, (u) => mirrorUrl(u) ?? u);
}

// --- Build lookup ------------------------------------------------------------

// rari writes lowercase folders and escapes characters that are invalid in
// file names on some platforms.
function buildPath(urlPath) {
  const rel = decodeURIComponent(urlPath)
    .toLowerCase()
    .replaceAll("::", "_doublecolon_")
    .replaceAll(":", "_colon_")
    .replaceAll("*", "_star_")
    .replaceAll("?", "_question_")
    .replace(/^\/+|\/+$/g, "");
  const abs = path.resolve(BUILD_ROOT, rel);
  return abs.startsWith(BUILD_ROOT) ? abs : null;
}

const redirects = new Map();
for (const locale of fs.readdirSync(path.join(REPO, "files"))) {
  const file = path.join(REPO, "files", locale, "_redirects.txt");
  if (!isFile(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [from, to] = line.trim().split("\t");
    if (from && to) redirects.set(from.toLowerCase(), siteUrl(to) ?? to);
  }
}

const pageCache = new Map();
const PAGE_CACHE_SIZE = 500;

async function renderPage(jsonFile, url) {
  const key = `${jsonFile}\n${url}`;
  if (pageCache.has(key)) return pageCache.get(key);
  const page = readJson(jsonFile);
  if (!page?.renderer) return null;
  replaceScrims(page);
  const html = rewritePage(await render({ ...page, url }));
  if (pageCache.size >= PAGE_CACHE_SIZE) {
    pageCache.delete(pageCache.keys().next().value);
  }
  pageCache.set(key, html);
  return html;
}

async function sendPage(req, res, jsonFile, status = 200) {
  const html = await renderPage(jsonFile, req.path);
  if (html === null) return false;
  res.status(status).type("html").send(html);
  return true;
}

function serveBuild() {
  return async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    try {
      const target = redirects.get(req.path.replace(/\/$/, "").toLowerCase());
      if (target) return res.redirect(301, target);

      const abs = buildPath(req.path);
      if (!abs) return next();
      if (isFile(abs)) return res.sendFile(abs);
      const json = path.join(abs, "index.json");
      if (isFile(json) && (await sendPage(req, res, json))) return;
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function notFound(req, res) {
  const locale = req.path.split("/")[1]?.toLowerCase() || "en-us";
  for (const l of [locale, "en-us"]) {
    const json = path.join(BUILD_ROOT, l, "404", "index.json");
    if (isFile(json) && (await sendPage(req, res, json, 404))) return;
  }
  res.status(404).type("text").send("Not found");
}

// --- BCD (browser compatibility tables) --------------------------------------

const BCD_DIR = path.join(MIRROR, new URL(BCD_HOST).hostname, BCD_PREFIX);
const bcdCache = new Map();

function bcdRoot(query) {
  const parts = query.split(".");
  for (let i = parts.length; i > 0; i--) {
    const rootQuery = parts.slice(0, i).join(".");
    const file = path.join(BCD_DIR, `${rootQuery}.json`);
    if (!isFile(file)) continue;
    if (!bcdCache.has(rootQuery)) {
      if (bcdCache.size > 200) bcdCache.delete(bcdCache.keys().next().value);
      bcdCache.set(rootQuery, readJson(file));
    }
    return { root: bcdCache.get(rootQuery), rest: parts.slice(i) };
  }
  return null;
}

function serveBcd(req, res) {
  const query = req.params.file.replace(/\.json$/, "");
  const found = bcdRoot(query);
  let data = found?.root.data;
  for (const key of found?.rest ?? []) data = data?.[key];
  if (!data) return res.status(404).json({ error: `No BCD data for ${query}` });
  res.json({ ...found.root, query, data });
}

// --- Fred client assets ------------------------------------------------------

// The client bundle has the BCD API origin compiled in; serve patched copies
// so compat tables request /bcd/api/… from this server instead.
const patchedAssets = new Map();
for (const dir of ["client", "legacy"]) {
  const abs = path.join(FRED_OUT, "static", dir);
  for (const name of fs.readdirSync(abs)) {
    if (!name.endsWith(".js")) continue;
    const source = fs.readFileSync(path.join(abs, name), "utf8");
    if (source.includes(BCD_HOST)) {
      patchedAssets.set(
        `/static/${dir}/${name}`,
        source.replaceAll(BCD_HOST, ""),
      );
    }
  }
}

// --- Servers -----------------------------------------------------------------

const app = express();
app.use(compression());
app.use((req, res, next) => {
  const patched = patchedAssets.get(req.path);
  if (patched) return res.type("js").send(patched);
  next();
});
app.use(express.static(FRED_OUT, { index: false }));
app.use("/static", (_req, res) => res.status(404).end());
app.use("/_mirror", serveMirror());
app.get(`${BCD_PREFIX}:file`, serveBcd);
app.get("/", (_req, res) => res.redirect(302, "/en-US/"));
app.all(["/api/*_", "/users/*_", "/pong/*_", "/pimg/*_"], (_req, res) =>
  res.status(503).json({ error: "Not available offline" }),
);
app.use(serveBuild());
app.use(notFound);

const play = express();
play.use(cookieParser());
play.get(["/*_/runner.html", "/runner.html"], (req, res) => {
  const send = res.send.bind(res);
  res.send = (body) =>
    send(typeof body === "string" ? rewriteRunner(body) : body);
  return handleRunner(req, res);
});
play.use("/_mirror", serveMirror());
play.use(
  "/shared-assets",
  express.static(path.join(MIRROR, "mdn.github.io", "shared-assets")),
);
play.use(serveBuild());

app.listen(PORT, () => console.log(`MDN offline: http://localhost:${PORT}/`));
play.listen(PLAY_PORT, () =>
  console.log(`Live sample runner: http://localhost:${PLAY_PORT}/`),
);

// --- Helpers -----------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isFile(p) {
  return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
}

function isDir(p) {
  return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
}
