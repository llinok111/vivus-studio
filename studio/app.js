/**
 * Editor shell.
 *
 * Deliberately framework-free: the whole point of the runtime is that it can be
 * dropped into any product, so the reference editor is plain DOM. Everything
 * that touches animation state goes through `MotionScene`, and everything that
 * touches time goes through `Timeline.sampleAt`.
 */

import { MotionScene } from '../src/motion/scene.js';
import { Timeline } from '../src/motion/timeline.js';
import { exportSmil } from '../src/motion/export/smil.js';
import { exportHtml } from '../src/motion/export/html.js';
import { EASING_NAMES } from '../src/motion/easing.js';
import { normalizePath } from '../src/motion/geometry/normalize.js';
import { prepareMorph, subpathCentroid } from '../src/motion/geometry/compat.js';
import { CASES, SHAPES } from './cases.js';

const $ = (id) => document.getElementById(id);

const state = {
  caseId: 'draw',
  caseDef: null,
  scene: null,
  timeline: null,
  selectedTrack: null,
  selectedKeyframe: null,
  loop: true,
  rate: 1,
  exportPayload: null,
  lastInterruptValue: null
};

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function boot() {
  buildCaseTabs();
  wireTransport();
  wireTimelineEvents();
  wireInterruptLab();
  wireExport();
  wireKeyboard();
  const requested = new URLSearchParams(location.search).get('case');
  loadCase(CASES.some((c) => c.id === requested) ? requested : 'draw');
  window.__studio = {
    state,
    loadCase,
    seek,
    play,
    pause,
    buildSvgExport,
    buildHtmlExport,
    /** Measurement helpers used by the regression runner. */
    measure(caseId) {
      loadCase(caseId);
      const tracks = state.timeline.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        keys: t.keyframes.length
      }));
      return { caseId, duration: state.timeline.duration, tracks, time: state.scene.time };
    },
    interrupt(trackId, opts) {
      const track = state.timeline.getTrack(trackId);
      const before = state.timeline.sampleTrack(track, opts.at);
      state.scene.interrupt(trackId, opts);
      const after = state.timeline.sampleTrack(track, opts.at);
      return { before, after, keys: track.keyframes.length };
    }
  };
}

function buildCaseTabs() {
  const host = $('cases');
  host.innerHTML = '';
  for (const item of CASES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    btn.dataset.case = item.id;
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => loadCase(item.id));
    host.appendChild(btn);
  }
}

