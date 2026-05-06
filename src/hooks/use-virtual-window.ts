import { useMemo } from "react";

export interface VirtualWindow<T> {
  items: T[];
  offset: number;
  total: number;
  truncated: boolean;
}

export function useVirtualWindow<T>(
  items: T[],
  activeTailWindow = 120,
): VirtualWindow<T> {
  return useMemo(() => {
    if (items.length <= activeTailWindow) {
      return {
        items,
        offset: 0,
        total: items.length,
        truncated: false,
      };
    }
    const offset = items.length - activeTailWindow;
    return {
      items: items.slice(offset),
      offset,
      total: items.length,
      truncated: true,
    };
  }, [activeTailWindow, items]);
}
