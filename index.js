const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const PORT = process.env.PORT || 7088;
const CACHE_FILE = path.join(__dirname, "trakt_cache.json");
const KEY_FILE = path.join(__dirname, "trakt_key.json");

let activeApiKey = process.env.TRAKT_API_KEY || "201dc70c5ec6af530f12f079ea1922733f6e1085ad7b02f36d8e011b75bcea7d";

if (fs.existsSync(KEY_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(KEY_FILE, "utf-8"));
    if (data.key) activeApiKey = data.key;
  } catch (e) {}
}

const CACHE = {
  trakt_trending_movies: [],
  trakt_trending_shows: [],
  trakt_popular_movies: [],
  trakt_popular_shows: [],
  trakt_watched_weekly: [],
  trakt_anticipated: [],
  trakt_boxoffice: []
};

// Load saved cache
if (fs.existsSync(CACHE_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    Object.assign(CACHE, saved);
    console.log("Loaded cached data from disk.");
  } catch (e) {}
}

// Sniff active session key if expired
async function sniffActiveKey() {
  console.log("[Key Sniffer] Sniffing live session key from app.trakt.tv...");
  let discoveredKey = null;

  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    page.on("request", (req) => {
      const headers = req.headers();
      if (headers["trakt-api-key"] && !discoveredKey) {
        discoveredKey = headers["trakt-api-key"];
      }
    });

    await page.goto("https://app.trakt.tv/discover/popular", { waitUntil: "networkidle2", timeout: 35000 });
    await new Promise(r => setTimeout(r, 2000));
    await browser.close();

    if (discoveredKey) {
      activeApiKey = discoveredKey;
      fs.writeFileSync(KEY_FILE, JSON.stringify({ key: activeApiKey, updated: new Date() }));
      console.log(`[Key Sniffer] ✓ Acquired active key: ${activeApiKey.slice(0, 8)}...`);
      return true;
    }
  } catch (err) {
    console.error("[Key Sniffer] Error:", err.message);
  }
  return false;
}

