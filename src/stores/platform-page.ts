import { create } from "zustand";

export type PlatformPage = "usage" | "top-up";
export const usePlatformPage = create<{
  page: PlatformPage | null;
  open: (page: PlatformPage) => void;
  close: () => void;
}>(set => ({ page: null, open: page => set({ page }), close: () => set({ page: null }) }));
