# ⚡ Trakt Real Trends & Discovery (Stremio Addon)

A high-performance Stremio catalog addon delivering deep, real-time Trakt Popular, Trending, Anticipated, and Most Watched feeds with infinite scrolling.

---

## ✨ Features
* 🔥 **Trending Movies & Series** (Updated in real-time)
* 🌟 **Popular Catalogs** (Deep 500+ items each)
* ⏱️ **Most Watched Weekly**
* 🚀 **Most Anticipated Releases**
* 🍿 **Box Office Top 10**
* ♾️ **Infinite Scrolling Pagination** (`skip` support)
* 🎭 **Genre Filtering** (Action, Sci-Fi, Horror, etc.)
* ⚡ **Pre-Cached Instant Response** (Loads under 50ms)

---

## 🚀 Free 1-Click Cloud Deployment (Render.com)

1. Fork or push this repository to your GitHub account.
2. Go to [Render.com](https://dashboard.render.com/) and click **New +** -> **Web Service**.
3. Connect your repository.
4. Render will automatically detect the settings:
   * **Runtime:** Node
   * **Build Command:** `PUPPETEER_SKIP_DOWNLOAD=true npm install`
   * **Start Command:** `node index.js`
5. Click **Deploy Web Service**.
6. Once deployed, open your Render URL in your browser and click **Install on Stremio**!

---

## 💻 Local Development

```bash
git clone https://github.com/Manteh/stremio-trakt-stealth-harvester.git
cd stremio-trakt-stealth-harvester
npm install
node index.js
```

Addon manifest will be available at:
`http://localhost:7088/manifest.json`
