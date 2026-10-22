# 使用文档

## 1. 打开编辑器

```bash
npm install
npm run build:studio
npm run serve
```

访问 `http://127.0.0.1:4173/studio/`。也可以直接打开线上版本：
`https://llinok111.github.io/vivus-studio/studio/`。

URL 支持 `?case=draw|morph|icon` 预选案例。

> `studio/index.html` 加载的是打包产物 `studio/app.bundle.js`。改了 `studio/*.js` 或
> `src/motion/*.js` 之后必须重新 `npm run build:studio`，否则页面里跑的还是旧代码。

---

## 2. 界面分区

```
┌───────────────────────────────────────────────────────────────┐
│ 案例切换 · 播放 / 停止 / 循环 / 速度 / 当前时刻                 │
├──────────┬────────────────────────────────┬───────────────────┤
│ 案例说明  │                                │ 检查器（关键帧）   │
│ 轨道列表  │            舞台                │ 中断实验台         │
│ 兼容性    │                                │ 导出               │
│ 打点/删除 ├────────────────────────────────┤                   │
│          │         时间轴（轨道 + 关键帧）  │                   │
└──────────┴────────────────────────────────┴───────────────────┘
```

- **轨道列表**：点一下选中轨道，时间轴上对应行高亮。
- **兼容性**：变形案例会显示这次配对用了多少子路径、补了几段、是否旋转/反向。
- **时间轴**：菱形是关键帧，虚线菱形是中断自动合成的锚点。

---

## 3. 快捷键

| 键 | 作用 |
|---|---|
| `空格` | 播放 / 暂停 |
| `←` / `→` | 前后 16 ms（按住 Shift 为 100 ms） |
| `Home` / `End` | 跳到起点 / 终点 |

输入框获得焦点时快捷键不生效，避免打字时误触。

---

## 4. 从零搭一条图标动画

1. **换素材**：打开 `studio/cases.js`，把 `CASES` 里的 `markup` 换成你的 SVG。
   每个要动的元素加一个标记：

   ```html
   <g fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" vector-effect="non-scaling-stroke">
     <path data-motion="icon-0" d="M4 8 L20 8"/>
     <path data-motion="icon-1" d="M4 12 L20 12"/>
   </g>
   ```

   `data-motion` 的值就是轨道里的 `target`。坐标写在 `viewBox` 的坐标系里。

2. **加轨道**：在 `build()` 里返回一个 `Timeline`。三类轨道的最小写法：

   ```js
   // 变形：从 A 形状到 B 形状
   { id: 'shape', kind: 'morph', target: 'icon-0', keyframes: [
       { t: 0,    value: { d: 'M4 8 L20 8' },      easing: 'easeInOutCubic' },
       { t: 600,  value: { d: 'M5.5 5.5 L18.5 18.5' }, easing: 'hold' }
   ]}

   // 描边进度：0 = 未画出，1 = 画完
   { id: 'draw', kind: 'number', target: 'icon-0', keyframes: [
       { t: 0, value: 0, easing: 'easeOutCubic' },
       { t: 500, value: 1, easing: 'hold' }
   ]}

   // 变换：绕元素包围盒中心
   { id: 'scale', kind: 'transform', target: 'icon-group', keyframes: [
       { t: 0,   value: { scale: 1 },     easing: 'easeOutCubic' },
       { t: 250, value: { scale: 0.92 },  easing: 'easeInOutCubic' },
       { t: 700, value: { scale: 1 },     easing: 'hold' }
   ]}
   ```

3. **调**：拖动菱形改时刻；点菱形后在右侧改缓动与数值；`＋ 打点` 把当前形态固化。

4. **导出**：右侧「导出」→ `导出 SVG` 或 `导出 HTML`，下方「下载」。

---

## 5. 缓动怎么选

| 场景 | 建议 |
|---|---|
| 常态进出场 | `easeInOutCubic`（默认，稳） |
| 快速切入、尾巴收住 | `easeOutCubic` / `easeOutQuart` |
| 强调、回弹 | `easeOutBack` |
| 图标瞬间切换 | `hold`（不插值，到点才跳） |
| 需要精确对齐设计稿 | `cubicBezier(x1,y1,x2,y2)` 传自定义函数 |

`hold` 的正确用法是「前一帧 A、后一帧 B」，中间不要留时间，否则会出现半帧的中间态。

---

## 6. 中断实验台怎么读

三个输入：作用轨道、目标值、过渡时长；`中断时刻` 默认跟随游标。

点「在游标处中断」后：

- `接缝 Δ` 是中断瞬间「中断前的采样值」与「中断后的采样值」的差。
  **0 表示视觉上完全连续**——这是这一版的核心承诺。
- `已插入速度衔接点` 表示启用了保持速度：中断后不会先减速到 0 再反向。
- 关键帧计数会涨，但只涨必要的锚点；点「连续中断 ×5」可以看到它不会无限增长。

数值轨道的接缝误差应当严格为 0。变形轨道经过一次字符串重序列化，误差在 1e-3 用户单位以内
（远小于一个像素），断言阈值按这个写。

---

## 7. 导出文件怎么用

**SVG**：直接 `<img src="xxx.svg">` 或 `<object>` 嵌入即可播放，不需要脚本。

```html
<img src="anim.svg" width="200" height="200" alt="">
```

**HTML**：带时间轴滑杆，适合给人看效果或做验收。

```html
<iframe src="anim.html" width="600" height="700"></iframe>
```

如果目标环境不支持 SMIL（例如某些图片代理会剥离动画），请改用 HTML 播放器，
或把 `src/motion` 运行时接进你自己的前端，由 JS 驱动。

---

## 8. 常见问题

**导出后什么都不显示？**
先看描边轨道的目标元素有没有 `stroke`（可以是父级 `<g>` 上的）。纯填充图形没有 dash 可揭示，
导出会跳过该轨道并在报告里写 `no-stroke`。

**变形时图形翻卷/打结？**
两条路径的子路径数量和形状差异过大。看左侧「路径兼容性」里的「塌缩补位」——如果数量很大，
说明这两条路径本来就不该做变形，改用 `fade` 或 `draw` 过渡更合理。

**缩放后描边缺一截？**
运行时会监听 `ResizeObserver` 重算；如果容器尺寸由父级 `transform` 改变（不触发 resize），
需要手动调 `scene.refreshStrokes()`。
