/**
 * Which player the "Speak" button drives: an active TTS session stops; a
 * playable attached audiobook (downloaded chapters) plays the audiobook and
 * resumes the saved position; otherwise synthesized TTS starts.
 */
export const speakEventFor = (
  ttsEnabled: boolean,
  audiobookPlayable: boolean,
): 'tts-stop' | 'tts-speak' | 'audiobook-play' => {
  if (ttsEnabled) return 'tts-stop';
  if (audiobookPlayable) return 'audiobook-play';
  return 'tts-speak';
};
