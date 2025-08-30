#!/usr/bin/env node
// index.mjs
import fs from "fs/promises";
import path from "path";
import os from "os";
import sharp from "sharp";

// ---- tiny CLI parser (commands: init | build | html | all) ----
const args = process.argv.slice(2);
const cmd = args[0] || "all";
const getArg = (flag, fallback = undefined) => {
  const i = args.indexOf(flag);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("-")) return args[i + 1];
  return fallback;
};
const configPath = getArg("-c", "resizer.config.json");
const configAbsPath = path.resolve(configPath);
const configDir = path.dirname(configAbsPath);

// ---- utilities ----
const log = (...m) => console.log("[imgset]", ...m);
const err = (...m) => console.error("[imgset]", ...m);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_CONFIG = {
  inputDir: "./input",
  outputDir: "./output",
  // File extensions we’ll scan for in inputDir
  extensions: ["jpg", "jpeg", "png", "webp", "avif"],
  // Output formats + tuning
  formats: [
    { format: "avif", quality: 32, effort: 4 },
    { format: "webp", quality: 80 },
    { format: "jpeg", quality: 75, progressive: true, mozjpeg: true }
  ],
  // Target widths (px). We never upscale.
  sizes: [320, 640, 960, 1280, 1920, 2560, 3840],
  // Mirror input folder structure under output
  preserveFolders: true,
  // Concurrency (parallel sharp jobs)
  concurrency: Math.max(2, Math.min(os.cpus().length, 8)),
  // HTML output settings
  html: {
    file: "index.html",
    pageTitle: "Resized Images",
    sizesAttribute: "100vw", // e.g. "(max-width: 768px) 100vw, 768px"
    wrapFigure: true,
    altFromFilename: true,
    className: ""
  }
};

// Make sure slashes in HTML paths are forward slashes
const toHtmlPath = (p) => p.split(path.sep).join("/");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  const raw = await fs.readFile(p, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    const m = /position (\d+)/.exec(e.message || "");
    if (m) {
      const idx = Number(m[1]);
      const start = Math.max(0, idx - 60);
      const end = Math.min(raw.length, idx + 60);
      const snippet = raw.slice(start, end);
      err(`JSON parse error in ${p} near position ${idx}:\n---\n${snippet}\n${" ".repeat(idx - start)}^\n---`);
    } else {
      err(`JSON parse error in ${p}: ${e.message}`);
    }
    throw e;
  }
}

async function writeJson(p, data) {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function niceAltFromFilename(filename) {
  const name = filename.replace(/\.[^.]+$/, "");
  const spaced = name.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

async function listFilesRecursive(root, exts) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        const ext = e.name.split(".").pop().toLowerCase();
        if (exts.includes(ext)) {
          out.push(full);
        }
      }
    }
  }
  await walk(root);
  return out;
}

