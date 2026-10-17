import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Keep layout movement separate from reader intent, and settle before paint. */
export function useChatScroll(sessionId: string | null, layoutVersion: unknown) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const syncRef = useRef<(() => void) | null>(null);
  const [showLatest, setShowLatest] = useState(false);

  const toLatest = useCallback(() => {
    followRef.current = true;
    syncRef.current?.();
  }, []);

  useLayoutEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    const content = contentRef.current;
    if (!viewport || !content) return;
    followRef.current = true;
    let acknowledgedTop = viewport.scrollTop;
    let acknowledgedFloor = 0;
    let touchY: number | undefined;
    const floor = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const nearBottom = () => Math.abs(floor() - viewport.scrollTop) <= 1;
    const refresh = () => setShowLatest(!followRef.current && !nearBottom());
    const sync = () => {
      const nextFloor = floor();
      if (followRef.current && Math.abs(viewport.scrollTop - nextFloor) > 0.5) viewport.scrollTop = nextFloor;
      acknowledgedTop = viewport.scrollTop;
      acknowledgedFloor = nextFloor;
      refresh();
    };
    const onScroll = () => {
      // Our writes and native clamping after a collapse are layout movement.
      // Neither should change whether subsequent tokens follow the tail.
      const nextFloor = floor();
      const clamped = nextFloor < acknowledgedFloor && Math.abs(viewport.scrollTop - nextFloor) <= 1;
      if (Math.abs(viewport.scrollTop - acknowledgedTop) > 0.5 && !clamped) followRef.current = nearBottom();
      acknowledgedTop = viewport.scrollTop;
      acknowledgedFloor = nextFloor;
      refresh();
    };
    const pause = () => { followRef.current = false; };
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) pause(); };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (nextY !== undefined && touchY !== undefined && nextY > touchY) pause();
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pause();
    };
    syncRef.current = sync;
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: true });
    viewport.addEventListener("keydown", onKeyDown);
    // ResizeObserver already runs before paint. Deferring its correction to
    // another animation frame exposed one frame of stale scroll on every line.
    const observer = new ResizeObserver(sync);
    observer.observe(content);
    observer.observe(viewport);
    sync();
    return () => {
      syncRef.current = null;
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
      viewport.removeEventListener("keydown", onKeyDown);
    };
  }, [sessionId]);

  useLayoutEffect(() => { syncRef.current?.(); }, [sessionId, layoutVersion]);

  return { rootRef, contentRef, showLatest, toLatest };
}
