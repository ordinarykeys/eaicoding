import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface AccountView {
  signedIn: boolean;
  name: string | null;
  contact: string | null;
  phase: string;
  error: string | null;
  attemptId: string | null;
}
interface AccountStore {
  view: AccountView;
  ready: boolean;
  busy: boolean;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  logout: () => Promise<void>;
}
const empty: AccountView = { signedIn: false, name: null, contact: null, phase: "signed-out", error: null, attemptId: null };
let revision = 0;
let readSequence = 0;
export const useDeepSeekAccount = create<AccountStore>((set, get) => ({
  view: empty, ready: false, busy: false,
  refresh: async () => {
    const before = revision;
    const sequence = ++readSequence;
    try {
      const view = await invoke<AccountView>("deepseek_account_status");
      if (revision === before && sequence === readSequence) set({ view, ready: true });
    } catch (error) {
      if (revision === before && sequence === readSequence) set({ ready: true, view: { ...get().view, error: String(error) } });
    }
  },
  start: async () => {
    if (get().busy) return;
    const current = ++revision;
    set({ busy: true, view: { ...empty, phase: "initializing" } });
    try {
      const view = await invoke<AccountView>("deepseek_account_start", { timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 });
      if (revision === current) set({ view });
    } catch (error) { if (revision === current) set({ view: { ...empty, phase: "failed", error: String(error) } }); }
    finally { if (revision === current) set({ busy: false }); }
  },
  cancel: async () => {
    const attemptId = get().view.attemptId;
    if (!attemptId || get().busy) return;
    const current = ++revision;
    set({ busy: true });
    try {
      const view = await invoke<AccountView>("deepseek_account_cancel", { attemptId });
      if (revision === current) set({ view });
    } catch (error) { if (revision === current) set({ view: { ...get().view, error: String(error) } }); }
    finally { if (revision === current) set({ busy: false }); }
  },
  logout: async () => {
    if (get().busy) return;
    const current = ++revision;
    set({ busy: true });
    try {
      await invoke("deepseek_account_logout");
      if (revision === current) set({ view: empty });
    } catch (error) {
      // The native side clears the active grant even if removal on disk fails.
      if (revision === current) set({ view: { ...empty, error: String(error) } });
    } finally { if (revision === current) set({ busy: false }); }
  },
}));
