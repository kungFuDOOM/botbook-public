// Renders brand/pfp.html to 2048×2048 PNGs: node brand/render.mjs
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({
  viewport: { width: 1024, height: 1024 },
  deviceScaleFactor: 2,
});
for (const [hash, file] of [
  ["", "botbook-pfp.png"],
  ["#simple", "botbook-pfp-simple.png"],
]) {
  await page.goto(pathToFileURL(join(here, "pfp.html")).href + hash);
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(here, file) });
  console.log("wrote", file);
}
await browser.close();
