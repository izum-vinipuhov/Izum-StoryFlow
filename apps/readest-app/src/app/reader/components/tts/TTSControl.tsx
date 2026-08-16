import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';
import { useThemeStore } from '@/store/themeStore';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useTTSControl } from '@/app/reader/hooks/useTTSControl';
import { useTTSDownloads } from '@/app/reader/hooks/useTTSDownloads';
import { useAudiobookPlayback } from '@/app/reader/hooks/useAudiobookPlayback';
import { useBookProgress } from '@/store/readerProgressStore';
import { Insets } from '@/types/misc';
import { eventDispatcher } from '@/utils/event';
import { useAudiobookStore } from '@/store/audiobookStore';
import TTSMiniPlayer from './TTSMiniPlayer';
import TTSPlayerSheet from './TTSPlayerSheet';
import type { AudiobookSectionData } from './TTSChaptersView';
import { useMiniPlayerAutoHide } from './useMiniPlayerAutoHide';

interface TTSControlProps {
  bookKey: string;
  gridInsets: Insets;
}

const TTSControl: React.FC<TTSControlProps> = ({ bookKey, gridInsets }) => {
  const _ = useTranslation();
  const { safeAreaInsets } = useThemeStore();
  const { getViewSettings } = useReaderStore();

  const [showPlayerSheet, setShowPlayerSheet] = useState(false);
  const backButtonTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shouldMountBackButton, setShouldMountBackButton] = useState(false);
  const [isBackButtonVisible, setIsBackButtonVisible] = useState(false);
  const [sheetInitialView, setSheetInitialView] = useState<'chapters' | undefined>(undefined);

  const tts = useTTSControl({
    bookKey,
    onRequestHidePanel: () => setShowPlayerSheet(false),
  });

  const downloads = useTTSDownloads(bookKey, tts.getController, showPlayerSheet);
  const audiobook = useAudiobookPlayback(bookKey);
  const panelRequest = useAudiobookStore((s) => s.panelRequest[bookKey] ?? 0);
  const activeSectionIndex = useBookProgress(bookKey)?.index ?? null;

  const viewSettings = getViewSettings(bookKey);
  const isEink = viewSettings?.isEink ?? false;
  const playerStyle = viewSettings?.ttsPlayerStyle ?? 'full';
  const hasTimeline = tts.ttsClientsInited && tts.handleSupportsPlaybackInfo();
  const audiobookActive = audiobook.isActive;
  const miniPlayerMounted = (tts.showIndicator || audiobookActive) && !showPlayerSheet;
  const miniPlayerVisible = useMiniPlayerAutoHide(bookKey, playerStyle, miniPlayerMounted);

  // "Speak" with no downloaded chapters requests the panel: open the sheet
  // straight on the offline-audio view, where the download button lives.
  useEffect(() => {
    if (panelRequest === 0) return;
    setSheetInitialView('chapters');
    setShowPlayerSheet(true);
  }, [panelRequest]);

  const audiobookSection: AudiobookSectionData | null = audiobook.available
    ? {
        chapters: audiobook.chapters,
        activeIndex: audiobook.activeIndex,
        isChapterLocal: audiobook.isChapterLocal,
        isChapterDownloading: audiobook.isChapterDownloading,
        onPlay: (index) => void audiobook.play(index),
        onDownloadAll: () => void audiobook.downloadAll(),
        onDownloadChapter: (index) => void audiobook.downloadChapter(index),
        downloading: audiobook.downloading,
      }
    : null;

  useEffect(() => {
    if (tts.showBackToCurrentTTSLocation) {
      setShouldMountBackButton(true);
      const fadeInTimeout = setTimeout(() => {
        setIsBackButtonVisible(true);
      }, 10);
      return () => clearTimeout(fadeInTimeout);
    } else {
      setIsBackButtonVisible(false);
      if (backButtonTimeoutRef.current) {
        clearTimeout(backButtonTimeoutRef.current);
      }
      backButtonTimeoutRef.current = setTimeout(() => {
        setShouldMountBackButton(false);
      }, 300);
      return;
    }
  }, [tts.showBackToCurrentTTSLocation]);

  const handleExpand = () => {
    // The mini player mounts as soon as the session starts; the full sheet
    // needs initialized clients (voices, timeline), so ignore taps until then.
    // The audiobook player has no clients to initialize.
    if (!tts.ttsClientsInited && !audiobookActive) return;
    if (!audiobookActive) tts.refreshTtsLang();
    setSheetInitialView(undefined);
    setShowPlayerSheet(true);
  };

  const handleStop = () => {
    if (audiobookActive) {
      audiobook.stop();
      return;
    }
    eventDispatcher.dispatch('tts-stop', { bookKey });
  };

  return (
    <>
      {shouldMountBackButton && (
        <div
          className={clsx(
            'absolute left-1/2 top-0 z-50 -translate-x-1/2',
            'transition-opacity duration-300',
            isBackButtonVisible ? 'opacity-100' : 'opacity-0',
            safeAreaInsets?.top ? '' : 'py-1',
          )}
          style={{
            top: `${safeAreaInsets?.top || 0}px`,
          }}
        >
          <button
            onClick={tts.handleBackToCurrentTTSLocation}
            className={clsx(
              'not-eink:bg-base-300 eink-bordered whitespace-nowrap rounded-full px-4 py-2 font-sans text-sm shadow-lg',
              safeAreaInsets?.top ? 'h-11' : 'h-9',
            )}
          >
            {_('Back to Read Aloud')}
          </button>
        </div>
      )}
      {/* One surface at a time: the sheet replaces the mini player while open.
          Mounts on showIndicator alone so the card appears the moment the
          session starts, before the TTS clients finish initializing. */}
      {miniPlayerMounted && (
        <TTSMiniPlayer
          bookKey={bookKey}
          isPlaying={audiobookActive ? audiobook.isPlaying : tts.isPlaying}
          isEink={isEink}
          visible={miniPlayerVisible}
          hasTimeline={audiobookActive ? true : hasTimeline}
          timeoutTimestamp={audiobookActive ? 0 : tts.timeoutTimestamp}
          chapterRemainingSec={audiobookActive ? null : tts.chapterRemainingSec}
          gridInsets={gridInsets}
          onTogglePlay={audiobookActive ? () => void audiobook.togglePlay() : tts.handleTogglePlay}
          onBackward={audiobookActive ? () => audiobook.backward() : tts.handleBackward}
          onForward={audiobookActive ? () => audiobook.forward() : tts.handleForward}
          onStop={handleStop}
          onExpand={handleExpand}
          onGetPlaybackInfo={
            audiobookActive ? audiobook.getPlaybackInfo : tts.handleGetPlaybackInfo
          }
        />
      )}
      {(tts.ttsClientsInited || audiobookActive || audiobook.available) && showPlayerSheet && (
        <TTSPlayerSheet
          bookKey={bookKey}
          isOpen={showPlayerSheet}
          ttsLang={tts.ttsLang}
          isPlaying={audiobookActive ? audiobook.isPlaying : tts.isPlaying}
          hasTimeline={audiobookActive ? true : hasTimeline}
          timeoutOption={tts.timeoutOption}
          timeoutTimestamp={audiobookActive ? 0 : tts.timeoutTimestamp}
          chapterRemainingSec={audiobookActive ? null : tts.chapterRemainingSec}
          onClose={() => setShowPlayerSheet(false)}
          onTogglePlay={audiobookActive ? () => void audiobook.togglePlay() : tts.handleTogglePlay}
          onBackward={audiobookActive ? () => audiobook.backward() : tts.handleBackward}
          onForward={audiobookActive ? () => audiobook.forward() : tts.handleForward}
          onSetRate={audiobookActive ? audiobook.setRate : tts.handleSetRate}
          onSetSentenceGap={tts.handleSetSentenceGap}
          onSetParagraphGap={tts.handleSetParagraphGap}
          onGetVoices={tts.handleGetVoices}
          onSetVoice={tts.handleSetVoice}
          onGetVoiceId={tts.handleGetVoiceId}
          onSelectTimeout={tts.handleSelectTimeout}
          onSeek={audiobookActive ? audiobook.seekTo : tts.handleSeekTo}
          onSeekPreview={audiobookActive ? () => {} : tts.handleSeekPreview}
          onGetPlaybackInfo={
            audiobookActive ? audiobook.getPlaybackInfo : tts.handleGetPlaybackInfo
          }
          downloads={downloads}
          activeSectionIndex={activeSectionIndex}
          isAudiobook={audiobookActive}
          initialView={sheetInitialView}
          audiobook={audiobookSection}
        />
      )}
    </>
  );
};

export default TTSControl;