// Simple concurrency limiter
function pLimit(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    active--;
    if (queue.length) queue.shift()();
  };
  return async (fn) => {
    if (active >= max) await new Promise((res) => queue.push(res));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function outputPathsFor(config, inputDir, outputDir, fileAbs, size, fmt /*, meta */) {
  const relFromInput = path.relative(inputDir, fileAbs);   // e.g. "photos/cats/kitty.jpg"
  const dirPart = config.preserveFolders ? path.dirname(relFromInput) : "";
  const base = path.basename(relFromInput, path.extname(relFromInput));
  const outDir = path.join(outputDir, dirPart);
  const outName = `${base}-${size}.${fmt}`;
  const full = path.join(outDir, outName);
  // We'll compute final html-relative paths in cmdHtml (relative to the actual html file dir),
  // so store only absolute file path in manifest here.
  return { full, outDir, outName };
}

async function resizeOne(config, fileAbs, meta, inputDir, outputDir) {
  // { format, width, fileFull, status }
  const created = [];
  const widths = config.sizes
    .filter((w) => Number.isFinite(w) && w > 0)
    .sort((a, b) => a - b)
    .filter((w) => w <= (meta.width || w)); // no upscaling

  // If nothing qualifies (tiny source), at least export the original width once
  const effectiveWidths = widths.length ? widths : [meta.width];

  for (const f of config.formats) {
    const fmt = f.format;
    for (const w of effectiveWidths) {
      const { full, outDir } = outputPathsFor(config, inputDir, outputDir, fileAbs, w, fmt);
      await ensureDir(outDir);

      const relIn = toHtmlPath(path.relative(inputDir, fileAbs));
      const relOut = toHtmlPath(path.relative(outputDir, full));

      // Skip if already exists (idempotent)
      if (await fileExists(full)) {
        created.push({ format: fmt, width: w, fileFull: full, status: "skipped" });
        log(`skip  ${fmt} ${w}w | ${relIn} → ${relOut}`);
        continue;
      }

      const pipeline = sharp(fileAbs, { failOn: "none" }).rotate().resize({
        width: w,
        withoutEnlargement: true,
        fit: "inside"
      });

      // Apply per-format options
      if (fmt === "avif") pipeline.avif({ quality: f.quality ?? 32, effort: f.effort ?? 4 });
      else if (fmt === "webp") pipeline.webp({ quality: f.quality ?? 80 });
      else if (fmt === "jpeg" || fmt === "jpg") pipeline.jpeg({ quality: f.quality ?? 75, progressive: !!f.progressive, mozjpeg: f.mozjpeg !== false });
      else if (fmt === "png") pipeline.png({ compressionLevel: f.compressionLevel ?? 9 });
      else pipeline.toFormat(fmt); // fallback

      await pipeline.toFile(full);
      created.push({ format: fmt, width: w, fileFull: full, status: "written" });
      log(`write ${fmt} ${w}w | ${relIn} → ${relOut}`);
    }
  }
  return created;
}

function buildManifestEntry(originalAbs, inputDir, meta, outputs) {
  const rel = toHtmlPath(path.relative(inputDir, originalAbs));
  const base = path.basename(originalAbs);
  return {
    original: { abs: originalAbs, relFromInput: rel, base, width: meta.width, height: meta.height },
    outputs // array: { format, width, fileFull, status }
  };
}

function groupByFormat(outputs) {
  const map = new Map();
  for (const o of outputs) {
    if (!map.has(o.format)) map.set(o.format, []);
    map.get(o.format).push(o);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.width - b.width);
  return map;
}

function pickFallbackFormat(formats) {
  // Prefer jpeg > webp > avif > first
  const order = ["jpeg", "jpg", "webp", "avif"];
  for (const k of order) if (formats.includes(k)) return k;
  return formats[0];
}

function htmlForImage(config, entry) {
  const { base } = entry.original;
  const groups = groupByFormat(entry.outputs);
  const fmts = [...groups.keys()];
  const fallbackFmt = pickFallbackFormat(fmts);
  const fallbackSet = groups.get(fallbackFmt) || [];
  const fallbackSrc = fallbackSet.length ? fallbackSet[Math.min(1, fallbackSet.length - 1)].htmlRel : ""; // 2nd-smallest as a decent default
  const alt = config.html.altFromFilename ? niceAltFromFilename(base) : path.basename(base, path.extname(base));

  // Guess width/height from largest fallback for aspect-ratio hints
  const largest = fallbackSet[fallbackSet.length - 1];
  const ratioW = largest?.width || entry.original.width || 800;
  const ratioH = entry.original.height && entry.original.width
    ? Math.round(ratioW * (entry.original.height / entry.original.width))
    : Math.round(ratioW * 0.66);

  const classAttr = config.html.className ? ` class="${config.html.className}"` : "";

  const sources = fmts.map((fmt) => {
    const set = groups.get(fmt) || [];
    const srcset = set.map((o) => `${o.htmlRel} ${o.width}w`).join(", ");
    const type = fmt === "jpg" ? "image/jpeg" : `image/${fmt}`;
    return `  <source type="${type}" srcset="${srcset}" sizes="${config.html.sizesAttribute}">`;
  }).join("\n");

  const img = `<img src="${toHtmlPath(fallbackSrc || (fallbackSet[0]?.htmlRel || ""))}" 
       srcset="${fallbackSet.map((o) => `${o.htmlRel} ${o.width}w`).join(", ")}"
       sizes="${config.html.sizesAttribute}"
       alt="${alt}" width="${ratioW}" height="${ratioH}" loading="lazy" decoding="async"${classAttr}>`;

  if (config.html.wrapFigure) {
    return `<figure>
${sources}
  ${img}
</figure>`;
  }
  return `${sources}
${img}`;
}

async function cmdInit() {
  if (await fileExists(configAbsPath)) {
    err(`Config already exists at ${configAbsPath}. Aborting.`);
    process.exitCode = 1;
    return;
  }
  await writeJson(configAbsPath, DEFAULT_CONFIG);
  log(`Wrote default config to ${configAbsPath}`);
  log(`Edit it, put your originals in "${DEFAULT_CONFIG.inputDir}", then run: node index.mjs all -c ${configPath}`);
}

async function cmdBuild(config) {
  const t0 = Date.now();
  const inputDir = path.resolve(configDir, config.inputDir);
  const outputDir = path.resolve(configDir, config.outputDir);

  if (!(await fileExists(inputDir))) {
    err(`Input directory not found:\n  ${inputDir}\n(Check your config: ${configAbsPath})`);
    return { manifest: { items: [] }, stats: { written: 0, skipped: 0, files: 0, timeMs: 0 } };
  }

  await ensureDir(outputDir);

  const files = await listFilesRecursive(inputDir, config.extensions.map((e) => e.toLowerCase()));
  if (!files.length) {
    err(`No input images found in ${inputDir} (extensions: ${config.extensions.join(", ")})`);
    return { manifest: { items: [] }, stats: { written: 0, skipped: 0, files: 0, timeMs: 0 } };
  }

  log(`Resolved input:  ${inputDir}`);
  log(`Resolved output: ${outputDir}`);
  log(`Found ${files.length} images. Processing with concurrency=${config.concurrency}…`);

  const limit = pLimit(config.concurrency);
  const items = [];
  let writtenCount = 0;
  let skippedCount = 0;

  await Promise.all(
    files.map((abs) =>
      limit(async () => {
        const meta = await sharp(abs).metadata();
        const outs = await resizeOne(config, abs, meta, inputDir, outputDir);
        writtenCount += outs.filter(o => o.status === "written").length;
        skippedCount += outs.filter(o => o.status === "skipped").length;
        items.push(buildManifestEntry(abs, inputDir, meta, outs));
      })
    )
  );

  const manifest = { generatedAt: new Date().toISOString(), config, items };
  const manifestPath = path.join(outputDir, "resized-manifest.json");
  await writeJson(manifestPath, manifest);

  const dt = Date.now() - t0;
  log(`Done. ${writtenCount} written, ${skippedCount} skipped across ${files.length} originals in ${dt}ms.`);
  log(`Manifest: ${manifestPath}`);
  return { manifest, stats: { written: writtenCount, skipped: skippedCount, files: files.length, timeMs: dt } };
}

async function cmdHtml(config, manifestInput = null) {
  const outputDir = path.resolve(configDir, config.outputDir);
  const manifestPath = path.join(outputDir, "resized-manifest.json");
  const manifest = manifestInput || (await readJson(manifestPath));

  // Make image paths relative to the ACTUAL HTML file directory (supports subfolders)
  const htmlAbs = path.resolve(outputDir, config.html.file);
  const htmlDir = path.dirname(htmlAbs);

  const adjustedItems = manifest.items.map((item) => ({
    ...item,
    outputs: item.outputs.map((o) => ({
      ...o,
      htmlRel: toHtmlPath(path.relative(htmlDir, path.resolve(o.fileFull)))
    }))
  }));

  const body = adjustedItems
    .map((item) => htmlForImage(config, item))
    .join("\n\n");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${config.html.pageTitle}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.4; }
    figure { margin: 0 0 2rem 0; }
    img { max-width: 100%; height: auto; display: block; }
  </style>
</head>
<body>
  <h1>${config.html.pageTitle}</h1>

${body}

</body>
</html>`;

  await ensureDir(path.dirname(htmlAbs));
  await fs.writeFile(htmlAbs, html, "utf-8");
  log(`HTML written to ${htmlAbs}`);
}

async function run() {
  if (cmd === "init") {
    await cmdInit();
    return;
  }

  // Load config (or create defaults silently if missing)
  let config = DEFAULT_CONFIG;
  if (await fileExists(configAbsPath)) {
    config = { ...DEFAULT_CONFIG, ...(await readJson(configAbsPath)) };
    // deep-merge html if present
    if (config.html) config.html = { ...DEFAULT_CONFIG.html, ...config.html };
  } else {
    log(`No config at ${configPath}, using defaults. You can run "node index.mjs init -c ${configPath}" to create one.`);
  }

  if (cmd === "build") {
    await cmdBuild(config);
  } else if (cmd === "html") {
    await cmdHtml(config);
  } else if (cmd === "all" || cmd === undefined) {
    const { manifest } = await cmdBuild(config);
    await cmdHtml(config, manifest);
  } else {
    err(`Unknown command: ${cmd}
Usage:
  node index.mjs init -c resizer.config.json
  node index.mjs build -c resizer.config.json
  node index.mjs html  -c resizer.config.json
  node index.mjs all   -c resizer.config.json`);
    process.exitCode = 1;
  }
}

run().catch((e) => {
  err(e?.stack || e?.message || e);
  process.exitCode = 1;
});
