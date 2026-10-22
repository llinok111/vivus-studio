/**
 * Built-in demo cases.
 *
 * Each case is a complete, runnable scene: markup plus a timeline. They exist
 * so the editor opens on something real instead of an empty canvas, and so the
 * regression runner has stable fixtures to assert against.
 */

import { Timeline } from '../src/motion/timeline.js';
import { planIconTransition } from '../src/motion/icon.js';
import { staggerSchedule } from '../src/motion/stroke.js';

const HEX = 'M16 3 L27 9.5 L27 22.5 L16 29 L5 22.5 L5 9.5 Z';
const INNER = 'M16 11 A5 5 0 1 1 15.99 11 Z';
const SPOKE_A = 'M16 16 L16 5.5';
const SPOKE_B = 'M16 16 L24.6 20.5';
const SPOKE_C = 'M16 16 L7.4 20.5';

const CIRCLE = 'M16 4 A12 12 0 1 1 15.99 4 Z';
const SQUARE = 'M4 4 L28 4 L28 28 L4 28 Z';
const STAR =
  'M16 3 L19.5 11.6 L28.8 12.3 L21.7 18.3 L23.9 27.4 L16 22.6 L8.1 27.4 L10.3 18.3 L3.2 12.3 L12.5 11.6 Z';
const TRIANGLE = 'M16 3.5 L28.5 27 L3.5 27 Z';

export const SHAPES = { CIRCLE, SQUARE, STAR, TRIANGLE, HEX, INNER };

const DRAW_STROKES = [
  { name: 'hex', d: HEX },
  { name: 'inner', d: INNER },
  { name: 'spoke-a', d: SPOKE_A },
  { name: 'spoke-b', d: SPOKE_B },
  { name: 'spoke-c', d: SPOKE_C }
];

function buildDrawCase() {
  const duration = 2000;
  const schedule = staggerSchedule(DRAW_STROKES.map(() => 1), {
    mode: 'delayed',
    duration: 1500,
    delay: 620
  });

  const tracks = DRAW_STROKES.map((stroke, i) => ({
    id: `draw-${stroke.name}`,
    kind: 'number',
    target: `draw-${stroke.name}`,
    name: stroke.name,
    keyframes: [
      { t: 0, value: 0, easing: 'hold' },
      { t: schedule[i].startAt, value: 0, easing: 'easeOutCubic' },
      { t: schedule[i].startAt + schedule[i].duration, value: 1, easing: 'hold' },
      { t: duration, value: 1, easing: 'hold' }
    ]
  }));

  tracks.push({
    id: 'draw-group',
    kind: 'transform',
    target: 'draw-group',
    name: '整体缩放',
    keyframes: [
      { t: 0, value: { scale: 0.94, x: 0, y: 0, rotate: 0 }, easing: 'easeOutCubic' },
      { t: 700, value: { scale: 1, x: 0, y: 0, rotate: 0 }, easing: 'hold' },
      { t: duration, value: { scale: 1, x: 0, y: 0, rotate: 0 }, easing: 'hold' }
    ]
  });

  return {
    timeline: new Timeline({ duration, loop: true, tracks }),
    markup: `
      <g data-motion="draw-group" fill="none" stroke="currentColor" stroke-width="1.7"
         stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke">
        ${DRAW_STROKES.map((s) => `<path data-motion="draw-${s.name}" d="${s.d}"/>`).join('\n        ')}
      </g>`,
    notes: '五条描边用 delayed 错峰落墨：外框先起笔，辐条随后，最后收在整体 0.94→1 的轻微回弹上。'
  };
}

