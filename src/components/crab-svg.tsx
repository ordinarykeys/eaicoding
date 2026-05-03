/**
 * CrabPet — 纯 SVG 实现的螃螃像素螃蟹角色，完全透明背景。
 *
 * 设计要点：
 *   - 单文件 SVG，不依赖任何素材，背景透明（PNG / GIF 都不需要）
 *   - 有命名 id 的子元素（body / left-claw / right-claw / left-eye-stalk /
 *     right-eye-stalk / leg-1..leg-3 / pupil-l / pupil-r），通过 CSS 关键帧
 *     针对不同状态触发不同动画
 *   - 8 个状态共用一份 SVG，由父级容器附加 .crab-state-{state} 类来切换动画
 *
 * 主题色：
 *   - 主体：橘红渐变 (#FF7A45 → #C24B2C)
 *   - 高光：浅杏 (#FFD2B0)
 *   - 暗部：深红 (#8C2A1A)
 *   - 眼柄白 + 黑瞳孔
 *
 * 搭配 styles/crab-pet.css 的 keyframes 使用。
 */

import * as React from "react";

export type CrabState =
  | "idle"
  | "thinking"
  | "typing"
  | "building"
  | "happy"
  | "error"
  | "sleeping"
  | "notification";

export interface CrabSvgProps {
  state: CrabState;
  /** Pixel size (square). Default 120. */
  size?: number;
  /** Body color override. */
  color?: string;
}

