const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

async function inspect() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    console.log("Visiting https://trakt.tv/movies/trending ...");
    await page.goto("https://trakt.tv/movies/trending", { waitUntil: "networkidle2", timeout: 45000 });
    
    const html = await page.content();
    console.log("HTML length:", html.length);
    console.log("Title:", await page.title());

    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a")).map(a => ({ href: a.href, text: a.innerText.trim() })).filter(x => x.text && x.href.includes("/movies/"));
    });
    console.log("Found movie links on trakt.tv:", links.slice(0, 10));

    await browser.close();
  } catch (err) {
    console.error("Error:", err.message);
    await browser.close();
  }
}

inspect();
