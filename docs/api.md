# API

运行时全部在 `src/motion/`，ES Module，零依赖。`dist/svg-motion.mjs` 是打包后的单文件版本。
浏览器与 Node 都能导入；只有 `MotionScene`、`StrokePainter` 和导出器需要 DOM。

---

## 时间轴

### `new Timeline({ duration, loop, tracks })`

- `duration`：毫秒
- `tracks`：`Array<Track | TrackSpec>`，`TrackSpec = { id, kind, name, target, keyframes }`
- `kind`：`'morph' | 'number' | 'transform' | 'style'`

### `timeline.sampleAt(time) → Map<trackId, value>`

**纯函数**。同一时间永远得到同一个结果，与播放状态无关。擦洗、播放、导出都走这里。

返回值按轨道类型：

| kind | 采样值 |
|---|---|
| `morph` | `d` 字符串 |
| `number` | `number` |
| `transform` | `{ x, y, scale, rotate }`（缺省字段不出现在结果里） |
| `style` | `{ opacity, fill, stroke, strokeWidth }` |

### `timeline.sampleTrack(track, time) → value`

单轨采样，用于检查器与调试。

### `timeline.interrupt(trackId, opts) → { origin, target, blend, previous }`

中途重定向。`opts`：

| 字段 | 说明 |
|---|---|
| `at` | 中断时刻（毫秒），通常传 `scene.time` |
| `value` | 新目标值；`morph` 轨道可传 `{ d }` 或裸 `d` 字符串 |
| `duration` | 新过渡时长，默认 300 |
| `easing` / `easingOut` | 起点段 / 终点段缓动 |
| `preserveVelocity` | 仅 `number` 轨道有效，插入速度衔接点 |

语义：

1. 采样 `at` 时刻的当前值；
2. 丢弃 `at` 之后所有**合成**关键帧（属于已经作废的未来）；
3. 把当前值写成锚点关键帧；
4. 在 `at + duration`（不超过 `duration` 上界）写目标关键帧；
5. 若 `preserveVelocity`，在 35% 处插一个按当前速度外推的衔接点，并把起点段设为线性
   （缓动起点会带来 1.57×–2× 的初速跃变）。

返回值中 `previous` 是中断前的采样值，便于调用方自己算接缝误差。

### `timeline.morphReport(trackId) → { subpaths, segmentsPerSubpath, totalSegments }`

变形轨道统一化之后的几何结构。

### `timeline.toJSON()` / `Timeline.fromJSON(json)`

序列化只保留 `t / value / easing`，合成标记不落盘。

### `new Track({...}).insertKeyframe(t, value, easing)` / `.removeKeyframe(id)`

`insertKeyframe` 永不与相邻帧合并（中断锚点需要精确时刻）；
`setKeyframe` 会在 `tolerance`（默认 0.5 ms）内替换既有帧，用于用户编辑。

---

## 场景

### `new MotionScene(root, { timeline, rate, loop })`

`root` 是 `<svg>`。构造时扫描 `[data-motion]` 建立绑定。

### `scene.play({ from, rate })` / `pause()` / `seek(t)` / `stop()`

时钟基于 `performance.now()` 增量推算，不累加每帧误差；每次 `play()` 递增内部 epoch，
旧 rAF 回调无法复活。

### `scene.renderAt(t)`

只读时间轴、只写 DOM。

### `scene.interrupt(trackId, opts)`

转调 `timeline.interrupt` 并立即重绘，暂停状态下也能看到结果。

### `scene.on('tick' | 'end' | 'interrupt', fn)`

### `scene.bind()` / `refreshStrokes()` / `destroy()`

`bind()` 幂等；`refreshStrokes()` 在容器尺寸变化但未触发 `resize` 时手动调用。

---

## 描边

### `measureStroke(el, { gap, forceScale }) → { length, dashArray, offsetAt(p) }`

