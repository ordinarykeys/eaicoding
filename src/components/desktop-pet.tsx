/**
 * DesktopPet — Clawd crab embedded into the Tauri window
 * ----------------------------------------------------------------------------
 *
 * Crab animation assets are from clawd-on-desk (AGPL-3.0).
 * 这里把它从独立 Electron 浮窗简化成桌面应用内嵌的浮动小窗口：
 *   - 8 states map to clawd-*.gif assets (idle / thinking / typing / building /
 *     error / happy / sleeping / notification)
 *   - 状态由 PetState 全局事件驱动（chat-view 在生成开始/中/结束时调用）
 *   - 整个角色可拖拽到任意位置；位置写入 zustand 持久化
 *   - 双击切换"睡觉"模式；右键菜单切显示气泡
 *   - 完成 / 错误 时短暂播放 sound（用户开关）
 *   - 闲置 90s 后自动进入 sleeping 动画
 *
 * 不会发起任何网络请求，所有动作都通过事件 bus 由 chat-view 触发。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSettingsStore } from "@/stores/settings";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type PetState =
  | "idle"
  | "thinking"
  | "typing"
  | "building"
  | "happy"
  | "error"
  | "sleeping"
  | "notification";

const STATE_GIF: Record<PetState, string> = {
  idle: "/pet/gif/clawd-idle.gif",
  thinking: "/pet/gif/clawd-thinking.gif",
  typing: "/pet/gif/clawd-typing.gif",
  building: "/pet/gif/clawd-building.gif",
  happy: "/pet/gif/clawd-happy.gif",
  error: "/pet/gif/clawd-error.gif",
  sleeping: "/pet/gif/clawd-sleeping.gif",
  notification: "/pet/gif/clawd-notification.gif",
};

const STATE_BUBBLE: Partial<Record<PetState, string>> = {
  thinking: "我在想...",
  typing: "正在生成代码",
  building: "调用工具中",
  happy: "✨ 编译通过",
  error: "出错啦，看看输出",
  notification: "新消息",
  sleeping: "Z z z…",
};

// ---------------------------------------------------------------------------
// Global event bus — the agent runner / chat-view dispatches signals here
// ---------------------------------------------------------------------------

type PetEventDetail = {
  state: PetState;
  /** Optional bubble override; falls back to STATE_BUBBLE[state]. */
  bubble?: string;
  /** Auto-revert to idle after `holdMs` (default: state-specific). */
  holdMs?: number;
};

const PET_EVENT = "eaicoding:pet";