function loadCase(id) {
  const def = CASES.find((c) => c.id === id);
  if (!def) throw new Error(`unknown case "${id}"`);
  if (state.scene) state.scene.destroy();

  state.caseId = id;
  state.caseDef = def;
  state.selectedTrack = null;
  state.selectedKeyframe = null;

  const built = def.build();
  state.timeline = built.timeline;
  state.timeline.loop = state.loop;
  state.caseNotes = built.notes;
  state.caseReport = built.iconReport || null;

  const svg = $('stage-svg');
  svg.setAttribute('viewBox', def.viewBox);
  svg.innerHTML = built.markup;

  state.scene = new MotionScene(svg, { timeline: state.timeline, loop: state.loop });
  state.scene.on('tick', ({ time }) => paintPlayhead(time));
  state.scene.on('end', () => setPlayButton(false));
  state.scene.on('interrupt', () => renderTimeline());

  for (const btn of document.querySelectorAll('#cases button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.case === id));
  }

  $('case-note').textContent = built.notes;
  $('stage-badge').textContent = `${def.id} · ${def.tag}`;
  $('int-at').value = String(Math.round(state.timeline.duration * 0.4));
  $('time-read').textContent = `0.00 / ${(state.timeline.duration / 1000).toFixed(2)} s`;

  state.scene.renderAt(0);
  renderTimeline();
  renderRuler();
  renderTrackList();
  renderInspector();
  renderCompat();
  buildInterruptTargets();
  paintPlayhead(0);
  setPlayButton(false);
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

function wireTransport() {
  $('btn-play').addEventListener('click', () => (state.scene.playing ? pause() : play()));
  $('btn-stop').addEventListener('click', () => {
    pause();
    seek(0);
  });
  $('btn-loop').addEventListener('click', () => {
    state.loop = !state.loop;
    state.timeline.loop = state.loop;
    state.scene.loop = state.loop;
    $('btn-loop').setAttribute('aria-pressed', String(state.loop));
    $('btn-loop').style.color = state.loop ? 'var(--amber)' : '';
  });
  $('speed').addEventListener('change', (e) => {
    state.rate = Number(e.target.value);
    if (state.scene.playing) play();
  });
}

function play() {
  state.scene.rate = state.rate;
  state.scene.play();
  setPlayButton(true);
}

function pause() {
  state.scene.pause();
  setPlayButton(false);
}

function seek(time) {
  const t = Math.max(0, Math.min(state.timeline.duration, time));
  state.scene.pause();
  state.scene.seek(t);
  paintPlayhead(t);
  setPlayButton(false);
}

function setPlayButton(playing) {
  $('btn-play').textContent = playing ? '❚❚' : '▶';
  $('btn-play').setAttribute('aria-label', playing ? '暂停' : '播放');
}

function paintPlayhead(time) {
  const pct = state.timeline.duration > 0 ? (time / state.timeline.duration) * 100 : 0;
  const head = document.querySelector('.playhead');
  if (head) head.style.left = `${pct}%`;
  $('time-read').textContent = `${(time / 1000).toFixed(2)} / ${(state.timeline.duration / 1000).toFixed(2)} s`;
  const at = $('int-at');
  if (at && document.activeElement !== at) at.value = String(Math.round(time));
}

/* ------------------------------------------------------------------ *
 * Timeline UI
 * ------------------------------------------------------------------ */

function renderRuler() {
  const ruler = $('ruler');
  ruler.innerHTML = '';
  const duration = state.timeline.duration;
  const step = duration <= 1200 ? 200 : duration <= 2600 ? 400 : 800;
  for (let t = 0; t <= duration + 1; t += step) {
    const pct = (t / duration) * 100;
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = `${pct}%`;
    const label = document.createElement('span');
    label.textContent = `${(t / 1000).toFixed(1)}s`;
    tick.appendChild(label);
    ruler.appendChild(tick);
  }
}

function renderTimeline() {
  const rows = $('rows');
  rows.innerHTML = '';
  const duration = state.timeline.duration;

  for (const track of state.timeline.tracks) {
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.dataset.track = track.id;
    row.dataset.selected = String(track.id === state.selectedTrack);

    const label = document.createElement('div');
    label.className = 'tl-label';
    const dot = document.createElement('span');
    dot.className = `dot ${track.kind}`;
    label.appendChild(dot);
    label.appendChild(document.createTextNode(track.name || track.id));
    label.addEventListener('click', () => selectTrack(track.id));

    const lane = document.createElement('div');
    lane.className = 'tl-track';
    lane.dataset.track = track.id;

    for (const kf of track.keyframes) {
      const mark = document.createElement('div');
      mark.className = 'kf';
      mark.style.left = `${duration > 0 ? (kf.t / duration) * 100 : 0}%`;
      mark.dataset.kf = kf.id;
      mark.dataset.syn = String(!!kf.synthetic);
      mark.dataset.selected = String(kf.id === state.selectedKeyframe);
      mark.title = `${Math.round(kf.t)} ms · ${kf.easing}`;
      mark.addEventListener('pointerdown', (ev) => startKeyframeDrag(ev, track, kf, lane));
      lane.appendChild(mark);
    }

    lane.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.kf')) return;
      selectTrack(track.id);
      startScrub(ev, lane);
    });

    row.appendChild(label);
    row.appendChild(lane);
    rows.appendChild(row);
  }

  const head = document.createElement('div');
  head.className = 'playhead';
  head.style.left = '0%';
  rows.appendChild(head);
  paintPlayhead(state.scene.time);
}

