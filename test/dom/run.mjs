/**
 * Browser regression suite.
 *
 * Everything asserted here needs a real renderer: SMIL clocks, path length
 * measurement under transforms, dash coverage after scaling. The suite drives
 * headless Chrome over CDP (no Playwright), captures PNGs, and analyses pixels
 * rather than trusting DOM attributes alone.
 *
 * Run: node test/dom/run.mjs [--verbose]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../tools/serve.mjs';
import { launchChrome } from './cdp.mjs';
import { decodePng, inkStats, pixelHash, inkMask, maskIoU } from '../../tools/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACTS = path.join(ROOT, 'test', '.artifacts');
const SHOTS = path.join(ROOT, 'shots', 'verify');
const verbose = process.argv.includes('--verbose');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  if (verbose || !condition) {
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function shotStats(buffer, background) {
  const png = decodePng(buffer);
  return { ...inkStats(png, { background }), hash: pixelHash(png), png };
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const server = await startServer(ROOT, 0).catch(async () => startServer(ROOT, 4173));
  const chrome = await launchChrome();
  const client = chrome.client;

  try {
    /* ---------------- studio boot ---------------- */
    const studio = await client.openPage(`${server.url}/studio/index.html`, { width: 1440, height: 900 });
    await waitFor(studio, 'typeof window.__studio === "object" && !!window.__studio.state.scene');
    await sleep(320);

    const boot = await studio.evaluate(`(() => {
      const s = window.__studio.state;
      return {
        caseId: s.caseId,
        tracks: s.timeline.tracks.length,
        duration: s.timeline.duration,
        keyframes: s.timeline.tracks.reduce((n, t) => n + t.keyframes.length, 0),
        rows: document.querySelectorAll('.tl-row').length,
        cases: document.querySelectorAll('#cases button').length,
        targetCount: document.querySelectorAll('[data-motion]').length,
        hasSvg: !!document.querySelector('#stage-svg path')
      };
    })()`);

    check('编辑器启动无异常', studio.logs.length === 0, studio.logs.slice(0, 3).join(' | '));
    check('默认案例已装载', boot.hasSvg && boot.tracks >= 6, `${boot.tracks} 条轨道 / ${boot.keyframes} 个关键帧`);
    check('时间轴行数与轨道一致', boot.rows === boot.tracks, `${boot.rows} 行`);
    check('案例切换器有三个案例', boot.cases === 3, String(boot.cases));

    const studioShot = await studio.screenshot();
    const studioStats = shotStats(studioShot, [20, 16, 12]);
    fs.writeFileSync(path.join(SHOTS, 'studio-draw.png'), studioShot);
    check('舞台有可见描边内容', studioStats.coverage > 0.004, `覆盖率 ${(studioStats.coverage * 100).toFixed(2)}%`);
    check('编辑器无横向溢出', await noOverflow(studio), '1440px');

    /* ---------------- interruption semantics ---------------- */
    const seam = await studio.evaluate(`(() => {
      window.__studio.loadCase('draw');
      const s = window.__studio.state;
      const track = s.timeline.tracks.find(t => t.kind === 'number');
      const at = 420;
      const r = window.__studio.interrupt(track.id, { at, value: 0, duration: 320, preserveVelocity: true });
      const numeric = Math.abs(Number(r.before) - Number(r.after));
      return { trackId: track.id, delta: numeric, keys: r.keys };
    })()`);
    check('描边轨道中断接缝为 0', seam.delta < 1e-9, `Δ=${seam.delta}`);

    const morphSeam = await studio.evaluate(`(() => {
      window.__studio.loadCase('morph');
      const s = window.__studio.state;
      const track = s.timeline.tracks.find(t => t.kind === 'morph');
      const at = 500;
      const r = window.__studio.interrupt(track.id, { at, value: { d: 'M4 4 L28 4 L28 28 L4 28 Z' }, duration: 300 });
      const nums = (str) => (str.match(/-?\\d*\\.?\\d+/g) || []).map(Number);
      const a = nums(r.before), b = nums(r.after);
      let worst = 0;
      if (a.length === b.length) for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      else worst = 999;
      return { delta: worst, keys: r.keys, sameLength: a.length === b.length };
    })()`);
    check('变形轨道中断无跳变', morphSeam.sameLength && morphSeam.delta < 1e-3, `Δ=${morphSeam.delta}`);

    const stress = await studio.evaluate(`(() => {
      window.__studio.loadCase('draw');
      const s = window.__studio.state;
      const track = s.timeline.tracks.find(t => t.kind === 'number');
      const base = track.keyframes.length;
      let worst = 0;
      for (let i = 0; i < 5; i++) {
        const at = 260 + i * 80;
        const before = s.timeline.sampleTrack(track, at);
        window.__studio.interrupt(track.id, { at, value: i % 2 ? 1 : 0, duration: 220 });
        const after = s.timeline.sampleTrack(track, at);
        worst = Math.max(worst, Math.abs(Number(before) - Number(after)));
      }
      return { worst, base, after: track.keyframes.length };
    })()`);
    check('连续 5 次中断保持连续', stress.worst < 1e-9, `最大 Δ=${stress.worst}`);
    check('中断不导致关键帧爆炸', stress.after <= stress.base + 12, `${stress.base} → ${stress.after}`);

    /* ---------------- exports ---------------- */
    const exports = await studio.evaluate(`(() => {
      const out = {};
      for (const id of ['draw', 'morph', 'icon']) {
        window.__studio.loadCase(id);
        const svg = window.__studio.buildSvgExport();
        const html = window.__studio.buildHtmlExport();
        out[id] = { svg: svg.svg, report: svg.report, html: html.html };
      }
      return out;
    })()`);

    for (const [id, payload] of Object.entries(exports)) {
      check(`[${id}] 导出 SVG 含 SMIL 动画`, /<animate(Transform)?\s/.test(payload.svg), `${payload.report.tracks.length} 条轨道`);
      check(`[${id}] 导出内无外部依赖`, !/(<script|@import|href="https?:|url\(https?:)/i.test(payload.svg));
      check(`[${id}] 导出帧数合理`, payload.report.frameCount > 10, `${payload.report.frameCount} 帧`);

      const svgFile = path.join(ARTIFACTS, `${id}.svg`);
      const htmlFile = path.join(ARTIFACTS, `${id}.html`);
      fs.writeFileSync(svgFile, payload.svg);
      fs.writeFileSync(htmlFile, payload.html);
      fs.copyFileSync(svgFile, path.join(SHOTS, `export-${id}.svg`));
    }

    /* ---------------- exported SVG actually animates ---------------- */
    for (const id of ['draw', 'morph', 'icon']) {
      const page = await client.openPage(`${server.url}/test/.artifacts/${id}.svg`, { width: 900, height: 900 });
      await sleep(200);

      const meta = await page.evaluate(`(() => {
        const svg = document.documentElement;
        const anims = [...svg.querySelectorAll('animate, animateTransform')];
        return {
          tag: svg.tagName.toLowerCase(),
          anims: anims.length,
          values: anims.filter(a => a.getAttribute('values')).length,
          keyTimes: anims.every(a => !a.getAttribute('keyTimes') || a.getAttribute('keyTimes').split(';').length === a.getAttribute('values').split(';').length),
          parseErrors: document.querySelectorAll('parsererror').length,
          smil: typeof svg.setCurrentTime === 'function'
        };
      })()`);
      check(`[${id}] 导出文件是合法 SVG`, meta.tag === 'svg' && meta.parseErrors === 0);
      check(`[${id}] SMIL 时钟可用`, meta.smil && meta.anims > 0, `${meta.anims} 个动画元素`);
      check(`[${id}] values 与 keyTimes 数量一致`, meta.keyTimes);

      const frames = [];
      const durSec = (await durationOf(exports, id)) / 1000;
      for (const t of [0, 0.35, 0.7, 0.98]) {
        await page.evaluate(`(async () => {
          const svg = document.documentElement;
          svg.pauseAnimations();
          svg.setCurrentTime(${(t * durSec).toFixed(3)});
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          return true;
        })()`);
        await sleep(90);
        const shot = await page.screenshot();
        const stats = shotStats(shot, [255, 255, 255]);
        frames.push({ t, ...stats });
        fs.writeFileSync(path.join(SHOTS, `export-${id}-t${String(t).replace('.', '')}.png`), shot);
      }

      const hashes = frames.map((f) => f.hash);
      check(`[${id}] 导出文件真的在动`, new Set(hashes).size >= 3, `帧哈希 ${hashes.join('/')}`);

      if (id === 'draw') {
        check('[draw] t=0 尚未落墨', frames[0].coverage < 0.004, `覆盖率 ${(frames[0].coverage * 100).toFixed(3)}%`);
        check(
          '[draw] t≈末 已完整落墨',
          frames[3].coverage > frames[0].coverage + 0.01,
          `${(frames[0].coverage * 100).toFixed(2)}% → ${(frames[3].coverage * 100).toFixed(2)}%`
        );
      }
      if (id === 'morph') {
        const boxes = frames.filter((f) => f.bbox).map((f) => f.bbox.width);
        check(
          '[morph] 形态随帧变化',
          new Set(hashes).size === 4 && Math.max(...boxes) - Math.min(...boxes) > 4,
          `宽度 ${boxes.join('/')}`
        );
      }
      await page.close();
    }

    /* ---------------- export fidelity: preview vs exported file ---------------- */
    // Rasterise the editor preview and the exported file at the same instant,
    // downsample both into binary ink masks and compare. This is the check that
    // catches "the export plays, but it does not look like the preview".
    for (const id of ['draw', 'morph', 'icon']) {
      const t = 0.86;

      await studio.evaluate(`(() => {
        window.__studio.loadCase('${id}');
        window.__studio.pause();
        window.__studio.seek(${t} * window.__studio.state.timeline.duration);
        return true;
      })()`);
      await sleep(160);
      const stageRect = await studio.evaluate(`(() => {
        const r = document.querySelector('.stage svg').getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })()`);
      const previewShot = await studio.screenshot({ clip: stageRect });
      fs.writeFileSync(path.join(SHOTS, `preview-${id}.png`), previewShot);

      const page = await client.openPage(`${server.url}/test/.artifacts/${id}.svg`, { width: 720, height: 720 });
      const durSec = (await durationOf(exports, id)) / 1000;
      await page.evaluate(`(async () => {
        const svg = document.documentElement;
        svg.pauseAnimations();
        svg.setCurrentTime(${(t * durSec).toFixed(3)});
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      })()`);
      await sleep(120);
      const exportShot = await page.screenshot({ clip: { x: 0, y: 0, width: 720, height: 720 } });
      fs.writeFileSync(path.join(SHOTS, `verify-export-${id}.png`), exportShot);
      await page.close();

      const previewPng = decodePng(previewShot);
      const exportPng = decodePng(exportShot);
      const bgPreview = { background: [20, 16, 12], threshold: 120 };
      const bgExport = { background: [255, 255, 255], threshold: 60 };
      // Both masks are cropped to their own ink box: size and position are
      // covered by the scaling checks, this one is about the drawing itself.
      const iou = maskIoU(
        inkMask(previewPng, 40, { ...bgPreview, crop: true }),
        inkMask(exportPng, 40, { ...bgExport, crop: true }),
        { tolerance: 1 }
      );
      const boxA = inkStats(previewPng, bgPreview).bbox;
      const boxB = inkStats(exportPng, bgExport).bbox;
      const aspectA = boxA ? boxA.width / boxA.height : 0;
      const aspectB = boxB ? boxB.width / boxB.height : 0;
      check(`[${id}] 导出与预览画面一致`, iou > 0.85, `IoU ${iou.toFixed(3)}`);
      check(
        `[${id}] 导出与预览长宽比一致`,
        Math.abs(aspectA - aspectB) < 0.08,
        `${aspectA.toFixed(3)} vs ${aspectB.toFixed(3)}`
      );
    }

    /* ---------------- scaling / vector integrity ---------------- */
    for (const size of [160, 640]) {
      const wrapper = path.join(ARTIFACTS, `scale-${size}.html`);
      fs.writeFileSync(
        wrapper,
        `<!doctype html><meta charset="utf-8">
         <style>html,body{margin:0;background:#fff;height:100%;display:grid;place-items:center}
         svg{width:${size}px;height:${size}px;display:block}</style>
         ${exports.draw.svg}`
      );
      const page = await client.openPage(`${server.url}/test/.artifacts/scale-${size}.html`, { width: 760, height: 760 });
      await sleep(240);
      await page.evaluate(`(async () => {
        const svg = document.querySelector('svg');
        svg.pauseAnimations();
        svg.setCurrentTime(${(2000 * 0.85) / 1000});
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      })()`);
      await sleep(120);
      const rect = await page.evaluate(`(() => {
        const r = document.querySelector('svg').getBoundingClientRect();
        return { x: Math.round(r.x) - 2, y: Math.round(r.y) - 2, width: Math.round(r.width) + 4, height: Math.round(r.height) + 4 };
      })()`);
      const shot = await page.screenshot({ clip: rect });
      const stats = shotStats(shot, [255, 255, 255]);
      fs.writeFileSync(path.join(SHOTS, `scale-${size}.png`), shot);
      check(`[scale] ${size}px 渲染有内容`, stats.coverage > 0.02, `覆盖率 ${(stats.coverage * 100).toFixed(2)}%`);
      if (size === 160) global.__smallBbox = stats.bbox;
      else {
        const ratio = stats.bbox && global.__smallBbox ? stats.bbox.width / global.__smallBbox.width : 0;
        check('[scale] 4× 尺寸下图形按比例放大', ratio > 3.4 && ratio < 4.6, `实测 ${ratio.toFixed(2)}×`);
      }
      await page.close();
    }

    /* ---------------- responsive ---------------- */
    for (const [w, h] of [[1024, 820], [768, 900], [390, 844]]) {
      await studio.resize(w, h);
      await sleep(220);
      const overflow = await studio.evaluate(
        `({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })`
      );
      check(`响应式 ${w}px 无横向溢出`, overflow.sw <= overflow.iw + 1, `${overflow.sw} / ${overflow.iw}`);
      const shot = await studio.screenshot();
      fs.writeFileSync(path.join(SHOTS, `studio-${w}.png`), shot);
    }
    await studio.resize(1440, 900);
    await sleep(200);
    await studio.close();
  } finally {
    await chrome.close();
    await server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(failed.map((f) => ` - ${f.name} ${f.detail}`).join('\n'));
    process.exitCode = 1;
  }
}

async function durationOf(exports, id) {
  const match = exports[id].svg.match(/dur="([\d.]+)s"/);
  return match ? Number(match[1]) * 1000 : 2000;
}

async function noOverflow(page) {
  const v = await page.evaluate(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })`);
  return v.sw <= v.iw + 1;
}

async function waitFor(page, expression, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await page.evaluate(expression)) return true;
    } catch {
      /* page still navigating */
    }
    await sleep(120);
  }
  throw new Error(`timeout waiting for: ${expression}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