// Fetch from Trakt Edge API
async function fetchTraktEdge(endpoint) {
  const url = `https://apiz.trakt.tv${endpoint}`;
  const options = {
    headers: {
      "trakt-api-key": activeApiKey,
      "trakt-api-version": "2",
      "referer": "https://app.trakt.tv/",
      "origin": "https://app.trakt.tv",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  };

  let res = await fetch(url, options);

  if (res.status === 401 || res.status === 403) {
    console.warn(`[Edge API] Key rejected (${res.status}). Refreshing key via Stealth Harvester...`);
    const refreshed = await sniffActiveKey();
    if (refreshed) {
      options.headers["trakt-api-key"] = activeApiKey;
      res = await fetch(url, options);
    }
  }

  if (!res.ok) {
    throw new Error(`Trakt Edge returned HTTP ${res.status}: ${res.statusText}`);
  }

  return await res.json();
}

// Helper: Format Trakt item to Stremio Meta
function formatMeta(entry, type) {
  const media = entry.movie || entry.show || entry;
  const imdbId = media.ids?.imdb;
  if (!imdbId) return null;

  let posterUrl = `https://images.metahub.space/poster/medium/${imdbId}/img`;
  if (media.images?.poster?.[0]) {
    posterUrl = `https://${media.images.poster[0]}`;
  }

  let desc = media.overview || media.tagline || "";
  if (typeof desc === "string") {
    desc = desc.replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim();
  }

  return {
    id: imdbId,
    type: type,
    name: media.title || "Untitled",
    poster: posterUrl,
    description: desc,
    releaseInfo: media.year ? `${media.year}` : undefined,
    imdbRating: media.rating ? media.rating.toFixed(1) : undefined,
    genres: (media.genres || []).map(g => g.charAt(0).toUpperCase() + g.slice(1))
  };
}

// Endpoint map for on-demand pagination
const ENDPOINT_MAP = {
  trakt_trending_movies: { path: "/movies/trending", type: "movie" },
  trakt_trending_shows: { path: "/shows/trending", type: "series" },
  trakt_popular_movies: { path: "/movies/popular", type: "movie" },
  trakt_popular_shows: { path: "/shows/popular", type: "series" },
  trakt_watched_weekly: { path: "/movies/watched/weekly", type: "movie" },
  trakt_anticipated: { path: "/movies/anticipated", type: "movie" },
  trakt_boxoffice: { path: "/movies/boxoffice", type: "movie" }
};

// Fetch specific page on-demand
async function fetchPage(catalogId, pageNum) {
  const config = ENDPOINT_MAP[catalogId];
  if (!config) return [];

  try {
    const raw = await fetchTraktEdge(`${config.path}?extended=full%2Cimages&page=${pageNum}&limit=100`);
    return (raw || []).map(i => formatMeta(i, config.type)).filter(Boolean);
  } catch (e) {
    console.error(`Failed on-demand page ${pageNum} for ${catalogId}:`, e.message);
    return [];
  }
}

// Pre-fetch deep catalogs (500 items = 5 pages per feed)
async function fetchDeepFeed(basePath, type) {
  try {
    const pages = await Promise.all([
      fetchTraktEdge(`${basePath}?extended=full%2Cimages&page=1&limit=100`),
      fetchTraktEdge(`${basePath}?extended=full%2Cimages&page=2&limit=100`).catch(() => []),
      fetchTraktEdge(`${basePath}?extended=full%2Cimages&page=3&limit=100`).catch(() => []),
      fetchTraktEdge(`${basePath}?extended=full%2Cimages&page=4&limit=100`).catch(() => []),
      fetchTraktEdge(`${basePath}?extended=full%2Cimages&page=5&limit=100`).catch(() => [])
    ]);
    const combined = pages.flat();
    return combined.map(i => formatMeta(i, type)).filter(Boolean);
  } catch (err) {
    console.error(`Error fetching ${basePath}:`, err.message);
    return [];
  }
}

// Refresh all feeds (500 items per category)
async function refreshAllFeeds() {
  console.log("\n[Harvester] Scraping deep 500-item catalogs from Trakt...");
  try {
    const [
      trendingMovies,
      trendingShows,
      popMovies,
      popShows,
      watchedWeekly,
      anticipated,
      boxOffice
    ] = await Promise.all([
      fetchDeepFeed("/movies/trending", "movie"),
      fetchDeepFeed("/shows/trending", "series"),
      fetchDeepFeed("/movies/popular", "movie"),
      fetchDeepFeed("/shows/popular", "series"),
      fetchDeepFeed("/movies/watched/weekly", "movie"),
      fetchDeepFeed("/movies/anticipated", "movie"),
      fetchTraktEdge("/movies/boxoffice?extended=full%2Cimages").then(r => r.map(i => formatMeta(i, "movie")).filter(Boolean)).catch(() => [])
    ]);

    if (trendingMovies.length) CACHE.trakt_trending_movies = trendingMovies;
    if (trendingShows.length) CACHE.trakt_trending_shows = trendingShows;
    if (popMovies.length) CACHE.trakt_popular_movies = popMovies;
    if (popShows.length) CACHE.trakt_popular_shows = popShows;
    if (watchedWeekly.length) CACHE.trakt_watched_weekly = watchedWeekly;
    if (anticipated.length) CACHE.trakt_anticipated = anticipated;
    if (boxOffice.length) CACHE.trakt_boxoffice = boxOffice;

    fs.writeFileSync(CACHE_FILE, JSON.stringify(CACHE, null, 2));
    console.log(`[Harvester] ✓ Deep Catalogs Cached:`);
    console.log(` - Trending Movies: ${CACHE.trakt_trending_movies.length}`);
    console.log(` - Trending Series: ${CACHE.trakt_trending_shows.length}`);
    console.log(` - Popular Movies: ${CACHE.trakt_popular_movies.length}`);
    console.log(` - Popular Series: ${CACHE.trakt_popular_shows.length}`);
    console.log(` - Watched Weekly: ${CACHE.trakt_watched_weekly.length}`);
    console.log(` - Anticipated: ${CACHE.trakt_anticipated.length}`);
  } catch (err) {
    console.error("[Harvester Error]:", err.message);
  }
}

const GENRE_LIST = [
  "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary",
  "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery",
  "Romance", "Science-fiction", "Thriller", "War", "Western"
];

// Manifest with pagination & genre filters enabled
const manifest = {
  id: "community.trakt.stealth.harvester",
  version: "1.2.0",
  name: "⚡ Trakt Real Trends & Discovery",
  description: "Live real-time Trakt Popular, Trending, Anticipated & Most Watched feeds with infinite scrolling.",
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [
    {
      id: "trakt_trending_movies",
      type: "movie",
      name: "🔥 Trakt: Trending Movies",
      extra: [
        { name: "skip", isRequired: false },
        { name: "genre", isRequired: false, options: GENRE_LIST }
      ]
    },
    {
      id: "trakt_trending_shows",
      type: "series",
      name: "🔥 Trakt: Trending Series",
      extra: [
        { name: "skip", isRequired: false },
        { name: "genre", isRequired: false, options: GENRE_LIST }
      ]
    },
    {
      id: "trakt_popular_movies",
      type: "movie",
      name: "🌟 Trakt: Popular Movies",
      extra: [
        { name: "skip", isRequired: false },
        { name: "genre", isRequired: false, options: GENRE_LIST }
      ]
    },
    {
      id: "trakt_popular_shows",
      type: "series",
      name: "🌟 Trakt: Popular Series",
      extra: [
        { name: "skip", isRequired: false },
        { name: "genre", isRequired: false, options: GENRE_LIST }
      ]
    },
    {
      id: "trakt_watched_weekly",
      type: "movie",
      name: "⏱️ Trakt: Most Watched This Week",
      extra: [
        { name: "skip", isRequired: false },
        { name: "genre", isRequired: false, options: GENRE_LIST }
      ]
    },
    {
      id: "trakt_anticipated",
      type: "movie",
      name: "🚀 Trakt: Most Anticipated",
      extra: [
        { name: "skip", isRequired: false },
        { name: "genre", isRequired: false, options: GENRE_LIST }
      ]
    },
    {
      id: "trakt_boxoffice",
      type: "movie",
      name: "🍿 Trakt: Box Office Top 10",
      extra: [
        { name: "skip", isRequired: false }
      ]
    }
  ]
};

// Helper: Send JSON with exact Content-Length, optional gzip, and edge caching
function sendJson(req, res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  const buffer = Buffer.from(jsonStr, "utf-8");

  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "public, max-age=600");

  const acceptEncoding = req.headers["accept-encoding"] || "";
  if (acceptEncoding.includes("gzip") && buffer.length > 512) {
    const compressed = zlib.gzipSync(buffer);
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Content-Length", compressed.length);
    res.end(compressed);
  } else {
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  }
}

