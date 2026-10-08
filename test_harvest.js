const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

async function testHarvest() {
  console.log("Launching headless stealth browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    console.log("Navigating to https://app.trakt.tv/discover/popular ...");
    await page.goto("https://app.trakt.tv/discover/popular", { waitUntil: "networkidle2", timeout: 45000 });
    
    // Wait a few seconds for Svelte hydration
    await new Promise(r => setTimeout(r, 4000));

    const pageTitle = await page.title();
    console.log("Page Title:", pageTitle);

    // Extract links & text
    const items = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll("a[href*='/movies/'], a[href*='/shows/']");
      links.forEach(l => {
        const text = l.innerText.trim();
        const href = l.getAttribute("href");
        if (href && (href.startsWith("/movies/") || href.startsWith("/shows/"))) {
          results.push({ href, text });
        }
      });
      return results;
    });

    console.log("Found raw items count:", items.length);
    console.log("Sample items:", items.slice(0, 8));
    await browser.close();
  } catch (err) {
    console.error("Error during harvest:", err.message);
    await browser.close();
  }
}

testHarvest();
