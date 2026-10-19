import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createBonusNoticeController, type BonusNotice, type AccountBonusBatch } from "@/lib/account-notices";

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
  notices: readonly BonusNotice[];
  noticeShown: (orderId: string) => void;
  dismissNotice: (orderId: string) => void;
  details: AccountDetails | null;
  detailsLoading: boolean;
  detailsError: string | null;
  refreshDetails: () => Promise<void>;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  logout: () => Promise<void>;
}
export interface Wallet { currency: "CNY" | "USD"; balance: string }
export interface AccountDetails {
  name: string | null;
  contact: string | null;
  profileAvailable: boolean;
  wallets: Wallet[] | null;
  bonusWallets: Wallet[] | null;
}
const empty: AccountView = { signedIn: false, name: null, contact: null, phase: "signed-out", error: null, attemptId: null };
let revision = 0;
let readSequence = 0;
export const useDeepSeekAccount = create<AccountStore>((set, get) => ({
  notices: [],
  noticeShown: orderId => noticeController.shown(orderId),
  dismissNotice: orderId => noticeController.dismiss(orderId),
  view: empty, ready: false, busy: false, details: null, detailsLoading: false, detailsError: null,
  refreshDetails: async () => {
    if (!get().view.signedIn || get().detailsLoading) return;
    void noticeController.refresh();
    const current = revision;
    set({ detailsLoading: true, detailsError: null });
    try {
      const details = await invoke<AccountDetails>("deepseek_account_details", { timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 });
      if (revision === current && get().view.signedIn) set({ details, ...(details.profileAvailable ? { view: { ...get().view, name: details.name, contact: details.contact } } : {}) });
    } catch (error) { if (revision === current) set({ detailsError: String(error) }); }
    finally { if (revision === current) set({ detailsLoading: false }); }
  },
  refresh: async () => {
    const before = revision;
    const sequence = ++readSequence;
    try {
      const view = await invoke<AccountView>("deepseek_account_status");
      if (revision === before && sequence === readSequence) {
        set({ view, ready: true, ...(!view.signedIn ? { details: null, detailsLoading: false, detailsError: null } : {}) });
        if (view.signedIn) noticeController.begin(); else noticeController.end();
      }
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
    noticeController.end();
    set({ busy: true });
    try {
      await invoke("deepseek_account_logout");
      if (revision === current) set({ view: empty, details: null, detailsLoading: false, detailsError: null });
    } catch (error) {
      // The native side clears the active grant even if removal on disk fails.
      if (revision === current) set({ view: { ...empty, error: String(error) }, details: null, detailsLoading: false, detailsError: null });
    } finally { if (revision === current) set({ busy: false }); }
  },
}));

// Session-only notice state and retries, matching Harness. No timers poll the server.
const noticeController = createBonusNoticeController({
  ackRetryDelayMs: 1000, ackRetryMaxDelayMs: 60000,
  read: () => useDeepSeekAccount.getState().view.signedIn
    ? invoke<AccountBonusBatch>("deepseek_account_notices", { timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }) : Promise.resolve(null),
  acknowledge: (accountId, orderId) => invoke<boolean>("deepseek_account_notice_ack", { accountId, orderId }),
  publish: notices => useDeepSeekAccount.setState({ notices }),
});