export function emitPet(detail: PetEventDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PetEventDetail>(PET_EVENT, { detail }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DEFAULT_HOLD_MS: Partial<Record<PetState, number>> = {
  happy: 4500,
  error: 6000,
  notification: 3500,
};

const SLEEP_AFTER_IDLE_MS = 90_000;

interface DesktopPetProps {
  placement?: "floating" | "composer" | "chat";
}

export function DesktopPet({ placement = "floating" }: DesktopPetProps) {
  const enabled = useSettingsStore((s) => s.petEnabled);
  const soundEnabled = useSettingsStore((s) => s.petSoundEnabled);
  const persistedPos = useSettingsStore((s) => s.petPosition);
  const setPetPosition = useSettingsStore((s) => s.setPetPosition);
  const isComposerPlacement = placement === "composer";
  const isChatPlacement = placement === "chat";
  const isInlinePlacement = isComposerPlacement || isChatPlacement;

  const [state, setState] = useState<PetState>("idle");
  const [bubble, setBubble] = useState<string | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number }>(() => {
    if (persistedPos) return persistedPos;
    return { x: window.innerWidth - 140, y: window.innerHeight - 180 };
  });

  const dragStart = useRef<{
    pointerX: number;
    pointerY: number;
    posX: number;
    posY: number;
  } | null>(null);
  const idleTimer = useRef<number | null>(null);
  const revertTimer = useRef<number | null>(null);

  // Restore + clamp position when window resizes
  useEffect(() => {
    if (isInlinePlacement) return;
    const onResize = () => {
      setPosition((prev) => clampToWindow(prev));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isInlinePlacement]);

  // Persist position (debounced)
  useEffect(() => {
    if (isInlinePlacement) return;
    const t = window.setTimeout(() => {
      setPetPosition(position);
    }, 400);
    return () => window.clearTimeout(t);
  }, [isInlinePlacement, position, setPetPosition]);

  // Bus listener
  useEffect(() => {
    const handler = (event: Event) => {
      const ce = event as CustomEvent<PetEventDetail>;
      const detail = ce.detail;
      setState(detail.state);
      setBubble(detail.bubble ?? STATE_BUBBLE[detail.state] ?? null);

      // Auto-revert to idle for transient states
      if (revertTimer.current) {
        window.clearTimeout(revertTimer.current);
        revertTimer.current = null;
      }
      const hold = detail.holdMs ?? DEFAULT_HOLD_MS[detail.state];
      if (hold) {
        revertTimer.current = window.setTimeout(() => {
          setState("idle");
          setBubble(null);
        }, hold);
      }

      // Sound effects on key transitions
      if (soundEnabled) {
        if (detail.state === "happy") playSound("/pet/complete.mp3");
        else if (detail.state === "notification") playSound("/pet/confirm.mp3");
      }

      // Reset the idle→sleeping timer
      armIdleTimer();
    };
    window.addEventListener(PET_EVENT, handler);
    armIdleTimer();
    return () => {
      window.removeEventListener(PET_EVENT, handler);
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      if (revertTimer.current) window.clearTimeout(revertTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundEnabled]);

  const armIdleTimer = useCallback(() => {
    if (idleTimer.current) {
      window.clearTimeout(idleTimer.current);
    }
    idleTimer.current = window.setTimeout(() => {
      setState((prev) => (prev === "idle" ? "sleeping" : prev));
    }, SLEEP_AFTER_IDLE_MS);
  }, []);

  // Drag handlers
  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (isInlinePlacement) return;
      if (event.button !== 0) return;
      (event.target as Element).setPointerCapture?.(event.pointerId);
      dragStart.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        posX: position.x,
        posY: position.y,
      };
    },
    [isInlinePlacement, position],
  );
  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (isInlinePlacement) return;
    const start = dragStart.current;
    if (!start) return;
    const next = clampToWindow({
      x: start.posX + (event.clientX - start.pointerX),
      y: start.posY + (event.clientY - start.pointerY),
    });
    setPosition(next);
  }, [isInlinePlacement]);
  const onPointerUp = useCallback(() => {
    dragStart.current = null;
  }, []);

  const onDoubleClick = useCallback(() => {
    setState((prev) => (prev === "sleeping" ? "happy" : "sleeping"));
    setBubble(null);
  }, []);

  const gifSrc = useMemo(() => STATE_GIF[state], [state]);

  if (!enabled) return null;

  if (isInlinePlacement) {
    return (
      <div
        className={isChatPlacement ? "chat-inline-pet" : "code-composer-pet"}
        aria-hidden="true"
      >
        <div
          onDoubleClick={onDoubleClick}
          title="易语言 AI 助手"
          className={
            isChatPlacement
              ? "chat-inline-pet-shell"
              : "code-composer-pet-shell"
          }
          style={{
            filter:
              state === "error"
                ? "drop-shadow(0 0 10px rgba(220,80,60,0.45))"
                : state === "happy"
                  ? "drop-shadow(0 0 12px rgba(80,200,120,0.35))"
                  : state === "thinking" || state === "building" || state === "typing"
                    ? "drop-shadow(0 0 10px rgba(80,140,255,0.3))"
                    : "drop-shadow(0 4px 8px rgba(0,0,0,0.12))",
            transition: "filter 240ms ease",
          }}
        >
          {bubble && !isChatPlacement && (
            <div className="code-composer-pet-bubble">
              {bubble}
            </div>
          )}
          <img
            key={gifSrc}
            src={gifSrc}
            alt={`pet ${state}`}
            draggable={false}
            className={
              isChatPlacement
                ? "chat-inline-pet-image"
                : isComposerPlacement
                  ? "code-composer-pet-image"
                  : "h-full w-full object-contain pointer-events-none"
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed z-[9999] select-none touch-none"
      style={{ left: position.x, top: position.y }}
    >
      {bubble && (
        <div
          className="absolute -top-9 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full whitespace-nowrap text-xs font-medium shadow-lg border"
          style={{
            background: "rgba(28, 25, 23, 0.92)",
            color: "#FCEDD2",
            borderColor: "rgba(255,255,255,0.08)",
            backdropFilter: "blur(6px)",
          }}
        >
          {bubble}
          <span
            className="absolute left-1/2 -bottom-[5px] -translate-x-1/2 w-2.5 h-2.5 rotate-45"
            style={{ background: "rgba(28, 25, 23, 0.92)" }}
          />
        </div>
      )}

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        title={"易语言 AI 助手 · Clawd 螃蟹 · 双击休眠/唤醒，可拖拽"}
        className="relative w-[120px] h-[120px] cursor-grab active:cursor-grabbing"
        style={{
          filter:
            state === "error"
              ? "drop-shadow(0 0 12px rgba(220,80,60,0.55))"
              : state === "happy"
                ? "drop-shadow(0 0 14px rgba(80,200,120,0.45))"
                : state === "thinking" || state === "building" || state === "typing"
                  ? "drop-shadow(0 0 12px rgba(80,140,255,0.35))"
                  : "drop-shadow(0 4px 8px rgba(0,0,0,0.25))",
          transition: "filter 240ms ease",
        }}
      >
        <img
          key={gifSrc}
          src={gifSrc}
          alt={`pet ${state}`}
          draggable={false}
          className="w-full h-full object-contain pointer-events-none"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampToWindow(pos: { x: number; y: number }) {
  const W = 120;
  const H = 120;
  const maxX = Math.max(0, window.innerWidth - W);
  const maxY = Math.max(0, window.innerHeight - H);
  return {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY),
  };
}

let lastPlay = 0;
function playSound(path: string) {
  // Throttle so successive triggers don't stack
  const now = Date.now();
  if (now - lastPlay < 600) return;
  lastPlay = now;
  try {
    const audio = new Audio(path);
    audio.volume = 0.5;
    void audio.play();
  } catch {
    // Browsers may block autoplay; silent failure is fine
  }
}
