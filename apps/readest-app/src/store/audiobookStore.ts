import { create } from 'zustand';

interface AudiobookState {
  /** bookKey -> the book's attached audiobook has downloaded chapters to play. */
  playable: Record<string, boolean>;
  setPlayable: (bookKey: string, playable: boolean) => void;
  /** bookKey -> bump counter: open the TTS player panel on the chapters view. */
  panelRequest: Record<string, number>;
  requestPanel: (bookKey: string) => void;
}

/**
 * Minimal cross-cutting signal so the reader's "Speak" button can route to
 * the audiobook session instead of synthesized TTS when the book has a
 * playable audiobook (useAudiobookPlayback keeps it up to date).
 */
export const useAudiobookStore = create<AudiobookState>((set) => ({
  playable: {},
  setPlayable: (bookKey, playable) =>
    set((state) => ({ playable: { ...state.playable, [bookKey]: playable } })),
  panelRequest: {},
  requestPanel: (bookKey) =>
    set((state) => ({
      panelRequest: {
        ...state.panelRequest,
        [bookKey]: (state.panelRequest[bookKey] ?? 0) + 1,
      },
    })),
}));
