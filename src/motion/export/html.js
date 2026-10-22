/**
 * Standalone HTML player export.
 *
 * The SVG file handles playback on its own, but a bare `.svg` cannot be
 * scrubbed: browsers only expose the timeline through `setCurrentTime` on an
 * inline SVG. This export inlines the SVG and adds nothing but a time slider,
 * using the SMIL clock as the source of truth so the two stay in sync.
 *
 * The result is one file, no external requests, works from `file://`.
 */

/**
 * @param {{svg: string, title?: string, duration: number, fps?: number}} opts
 * @returns {string}
 */
export function exportHtml(opts) {
  const title = escapeHtml(opts.title || 'SVG Motion');
  const duration = opts.duration;
  const svg = opts.svg.replace(/^<\?xml[^>]*\?>\s*/, '');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 20px; padding: 32px;
    background: #17110d;
    background-image: radial-gradient(circle at 50% 0%, #2a1d14 0%, #17110d 70%);
    color: #f2e6d8;
    font: 14px/1.5 "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  .stage {
    width: min(78vmin, 560px); aspect-ratio: 1; display: grid; place-items: center;
    background: #1f1712;
    background-image:
      linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px);
    background-size: 24px 24px;
    border: 1px solid #3a2a1e; border-radius: 18px;
    box-shadow: 0 30px 60px -30px #000;
  }
  .stage svg { width: 68%; height: 68%; overflow: visible; }
  .bar { display: flex; align-items: center; gap: 12px; width: min(78vmin, 560px); }
  button {
    width: 40px; height: 40px; border-radius: 12px; cursor: pointer;
    border: 1px solid #4a3524; background: #2a1d14; color: #f6b26b;
    font-size: 15px; display: grid; place-items: center;
  }
  button:hover { background: #35251a; }
  input[type="range"] { flex: 1; accent-color: #f6b26b; }
  .time { font-variant-numeric: tabular-nums; color: #b9a08a; min-width: 92px; text-align: right; }
  h1 { font-size: 15px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #b9a08a; margin: 0; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="stage" id="stage">${svg}</div>
<div class="bar">
  <button id="play" aria-label="播放/暂停">❚❚</button>
  <input id="scrub" type="range" min="0" max="${duration}" value="0" step="1" aria-label="时间轴">
  <span class="time" id="time">0.00 / ${(duration / 1000).toFixed(2)}s</span>
</div>
<script>
(function () {
  var svg = document.querySelector('#stage svg');
  var playBtn = document.getElementById('play');
  var scrub = document.getElementById('scrub');
  var timeLabel = document.getElementById('time');
  var duration = ${duration};
  var playing = true;
  var dragging = false;

  function currentTime() {
    try { return svg.getCurrentTime() * 1000; } catch (e) { return 0; }
  }
  function setTime(ms) {
    var s = Math.max(0, Math.min(duration, ms)) / 1000;
    try { svg.setCurrentTime(s); } catch (e) {}
    scrub.value = String(Math.round(s * 1000));
    timeLabel.textContent = s.toFixed(2) + ' / ' + (duration / 1000).toFixed(2) + 's';
  }
  function pause() { playing = false; playBtn.textContent = '▶'; try { svg.pauseAnimations(); } catch (e) {} }
  function resume() { playing = true; playBtn.textContent = '❚❚'; try { svg.unpauseAnimations(); } catch (e) {} }

  playBtn.addEventListener('click', function () { playing ? pause() : resume(); });
  scrub.addEventListener('pointerdown', function () { dragging = true; pause(); });
  scrub.addEventListener('pointerup', function () { dragging = false; });
  scrub.addEventListener('input', function () { setTime(Number(scrub.value)); });

  setInterval(function () {
    if (dragging || !playing) return;
    var t = currentTime();
    scrub.value = String(Math.round(t));
    timeLabel.textContent = (t / 1000).toFixed(2) + ' / ' + (duration / 1000).toFixed(2) + 's';
  }, 60);

  setTime(0);
  resume();
})();
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
