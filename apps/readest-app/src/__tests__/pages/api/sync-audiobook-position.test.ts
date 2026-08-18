import { describe, expect, it } from 'vitest';
import { resolveAudioPositionMerge } from '@/pages/api/sync';

const vs = (audioPosition?: unknown) =>
  audioPosition === undefined ? null : JSON.stringify({ ttsLocation: 'cfi', audioPosition });
const pos = (chapterIndex: number, positionSec: number, updatedAt?: number) => ({
  chapterIndex,
  positionSec,
  ...(updatedAt === undefined ? {} : { updatedAt }),
});

const audioPositionOf = (str: string | null | undefined): unknown | undefined => {
  if (!str) return undefined;
  const parsed = JSON.parse(str) as { audioPosition?: unknown };
  return parsed.audioPosition;
};

describe('resolveAudioPositionMerge', () => {
  it('grafts the server position onto the client row when the client row wins but the position is older', () => {
    const merged = resolveAudioPositionMerge(vs(pos(1, 10, 100)), vs(pos(2, 600, 200)), true);
    expect(audioPositionOf(merged)).toEqual(pos(2, 600, 200));
    expect((JSON.parse(merged!) as { ttsLocation?: string }).ttsLocation).toBe('cfi');
  });

  it('leaves the client view_settings untouched when its position is newer', () => {
    const client = vs(pos(2, 600, 300));
    expect(resolveAudioPositionMerge(client, vs(pos(1, 10, 100)), true)).toBe(client);
  });

  it('grafts the client position onto the server row when the server row wins but its position is older', () => {
    const merged = resolveAudioPositionMerge(vs(pos(2, 600, 200)), vs(pos(1, 10, 100)), false);
    expect(audioPositionOf(merged)).toEqual(pos(2, 600, 200));
  });

  it('leaves the server view_settings untouched when its position is newer', () => {
    const server = vs(pos(2, 600, 300));
    expect(resolveAudioPositionMerge(vs(pos(1, 10, 100)), server, false)).toBe(server);
  });

  it('falls back to whole-row LWW when neither position carries a stamp', () => {
    const client = vs(pos(1, 10));
    const server = vs(pos(2, 600));
    expect(resolveAudioPositionMerge(client, server, true)).toBe(client);
    expect(resolveAudioPositionMerge(client, server, false)).toBe(server);
  });

  it('treats a missing position on the losing side as nothing to graft', () => {
    const client = vs(pos(1, 10, 100));
    expect(resolveAudioPositionMerge(client, null, true)).toBe(client);
    expect(resolveAudioPositionMerge(null, client, false)).toBe(client);
  });

  it('survives unparseable view_settings payloads', () => {
    const server = vs(pos(2, 600, 200));
    expect(resolveAudioPositionMerge('not-json{', server, false)).toBe(server);
    // An unparseable winner can't carry a position; grafting onto an empty
    // object repairs the row instead of persisting the garbage.
    expect(audioPositionOf(resolveAudioPositionMerge('not-json{', server, true))).toEqual(
      pos(2, 600, 200),
    );
  });
});
