import { get, set, del } from "idb-keyval";
import type { StateStorage } from "zustand/middleware";

export const idbStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const value = await get<string>(name);
    if (value !== undefined) return value;

    // First-run migration: pull from localStorage if IndexedDB is empty
    const legacy = localStorage.getItem(name);
    if (legacy !== null) {
      await set(name, legacy);
      localStorage.removeItem(name);
    }
    return legacy;
  },

  setItem: async (name: string, value: string): Promise<void> => {
    await set(name, value);
  },

  removeItem: async (name: string): Promise<void> => {
    await del(name);
  },
};