function buildMorphCase() {
  const duration = 2400;
  return {
    timeline: new Timeline({
      duration,
      loop: true,
      tracks: [
        {
          id: 'morph-shape',
          kind: 'morph',
          target: 'morph-shape',
          name: '轮廓',
          keyframes: [
            { t: 0, value: { d: CIRCLE }, easing: 'easeInOutCubic' },
            { t: 800, value: { d: SQUARE }, easing: 'easeInOutCubic' },
            { t: 1600, value: { d: STAR }, easing: 'easeInOutCubic' },
            { t: duration, value: { d: CIRCLE }, easing: 'hold' }
          ]
        },
        {
          id: 'morph-spin',
          kind: 'transform',
          target: 'morph-shape',
          name: '旋转',
          keyframes: [
            { t: 0, value: { rotate: 0, scale: 1, x: 0, y: 0 }, easing: 'easeInOutCubic' },
            { t: 800, value: { rotate: 45, scale: 1.04, x: 0, y: 0 }, easing: 'easeInOutCubic' },
            { t: 1600, value: { rotate: 90, scale: 1, x: 0, y: 0 }, easing: 'easeInOutCubic' },
            { t: duration, value: { rotate: 180, scale: 1, x: 0, y: 0 }, easing: 'hold' }
          ]
        }
      ]
    }),
    markup: `
      <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
        <path data-motion="morph-shape" d="${CIRCLE}"/>
      </g>`,
    notes: '圆 → 方 → 星 → 圆。圆弧先按 F.6.5 拆成三次贝塞尔，段数补齐后按最小代价重定起点，避免"麻花"扭转。'
  };
}

const MENU_ICON = {
  paths: [
    { d: 'M4 8 L20 8', stroke: 'currentColor', fill: 'none' },
    { d: 'M4 12 L20 12', stroke: 'currentColor', fill: 'none' },
    { d: 'M4 16 L20 16', stroke: 'currentColor', fill: 'none' }
  ]
};

const CLOSE_ICON = {
  paths: [
    { d: 'M5.5 5.5 L18.5 18.5', stroke: 'currentColor', fill: 'none' },
    { d: 'M18.5 5.5 L5.5 18.5', stroke: 'currentColor', fill: 'none' }
  ]
};

function buildIconCase() {
  const duration = 1100;
  const plan = planIconTransition(MENU_ICON, CLOSE_ICON, {
    preset: 'morph',
    duration: 760,
    stagger: 40,
    easing: 'easeInOutCubic'
  });

  // Constant "draw: 1" tracks add noise without adding motion.
  const tracks = plan.tracks.filter(
    (t) => !(t.kind === 'number' && t.keyframes.every((k) => k.value === 1))
  );
  tracks.push({
    id: 'icon-group',
    kind: 'transform',
    target: 'icon-group',
    name: '整体',
    keyframes: [
      { t: 0, value: { scale: 1, rotate: 0, x: 0, y: 0 }, easing: 'easeOutCubic' },
      { t: 380, value: { scale: 0.9, rotate: 0, x: 0, y: 0 }, easing: 'easeInOutCubic' },
      { t: duration, value: { scale: 1, rotate: 0, x: 0, y: 0 }, easing: 'hold' }
    ]
  });

  return {
    timeline: new Timeline({ duration, loop: true, tracks }),
    markup: `
      <g data-motion="icon-group" fill="none" stroke="currentColor" stroke-width="1.9"
         stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke">
        <path data-motion="icon-0" d="${MENU_ICON.paths[0].d}"/>
        <path data-motion="icon-1" d="${MENU_ICON.paths[1].d}"/>
        <path data-motion="icon-2" d="${MENU_ICON.paths[2].d}"/>
      </g>`,
    notes: '菜单三条横线 → 关闭叉号。左边 3 条、右边 2 条，多出的那条收缩到自身重心后消失，而不是被直接丢弃。',
    iconReport: plan.report
  };
}

export const CASES = [
  {
    id: 'draw',
    label: '描边绘制',
    tag: 'stroke reveal',
    viewBox: '0 0 32 32',
    build: buildDrawCase
  },
  {
    id: 'morph',
    label: '路径变形',
    tag: 'path morph',
    viewBox: '0 0 32 32',
    build: buildMorphCase
  },
  {
    id: 'icon',
    label: '图标过渡',
    tag: 'icon transition',
    viewBox: '0 0 24 24',
    build: buildIconCase
  }
];
