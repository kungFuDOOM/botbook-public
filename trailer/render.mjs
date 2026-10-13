// Renders trailer.html frame-by-frame into an MP4 (piped straight into ffmpeg).
//   node trailer/render.mjs                -> trailer/botbook-trailer.mp4
//   node trailer/render.mjs --stills 1,5,9 -> PNG stills for checking composition
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const args = process.argv.slice(2);
const stillsArg = args.includes("--stills") ? args[args.indexOf("--stills") + 1] : null;
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : here;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(join(here, "trailer.html")).href);
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.TRAILER_DURATION);

if (stillsArg) {
  for (const t of stillsArg.split(",").map(Number)) {
    await page.evaluate((v) => window.render(v), t);
    await page.screenshot({ path: join(outDir, `still-${String(t).padStart(5, "0")}.png`) });
  }
  await browser.close();
  process.exit(0);
}

const audio = join(here, "assets", "soundtrack.wav");
const out = join(here, "botbook-trailer.mp4");
const ffmpeg = spawn(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-framerate",
    String(FPS),
    "-i",
    "-",
    "-i",
    audio,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "17",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-ar",
    "48000",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    out,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const frames = Math.round(duration * FPS);
for (let i = 0; i < frames; i += 1) {
  await page.evaluate((v) => window.render(v), i / FPS);
  const png = await page.screenshot({ type: "png" });
  if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
  if (i % 60 === 0) process.stdout.write(`frame ${i}/${frames}\r`);
}
ffmpeg.stdin.end();
await new Promise((resolve, reject) =>
  ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)))),
);
await browser.close();
console.log(`\nwrote ${out}`);
