import { create } from 'zustand';

/**
 * Hands a generated password from /generator back to the edit form. In memory only, taken once
 * (never via route params, which could end up in navigation state or logs).
 */
type GeneratorHandoff = {
  value: string | null;
  offer: (value: string) => void;
  take: () => string | null;
};

export const useGeneratorHandoff = create<GeneratorHandoff>((set, get) => ({
  value: null,
  offer: (value) => set({ value }),
  take: () => {
    const v = get().value;
    if (v !== null) set({ value: null });
    return v;
  },
}));