长度用浮点而非 `ceil`：向上取整会在短路径末端留一截永远画不完的笔画。
`vector-effect: non-scaling-stroke` 时按 `sqrt(|det(getScreenCTM())|)` 修正——
用包围盒比值修正在旋转元素上会算错。

### `new StrokePainter(el, { gap, autoRefresh })`

自行挂 `ResizeObserver` 与 `resize`，重新测量后保持当前进度。
`setProgress(p)` 幂等，亚像素变化不写 DOM。

### `staggerSchedule(lengths, { mode, duration, delay }) → [{ startAt, duration }]`

`mode`: `'sync' | 'delayed' | 'oneByOne'`，与上游 vivus 的术语一致，便于迁移直觉。

---

## 几何

### `normalizePath(d) → { subpaths, stats }`

`subpaths[i] = { start: [x,y], segments: [{ c1, c2, to }], closed }`。
所有命令（含 `A`、`Q`、`S`、`T`、相对命令）都变成三次贝塞尔。

### `prepareMorph(from, to, { maxSegments }) → { from, to, report }`

一次性把两套子路径对齐。`report` 字段：`paired / collapsed / resampled / rotated / reversed / segments / strategy`。

### `interpolatePaths(from, to, t, precision) → d 字符串`

### `alignSubpaths(a, b)` / `resampleSubpath(sp, n)` / `rotateSubpath(sp, k)` / `reverseSubpath(sp)`

拆分与重定锚都是精确操作，不改变轮廓：拆分用 de Casteljau，重定锚只改变遍历起点，
反向只交换控制点顺序。

### `unifyMorphKeyframes(keyframes) → { frames, meta }`

把一个变形轨道的**所有**关键帧重写成同一命令结构，供 SMIL `values` 使用。
顺序：按面积排序子路径 → 各帧重采样到轨道内最大段数 → 逐帧相对前一帧重定锚 → 去掉 `Z`
（闭合段在归一化时已实体化，去掉 `Z` 不改变填充结果，但能让每帧签名一致）。

### `subpathLength / subpathArea / subpathCentroid / samplePolygon / pairCost / splitSegment`

曲线长度用 5 点 Gauss-Legendre 求积（权重和为 2，直线段精确）。

---

## 图标

### `extractIcon(svgEl) → { viewBox, paths }`

### `normalizeIconPair(from, to) → { items, report }`

按索引配对；一侧缺路径时，用 `collapsePath` 生成一个「停在自身重心」的退化轮廓。

### `planIconTransition(from, to, { preset, duration, stagger, easing }) → { tracks, report, elements }`

`preset`：`'morph' | 'draw' | 'fade' | 'morphDraw'`。
返回的 `tracks` 可直接喂给 `new Timeline({ tracks })`。

---

## 导出

### `exportSmil(root, timeline, { fps, loop, title, origins }) → { svg, report }`

- `origins`：`{ [targetName]: [cx, cy] }`，旋转轴心。传 `scene.bindings` 里的 `origin`
  可以保证与预览完全一致；不传则实时取活元素包围盒中心。
- `report`：`{ fps, frameCount, duration, tracks, unsupported, bytes }`
- 每个 `<path>` 只产出一个 `d` 动画：变换被烘焙进几何（矩阵插值会让旋转中的形状塌陷）。
- 描边用 `pathLength="1"` + `dasharray="1 3"`，并把 offset 多推 `strokeWidth/2/len`
  以隐藏圆头端帽。

### `exportHtml({ svg, title, duration, fps }) → string`

内联 SVG + 时间轴滑杆，通过 `setCurrentTime` / `pauseAnimations` 控制 SMIL 时钟。

### `bakeTransform(d, matrix) → d`

把 2×3 仿射矩阵应用到路径数据上（先归一化，避免破坏圆弧参数）。

---

## 缓动

`EASINGS`（22 条）、`EASING_NAMES`、`resolveEasing(nameOrFn)`、`cubicBezier(x1,y1,x2,y2)`。

`hold` 是阶梯函数：`t < 1` 返回 0，`t === 1` 返回 1。