// HTTP Server with Universal URL Parser (Supports Path + Query params + On-demand pages)
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  const [pathname, queryString] = req.url.split("?");

  if (pathname === "/" && req.headers.accept && req.headers.accept.includes("text/html")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
    const proto = req.headers["x-forwarded-proto"] || "http";
    const manifestUrl = `${proto}://${host}/manifest.json`;
    const stremioUrl = `stremio://${host}/manifest.json`;

    return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⚡ Trakt Real Trends & Discovery</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0c0d14; color: #fff; margin: 0; padding: 40px 20px; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
    .card { background: #151722; border: 1px solid #282b3c; border-radius: 16px; max-width: 520px; width: 100%; padding: 36px; text-align: center; box-shadow: 0 12px 35px rgba(0,0,0,0.5); }
    h1 { font-size: 26px; margin: 0 0 10px; background: linear-gradient(135deg, #a855f7, #6366f1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    p { color: #9ca3af; font-size: 15px; line-height: 1.5; margin: 0 0 24px; }
    .btn { display: inline-block; background: #6366f1; color: #fff; text-decoration: none; font-weight: 600; padding: 14px 28px; border-radius: 10px; font-size: 16px; transition: background 0.2s; box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4); }
    .btn:hover { background: #4f46e5; }
    .input-box { margin-top: 24px; background: #0c0d14; border: 1px solid #282b3c; border-radius: 8px; padding: 10px 14px; font-size: 13px; color: #9ca3af; word-break: break-all; }
    .features { text-align: left; margin: 24px 0 0; padding: 16px; background: #0c0d14; border-radius: 10px; font-size: 13px; color: #d1d5db; }
    .features li { margin-bottom: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚡ Trakt Real Trends</h1>
    <p>Live real-time Trakt Popular, Trending, Anticipated & Most Watched feeds for Stremio with infinite scrolling.</p>
    <a href="${stremioUrl}" class="btn">🚀 Install on Stremio</a>
    <div class="features">
      <strong>✨ Features:</strong>
      <ul>
        <li>🔥 Trending Movies & Series (Real-Time)</li>
        <li>🌟 Popular Catalogs (500+ Items Each)</li>
        <li>⏱️ Most Watched Weekly & Anticipated</li>
        <li>🍿 Box Office Top 10</li>
        <li>♾️ Infinite Scrolling Pagination</li>
      </ul>
    </div>
    <div class="input-box">Manifest: <code>${manifestUrl}</code></div>
  </div>
</body>
</html>`);
  }

  if (pathname === "/manifest.json" || pathname === "/") {
    return sendJson(req, res, 200, manifest);
  }

  // Matches: /catalog/:type/:id.json OR /catalog/:type/:id/:extra.json
  const match = pathname.match(/^\/catalog\/([^\/]+)\/([^\/\.]+?)(?:\/([^\/\.]+?))?\.json$/);
  if (match) {
    const [, type, id, extraInPath] = match;
    let skip = 0;
    let selectedGenre = null;

    // 1. Parse from path extra (e.g. /skip=100.json or /genre=Action&skip=100.json)
    if (extraInPath) {
      const decodedExtra = decodeURIComponent(extraInPath);
      const params = new URLSearchParams(decodedExtra);
      if (params.has("skip")) skip = parseInt(params.get("skip"), 10) || 0;
      if (params.has("genre")) selectedGenre = params.get("genre").toLowerCase();
    }

    // 2. Parse from query string (e.g. ?skip=100&genre=Action)
    if (queryString) {
      const queryParams = new URLSearchParams(queryString);
      if (queryParams.has("skip")) skip = parseInt(queryParams.get("skip"), 10) || 0;
      if (queryParams.has("genre")) selectedGenre = queryParams.get("genre").toLowerCase();
    }

    let items = CACHE[id] || [];
    const PAGE_SIZE = 50;

    // If skip requires items beyond what is currently in cache, fetch on-demand!
    if (skip + PAGE_SIZE > items.length && id !== "trakt_boxoffice") {
      const targetPage = Math.floor(skip / 100) + 1;
      console.log(`[On-Demand] Fetching live page ${targetPage} for ${id} (skip=${skip})...`);
      const extraItems = await fetchPage(id, targetPage);
      if (extraItems.length) {
        CACHE[id] = [...items, ...extraItems];
        items = CACHE[id];
      }
    }

    // Apply Genre Filter if selected
    if (selectedGenre) {
      items = items.filter(item => 
        item.genres?.some(g => g.toLowerCase() === selectedGenre)
      );
    }

    // Return slice based on skip (50 items for optimal speed & stability)
    const paginatedMetas = items.slice(skip, skip + PAGE_SIZE);
    return sendJson(req, res, 200, { metas: paginatedMetas });
  }

  return sendJson(req, res, 404, { error: "Not found" });
});

// Configure keep-alive timeouts to prevent proxy connection truncation
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

async function main() {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Trakt Discovery Harvester (Infinite Scrolling) Active!`);
    console.log(`📡 Manifest URL: http://0.0.0.0:${PORT}/manifest.json`);
    console.log(`======================================================\n`);
  });

  // Delay background refresh so startup is instantaneous and does not choke CPU
  setTimeout(refreshAllFeeds, 5 * 60 * 1000);
  setInterval(refreshAllFeeds, 30 * 60 * 1000);
}

main();
