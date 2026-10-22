/**
 * Regenerate the files in `demo/` from the running editor.
 *
 * The gallery must show real exporter output, not hand-written SVG that drifts
 * from the code. This drives the studio in headless Chrome, calls the same
 * `buildSvgExport()` the export button calls, and writes the result.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launchChrome } from '../test/dom/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'demo');

const server = await startServer(ROOT, 0);
const chrome = await launchChrome();

try {
  const page = await chrome.client.openPage(`${server.url}/studio/index.html`, { width: 1280, height: 860 });
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (await page.evaluate('!!(window.__studio && window.__studio.state.scene)')) break;
    await new Promise((r) => setTimeout(r, 120));
  }

  fs.mkdirSync(OUT, { recursive: true });

  for (const id of ['draw', 'morph', 'icon']) {
    const payload = await page.evaluate(`(() => {
      window.__studio.loadCase('${id}');
      const svg = window.__studio.buildSvgExport();
      const html = window.__studio.buildHtmlExport();
      return { svg: svg.svg, report: svg.report, html: html.html };
    })()`);

    fs.writeFileSync(path.join(OUT, `case-${id}.svg`), payload.svg);
    fs.writeFileSync(path.join(OUT, `case-${id}.html`), payload.html);
    console.log(
      `demo/case-${id}.svg  ${(payload.svg.length / 1024).toFixed(1)} KB · ` +
        `${payload.report.frameCount} frames · ${payload.report.tracks.length} tracks`
    );
  }

  await page.close();
} finally {
  await chrome.close();
  await server.close();
}
