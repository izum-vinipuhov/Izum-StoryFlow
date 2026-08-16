import { describe, expect, it } from 'vitest';
import { speakEventFor } from '@/app/reader/utils/speakRouting';

describe('speakEventFor', () => {
  it('stops an active TTS session', () => {
    expect(speakEventFor(true, true)).toBe('tts-stop');
    expect(speakEventFor(true, false)).toBe('tts-stop');
  });

  it('routes to the audiobook when chapters are downloaded', () => {
    expect(speakEventFor(false, true)).toBe('audiobook-play');
  });

  it('falls back to synthesized TTS', () => {
    expect(speakEventFor(false, false)).toBe('tts-speak');
  });
});