export const CrabSvg = React.forwardRef<SVGSVGElement, CrabSvgProps>(function CrabSvg(
  { state, size = 120, color },
  ref,
) {
  const palette = {
    bodyTop: color ?? "#FF7A45",
    bodyBottom: color ? darken(color, 0.25) : "#C24B2C",
    highlight: "#FFD2B0",
    deep: "#8C2A1A",
    stalk: "#FFE8D5",
    pupil: "#1A1A1A",
    shellShadow: "rgba(0,0,0,0.18)",
  };

  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      xmlns="http://www.w3.org/2000/svg"
      className={`crab-svg crab-state-${state}`}
      style={{ overflow: "visible", background: "transparent" }}
    >
      <defs>
        <radialGradient id="crab-body-grad" cx="50%" cy="38%" r="65%">
          <stop offset="0%" stopColor={palette.highlight} />
          <stop offset="55%" stopColor={palette.bodyTop} />
          <stop offset="100%" stopColor={palette.bodyBottom} />
        </radialGradient>
        <radialGradient id="crab-claw-grad" cx="50%" cy="35%" r="70%">
          <stop offset="0%" stopColor={palette.highlight} />
          <stop offset="60%" stopColor={palette.bodyTop} />
          <stop offset="100%" stopColor={palette.deep} />
        </radialGradient>
        <filter id="crab-soft-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.25" />
        </filter>
      </defs>

      {/* 影子（轻微，不喧宾夺主） */}
      <ellipse
        id="crab-shadow"
        cx="60"
        cy="100"
        rx="30"
        ry="4"
        fill={palette.shellShadow}
        opacity="0.55"
      />

      {/* 整个角色，方便统一上下浮动 */}
      <g id="crab-root">
        {/* 腿（左 3 + 右 3） */}
        <g id="crab-legs" stroke={palette.deep} strokeWidth="3.2" strokeLinecap="round" fill="none">
          {/* 左腿 */}
          <path id="leg-l1" d="M 40 70 Q 28 76 22 88" />
          <path id="leg-l2" d="M 35 75 Q 18 84 14 96" />
          <path id="leg-l3" d="M 38 80 Q 24 92 28 100" />
          {/* 右腿 */}
          <path id="leg-r1" d="M 80 70 Q 92 76 98 88" />
          <path id="leg-r2" d="M 85 75 Q 102 84 106 96" />
          <path id="leg-r3" d="M 82 80 Q 96 92 92 100" />
        </g>

        {/* 钳子 — 左 */}
        <g id="left-claw" filter="url(#crab-soft-shadow)" transform="rotate(-12 30 50)">
          <path
            d="M 30 50 Q 14 48 10 36 Q 6 24 18 22 Q 26 21 32 28 Q 28 32 30 36 Q 32 40 30 50 Z"
            fill="url(#crab-claw-grad)"
            stroke={palette.deep}
            strokeWidth="1.6"
          />
          {/* 钳口缝 */}
          <path
            d="M 12 30 Q 22 26 30 30"
            stroke={palette.deep}
            strokeWidth="1.4"
            fill="none"
          />
        </g>

        {/* 钳子 — 右 */}
        <g id="right-claw" filter="url(#crab-soft-shadow)" transform="rotate(12 90 50)">
          <path
            d="M 90 50 Q 106 48 110 36 Q 114 24 102 22 Q 94 21 88 28 Q 92 32 90 36 Q 88 40 90 50 Z"
            fill="url(#crab-claw-grad)"
            stroke={palette.deep}
            strokeWidth="1.6"
          />
          <path
            d="M 108 30 Q 98 26 90 30"
            stroke={palette.deep}
            strokeWidth="1.4"
            fill="none"
          />
        </g>

        {/* 主体壳 */}
        <g id="crab-body" filter="url(#crab-soft-shadow)">
          <ellipse
            cx="60"
            cy="62"
            rx="28"
            ry="22"
            fill="url(#crab-body-grad)"
            stroke={palette.deep}
            strokeWidth="1.8"
          />
          {/* 壳上小斑点 */}
          <circle cx="50" cy="56" r="2.2" fill={palette.deep} opacity="0.25" />
          <circle cx="68" cy="58" r="1.8" fill={palette.deep} opacity="0.25" />
          <circle cx="60" cy="68" r="1.6" fill={palette.deep} opacity="0.25" />
        </g>

        {/* 眼柄 + 眼睛 */}
        <g id="crab-eyes">
          <line
            id="left-stalk"
            x1="52"
            y1="44"
            x2="48"
            y2="30"
            stroke={palette.deep}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <line
            id="right-stalk"
            x1="68"
            y1="44"
            x2="72"
            y2="30"
            stroke={palette.deep}
            strokeWidth="2.2"
            strokeLinecap="round"
          />

          <g id="left-eye">
            <circle cx="48" cy="28" r="6" fill={palette.stalk} stroke={palette.deep} strokeWidth="1.4" />
            <circle id="pupil-l" cx="48" cy="28" r="2.6" fill={palette.pupil} />
            <circle cx="46.6" cy="26.4" r="0.9" fill="#fff" />
          </g>
          <g id="right-eye">
            <circle cx="72" cy="28" r="6" fill={palette.stalk} stroke={palette.deep} strokeWidth="1.4" />
            <circle id="pupil-r" cx="72" cy="28" r="2.6" fill={palette.pupil} />
            <circle cx="70.6" cy="26.4" r="0.9" fill="#fff" />
          </g>

          {/* 睡觉时显示 zZ */}
          <g id="crab-zz" opacity="0">
            <text
              x="80"
              y="20"
              fill={palette.deep}
              fontSize="11"
              fontFamily="ui-monospace, monospace"
              fontWeight="bold"
            >
              z
            </text>
            <text
              x="88"
              y="14"
              fill={palette.deep}
              fontSize="9"
              fontFamily="ui-monospace, monospace"
              fontWeight="bold"
            >
              Z
            </text>
          </g>

          {/* 出错时的红色感叹号气泡（默认 hidden） */}
          <g id="crab-bang" opacity="0">
            <circle cx="92" cy="22" r="8" fill="#E53935" stroke={palette.deep} strokeWidth="1.4" />
            <text
              x="89"
              y="26"
              fill="#fff"
              fontSize="11"
              fontFamily="ui-monospace, monospace"
              fontWeight="bold"
            >
              !
            </text>
          </g>

          {/* 通知/思考时显示 ✦ 闪光 */}
          <g id="crab-spark" opacity="0">
            <path
              d="M 92 22 L 94 14 L 96 22 L 104 24 L 96 26 L 94 34 L 92 26 L 84 24 Z"
              fill="#FFC83D"
              stroke={palette.deep}
              strokeWidth="0.8"
            />
          </g>

          {/* 嘴 — happy 张开 / idle 微笑 / error 翻转 */}
          <path
            id="crab-mouth"
            d="M 54 70 Q 60 74 66 70"
            stroke={palette.deep}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
          />
        </g>
      </g>
    </svg>
  );
});

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

function darken(hex: string, amount: number): string {
  // tiny color darken: not perfect but enough for fallback
  const m = hex.replace("#", "");
  if (m.length !== 6) return hex;
  const r = Math.max(0, Math.floor(parseInt(m.slice(0, 2), 16) * (1 - amount)));
  const g = Math.max(0, Math.floor(parseInt(m.slice(2, 4), 16) * (1 - amount)));
  const b = Math.max(0, Math.floor(parseInt(m.slice(4, 6), 16) * (1 - amount)));
  return `#${[r, g, b]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}