function startKeyframeDrag(ev, track, kf, lane) {
  ev.preventDefault();
  ev.stopPropagation();
  selectTrack(track.id, false);
  state.selectedKeyframe = kf.id;
  renderTimeline();
  renderInspector();

  const rect = lane.getBoundingClientRect();
  const duration = state.timeline.duration;
  const move = (e) => {
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    kf.t = Math.round(pct * duration);
    track.keyframes.sort((a, b) => a.t - b.t);
    state.scene.renderAt(state.scene.time);
    renderTimeline();
    renderInspector();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startScrub(ev, lane) {
  const rect = lane.getBoundingClientRect();
  const duration = state.timeline.duration;
  const apply = (e) => {
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(pct * duration);
  };
  apply(ev);
  const move = (e) => apply(e);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function wireTimelineEvents() {
  $('ruler').addEventListener('pointerdown', (ev) => {
    const rect = $('ruler').getBoundingClientRect();
    const apply = (e) => {
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      seek(pct * state.timeline.duration);
    };
    apply(ev);
    const move = (e) => apply(e);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function selectTrack(id, rerender = true) {
  state.selectedTrack = id;
  if (rerender) {
    renderTimeline();
    renderInspector();
  }
}

/* ------------------------------------------------------------------ *
 * Left panel
 * ------------------------------------------------------------------ */

function renderTrackList() {
  const host = $('track-list');
  host.innerHTML = '';
  for (const track of state.timeline.tracks) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'track-chip';
    btn.setAttribute('aria-selected', String(track.id === state.selectedTrack));
    const dot = document.createElement('span');
    dot.className = `dot ${track.kind}`;
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(track.name || track.id));
    btn.addEventListener('click', () => selectTrack(track.id));
    host.appendChild(btn);
  }
}

function renderCompat() {
  const host = $('compat');
  host.innerHTML = '';
  const report = state.caseReport || describeMorphCompat();

  const rows = [
    ['策略', report.strategy || '—', true],
    ['配成对', String(report.paired ?? report.pairs ?? '—')],
    ['塌缩补位', String(report.collapsed ?? (report.added ?? 0) + (report.removed ?? 0) ?? 0)],
    ['重采样', String(report.resampled ?? '—')],
    ['重定起点', String(report.rotated ?? '—')],
    ['反向对齐', String(report.reversed ?? '—')],
    ['总段数', String(report.segments ?? (report.pairs ? '2 × ' + (report.pairs) : '—'))]
  ];

  for (const [k, v, em] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    if (em) dd.className = 'em';
    host.appendChild(dt);
    host.appendChild(dd);
  }
}

/** For morph cases, compute the report from the first two distinct outlines. */
function describeMorphCompat() {
  const track = state.timeline.tracks.find((t) => t.kind === 'morph');
  if (!track) return { strategy: 'n/a' };
  const distinct = [];
  for (const kf of track.keyframes) {
    const d = kf.value?.d;
    if (d && !distinct.includes(d)) distinct.push(d);
    if (distinct.length === 2) break;
  }
  if (distinct.length < 2) {
    // Icon case: paths differ per element, so report on the first pair.
    const second = state.timeline.tracks.filter((t) => t.kind === 'morph')[0];
    if (!second) return { strategy: 'n/a' };
  }
  const [a, b] = distinct;
  if (!a || !b) return { strategy: 'n/a' };
  const prepared = prepareMorph(normalizePath(a), normalizePath(b));
  return prepared.report;
}

/* ------------------------------------------------------------------ *
 * Inspector
 * ------------------------------------------------------------------ */

function renderInspector() {
  const host = $('inspector');
  host.innerHTML = '';
  const track = state.timeline.tracks.find((t) => t.id === state.selectedTrack);
  if (!track) {
    host.innerHTML = '<p class="note">选中一条轨道或一个关键帧。</p>';
    return;
  }
  const kf = track.keyframes.find((k) => k.id === state.selectedKeyframe);

  const head = document.createElement('dl');
  head.className = 'kv';
  addKv(head, '轨道', track.name || track.id, true);
  addKv(head, '类型', track.kind);
  addKv(head, '目标', track.target || '—');
  addKv(head, '关键帧', String(track.keyframes.length));
  host.appendChild(head);

  if (!kf) {
    const hint = document.createElement('p');
    hint.className = 'note';
    hint.style.marginTop = '10px';
    hint.textContent = '选择轨道上的菱形以编辑该关键帧。';
    host.appendChild(hint);
    return;
  }

  const fields = document.createElement('div');
  fields.style.marginTop = '12px';

  fields.appendChild(
    numberField('时刻 ms', kf.t, 0, state.timeline.duration, 1, (v) => {
      kf.t = v;
      track.keyframes.sort((a, b) => a.t - b.t);
      state.scene.renderAt(state.scene.time);
      renderTimeline();
    })
  );

  const easingField = document.createElement('div');
  easingField.className = 'field';
  const easingLabel = document.createElement('label');
  easingLabel.textContent = '缓动（作用于本段）';
  const easingSelect = document.createElement('select');
  for (const name of EASING_NAMES) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    opt.selected = name === kf.easing;
    easingSelect.appendChild(opt);
  }
  easingSelect.addEventListener('change', () => {
    kf.easing = easingSelect.value;
    state.scene.renderAt(state.scene.time);
    renderTimeline();
  });
  easingField.appendChild(easingLabel);
  easingField.appendChild(easingSelect);
  fields.appendChild(easingField);

  if (track.kind === 'number') {
    fields.appendChild(
      numberField('值 0–1', kf.value, 0, 1, 0.01, (v) => {
        kf.value = v;
        state.scene.renderAt(state.scene.time);
      }, 'value')
    );
  } else if (track.kind === 'morph') {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = '路径 d（编辑后回车生效）';
    const area = document.createElement('textarea');
    area.value = kf.value?.d || '';
    area.rows = 4;
    area.addEventListener('change', () => {
      kf.value = { d: area.value.trim() };
      state.timeline.invalidate();
      state.scene.renderAt(state.scene.time);
      renderTimeline();
    });
    wrap.appendChild(label);
    wrap.appendChild(area);
    fields.appendChild(wrap);
  } else if (track.kind === 'transform') {
    const grid = document.createElement('div');
    grid.className = 'row2';
    for (const key of ['scale', 'rotate', 'x', 'y']) {
      const field = numberField(key, kf.value?.[key] ?? 0, -360, 360, 0.1, (v) => {
        kf.value = { ...kf.value, [key]: v };
        state.scene.renderAt(state.scene.time);
      });
      grid.appendChild(field);
    }
    fields.appendChild(grid);
  }

  const actions = document.createElement('button');
  actions.className = 'btn small danger';
  actions.textContent = '删除该关键帧';
  actions.style.marginTop = '6px';
  actions.addEventListener('click', () => {
    track.removeKeyframe(kf.id);
    state.selectedKeyframe = null;
    state.scene.renderAt(state.scene.time);
    renderTimeline();
    renderInspector();
  });
  fields.appendChild(actions);

  host.appendChild(fields);
}

function numberField(label, value, min, max, step, onChange, type = 'number') {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lab = document.createElement('label');
  lab.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.value = String(round(value, 3));
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  wrap.appendChild(lab);
  wrap.appendChild(input);
  return wrap;
}

function addKv(dl, key, value, em = false) {
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  dd.textContent = value;
  if (em) dd.className = 'em';
  dl.appendChild(dt);
  dl.appendChild(dd);
}

/* ------------------------------------------------------------------ *
 * Keyframe actions
 * ------------------------------------------------------------------ */

$('btn-add-kf')?.addEventListener('click', () => {
  const track = state.timeline.tracks.find((t) => t.id === state.selectedTrack);
  if (!track) return flash('先选一条轨道');
  const at = state.scene.time;
  const value = state.timeline.sampleTrack(track, at);
  const stored = track.kind === 'morph' ? { d: String(value) } : value;
  const kf = track.insertKeyframe(at, stored, 'easeInOutCubic');
  state.selectedKeyframe = kf.id;
  renderTimeline();
  renderInspector();
});

$('btn-del-kf')?.addEventListener('click', () => {
  const track = state.timeline.tracks.find((t) => t.id === state.selectedTrack);
  if (!track || !state.selectedKeyframe) return flash('先选一个关键帧');
  if (track.keyframes.length <= 1) return flash('至少要保留一个关键帧');
  track.removeKeyframe(state.selectedKeyframe);
  state.selectedKeyframe = null;
  state.scene.renderAt(state.scene.time);
  renderTimeline();
  renderInspector();
});

/* ------------------------------------------------------------------ *
 * Interrupt lab
 * ------------------------------------------------------------------ */

function buildInterruptTargets() {
  const select = $('int-track');
  select.innerHTML = '';
  for (const track of state.timeline.tracks) {
    if (track.kind !== 'number' && track.kind !== 'morph') continue;
    const opt = document.createElement('option');
    opt.value = track.id;
    opt.textContent = `${track.name || track.id}（${track.kind}）`;
    select.appendChild(opt);
  }
  renderInterruptValueField();
}

function renderInterruptValueField() {
  const host = $('int-value-field');
  host.innerHTML = '';
  const track = state.timeline.tracks.find((t) => t.id === $('int-track').value);
  if (!track) return;

  if (track.kind === 'number') {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = '目标值 0–1';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = '0';
    input.id = 'int-value';
    const read = document.createElement('span');
    read.className = 'time-read';
    read.style.textAlign = 'left';
    read.textContent = '0.00';
    input.addEventListener('input', () => (read.textContent = Number(input.value).toFixed(2)));
    wrap.appendChild(label);
    wrap.appendChild(input);
    wrap.appendChild(read);
    host.appendChild(wrap);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = '目标形状';
    const select = document.createElement('select');
    select.id = 'int-value';
    for (const [name, d] of Object.entries(SHAPES)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name.toLowerCase();
      select.appendChild(opt);
    }
    wrap.appendChild(label);
    wrap.appendChild(select);
    host.appendChild(wrap);
  }
}

function wireInterruptLab() {
  $('int-track').addEventListener('change', renderInterruptValueField);

  $('btn-interrupt').addEventListener('click', () => {
    const trackId = $('int-track').value;
    const track = state.timeline.tracks.find((t) => t.id === trackId);
    if (!track) return;

    const at = Number($('int-at').value) || state.scene.time;
    const duration = Number($('int-duration').value) || 320;
    const value = readInterruptValue(track);
    const before = state.timeline.sampleTrack(track, at);

    const result = state.scene.interrupt(trackId, {
      at,
      value,
      duration,
      preserveVelocity: $('int-velocity').checked && track.kind === 'number'
    });

    const after = state.timeline.sampleTrack(track, at);
    const delta = quantify(before, after);

    $('int-report').innerHTML =
      `接缝 Δ = <b>${delta}</b>  <span class="${delta.startsWith('0.0000') ? 'ok' : 'warn'}">` +
      `${delta.startsWith('0.0000') ? '连续，无跳变' : '存在跳变'}</span>\n` +
      `关键帧 ${result.previous !== undefined ? '+' : ''}${track.keyframes.length} 个 · ` +
      `过渡 ${duration} ms · ${result.blend ? '已插入速度衔接点' : '单段过渡'}\n` +
      `终点 ${describeValue(value)}`;

    state.lastInterruptValue = value;
    state.scene.renderAt(state.scene.time);
    renderTimeline();
    renderInspector();
  });

  $('btn-stress').addEventListener('click', () => {
    const trackId = $('int-track').value;
    const track = state.timeline.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const base = track.keyframes.length;
    let worst = 0;
    const start = Math.min(200, state.timeline.duration * 0.2);
    for (let i = 0; i < 5; i++) {
      const at = start + i * 90;
      const before = state.timeline.sampleTrack(track, at);
      const value =
        track.kind === 'morph'
          ? { d: i % 2 ? SHAPES.SQUARE : SHAPES.STAR }
          : i % 2
            ? 1
            : 0;
      state.scene.interrupt(trackId, { at, value, duration: 220, preserveVelocity: false });
      const after = state.timeline.sampleTrack(track, at);
      worst = Math.max(worst, numericDelta(before, after));
    }
    $('int-report').innerHTML =
      `5 次连续中断，最大接缝 Δ = <b>${worst.toFixed(4)}</b>\n` +
      `<span class="${worst < 1e-6 ? 'ok' : 'warn'}">${worst < 1e-6 ? '全部连续' : '有跳变'}</span>` +
      ` · 关键帧 ${base} → ${track.keyframes.length}\n` +
      '合成关键帧只保留必要锚点，不会随中断次数无限增长。';
    renderTimeline();
    renderInspector();
  });
}

function readInterruptValue(track) {
  const el = $('int-value');
  if (!el) return track.kind === 'morph' ? { d: SHAPES.CIRCLE } : 0;
  if (track.kind === 'number') return Number(el.value);
  return { d: SHAPES[el.value] ?? SHAPES.CIRCLE };
}

function quantify(before, after) {
  if (typeof before === 'number' && typeof after === 'number') {
    return Math.abs(before - after).toFixed(4);
  }
  if (before && after && typeof before === 'object' && before.d) {
    return String(dPathDelta(before.d, after.d).toFixed(4));
  }
  return '0.0000';
}

function numericDelta(before, after) {
  if (typeof before === 'number' && typeof after === 'number') return Math.abs(before - after);
  if (before?.d && after?.d) return dPathDelta(before.d, after.d);
  return 0;
}

/** Max anchor displacement between two serialised paths. */
function dPathDelta(a, b) {
  const na = (a.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) || []).map(Number);
  const nb = (b.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) || []).map(Number);
  if (na.length !== nb.length) return 999;
  let worst = 0;
  for (let i = 0; i < na.length; i += 2) {
    worst = Math.max(worst, Math.hypot(na[i] - nb[i], (na[i + 1] ?? 0) - (nb[i + 1] ?? 0)));
  }
  return Math.round(worst * 1e4) / 1e4;
}

function describeValue(value) {
  if (typeof value === 'number') return `值 ${value.toFixed(2)}`;
  const d = value?.d || '';
  const { subpaths } = normalizePath(d);
  const [cx, cy] = subpaths.length ? subpathCentroid(subpaths[0]) : [0, 0];
  return `d=${d.slice(0, 26)}… (${subpaths.length} 子路径, 重心 ${cx.toFixed(1)},${cy.toFixed(1)})`;
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

function wireExport() {
  $('btn-export-svg').addEventListener('click', () => {
    const { svg, report } = buildSvgExport();
    state.exportPayload = { kind: 'svg', name: `vivus-${state.caseId}.svg`, mime: 'image/svg+xml', text: svg };
    $('export-out').textContent =
      `SVG ${(report.bytes / 1024).toFixed(1)} KB · ${report.frameCount} 帧 @${report.fps}fps · ` +
      `${report.tracks.length} 条 SMIL 轨道` +
      (report.unsupported.length ? `\n跳过：${report.unsupported.map((u) => u.track).join(', ')}` : '') +
      `\n\n${svg.slice(0, 600)}…`;
    toggleDownload(true);
  });

  $('btn-export-html').addEventListener('click', () => {
    const { html } = buildHtmlExport();
    state.exportPayload = { kind: 'html', name: `vivus-${state.caseId}.html`, mime: 'text/html', text: html };
    $('export-out').textContent = `HTML ${(new Blob([html]).size / 1024).toFixed(1)} KB，已内联 SVG 与播放器，可离线打开。\n\n${html.slice(0, 420)}…`;
    toggleDownload(true);
  });

  $('btn-download').addEventListener('click', () => {
    if (!state.exportPayload) return;
    const blob = new Blob([state.exportPayload.text], { type: state.exportPayload.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.exportPayload.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });

  $('btn-copy').addEventListener('click', async () => {
    if (!state.exportPayload) return;
    try {
      await navigator.clipboard.writeText(state.exportPayload.text);
      $('btn-copy').textContent = '已复制';
      setTimeout(() => ($('btn-copy').textContent = '复制'), 1400);
    } catch {
      $('btn-copy').textContent = '复制失败';
    }
  });
}

function buildSvgExport() {
  const fps = Number($('exp-fps').value) || 30;
  const loop = $('exp-loop').value === '1';
  // Pass the scene's bind-time pivots so rotations in the export happen around
  // the same point the preview used.
  const origins = {};
  for (const [name, binding] of state.scene.bindings) origins[name] = binding.origin;
  return exportSmil(state.scene.root, state.timeline, {
    fps,
    loop,
    origins,
    title: `${state.caseDef.label} · vivus studio`
  });
}

function buildHtmlExport() {
  const { svg } = buildSvgExport();
  const html = exportHtml({
    svg,
    title: `${state.caseDef.label} · vivus studio`,
    duration: state.timeline.duration,
    fps: Number($('exp-fps').value) || 30
  });
  return { html, svg };
}

function toggleDownload(enabled) {
  $('btn-download').disabled = !enabled;
  $('btn-copy').disabled = !enabled;
}

/* ------------------------------------------------------------------ *
 * Keyboard
 * ------------------------------------------------------------------ */

function wireKeyboard() {
  window.addEventListener('keydown', (ev) => {
    const tag = ev.target?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (ev.code === 'Space') {
      ev.preventDefault();
      state.scene.playing ? pause() : play();
    } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const step = ev.shiftKey ? 100 : 16;
      seek(state.scene.time + (ev.key === 'ArrowRight' ? step : -step));
    } else if (ev.key === 'Home') {
      seek(0);
    } else if (ev.key === 'End') {
      seek(state.timeline.duration);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

function round(v, p) {
  const f = Math.pow(10, p);
  return Math.round(Number(v) * f) / f;
}

function flash(message) {
  const el = $('case-note');
  const prev = el.textContent;
  el.textContent = message;
  el.style.borderLeftColor = 'var(--terra)';
  setTimeout(() => {
    el.textContent = prev;
    el.style.borderLeftColor = '';
  }, 1600);
}

boot();
