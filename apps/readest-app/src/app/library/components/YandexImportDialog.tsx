'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  MdCheck,
  MdClose,
  MdDownload,
  MdPause,
  MdPlayArrow,
  MdRefresh,
  MdSearch,
} from 'react-icons/md';
import { RiBook2Fill, RiHeadphoneFill } from 'react-icons/ri';
import Dialog from '@/components/Dialog';
import SegmentedControl from '@/components/SegmentedControl';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useYandexDownloadsStore, type YandexDownloadJob } from '@/store/yandexDownloadsStore';
import { useYandexServerJobsStore } from '@/store/yandexServerJobsStore';
import { useLibraryStore } from '@/store/libraryStore';
import {
  cancelServerJob,
  dismissServerJob,
  pauseServerJob,
  pollServerJobsOnce,
  resumeServerJob,
} from '@/hooks/useYandexServerJobs';
import { formatBytes } from '@/utils/book';
import { saveSysSettings } from '@/helpers/settings';
import { hydrateYandexToken } from '@/services/yandex/yandexTokenVault';
import { useYandexDownloads, type YandexDownloadTarget } from '@/hooks/useYandexDownloads';
import { setYandexTokenDialogVisible } from './YandexTokenDialog';
import {
  YANDEX_API_BASE,
  fetchAudiobookInfo,
  fetchBookInfo,
  fetchComicbookInfo,
  fetchComicbookMetadata,
  fetchSerialEpisodes,
  fetchSeriesInfo,
  fetchSeriesParts,
  fetchTracks,
  getChapterUrl,
  getTrackDurationSec,
  getYandexAccessToken,
  isSupportedYandexType,
  normalizeYandexTitle,
  parseYandexUrl,
  probeFileSize,
  searchYandexBooks,
} from '@/services/yandex/client';
import {
  yandexDownloadsManager,
  type YandexJobSpec,
} from '@/services/yandex/yandexDownloadsManager';
import {
  computeAudiobookPartState,
  computeEbookPartState,
  loadYandexImportIndex,
  type YandexPartAvailability,
} from '@/services/yandex/yandexImportIndex';
import {
  getAttachedAudiobookChapterPath,
  getAudiobookChapterPath,
  getAudiobookManifestHash,
} from '@/utils/audiobook';
import type {
  YandexAudiobookInfo,
  YandexBookInfo,
  YandexComicbookInfo,
  YandexSerialEpisode,
  YandexSeriesInfo,
  YandexSeriesPart,
  YandexTrack,
} from '@/services/yandex/types';

interface YandexImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SearchInfo {
  uuid: string;
  /** The ebook variant — its own Yandex resource, possibly a linked uuid. */
  book?: { uuid: string; info: YandexBookInfo; bytes: number | null };
  audiobook?: {
    info: YandexAudiobookInfo;
    tracks: YandexTrack[];
    firstChapterBytes: number | null;
  };
  comicbook?: { info: YandexComicbookInfo; zipUrl: string };
  /** A multi-part text book: each episode downloads as its own book. */
  serial?: {
    title: string;
    author: string;
    coverUrl: string;
    episodes: YandexSerialEpisode[];
    /** episode uuid → already present on this device. */
    episodesAvailable: Record<string, boolean>;
  };
  /** A series of independent resources (books / audiobooks / comics). */
  series?: {
    info: YandexSeriesInfo;
    parts: YandexSeriesPart[];
    /** part uuid → already present on this device. */
    partsAvailable: Record<string, boolean>;
    /** resolved ebook-variant uuid → already present on this device. */
    booksAvailable: Record<string, boolean>;
    /** resolved audiobook-variant uuid → already present on this device. */
    audiobooksAvailable: Record<string, boolean>;
  };
}

type YandexPartKey = 'book' | 'audiobook' | 'comicbook' | 'serial' | 'series';
type YandexPartState = YandexPartAvailability | 'downloading' | 'paused' | 'failed';

const formatDuration = (sec: number, _: (key: string) => string): string => {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.round((sec % 3600) / 60);
  if (hours > 0) return `${hours} ${_('h')} ${minutes} ${_('min')}`;
  return `${minutes} ${_('min')}`;
};

// The API is inconsistent: /books/{uuid} returns authors as a plain string,
// /audiobooks/{uuid} as an array of objects.
const getAuthors = (info: { authors?: Array<{ name: string } | string> | string }): string => {
  const authors = info.authors;
  if (typeof authors === 'string') return authors;
  if (!Array.isArray(authors)) return '';
  return authors.map((author) => (typeof author === 'string' ? author : author.name)).join(', ');
};

/**
 * Modal for the import menu's "Yandex URL" entry: paste a books.yandex.ru
 * link, look the book up via the Yandex Books API, and start a download for
 * the ebook and/or audiobook formats the link resolves to. The dialog stays
 * open while jobs run and shows per-part progress with pause/cancel controls.
 */
const YandexImportDialog: React.FC<YandexImportDialogProps> = ({ isOpen, onClose }) => {
  const _ = useTranslation();
  const { appService, envConfig } = useEnv();
  const { startDownload, canDownloadToServer } = useYandexDownloads();
  const { settings } = useSettingsStore();
  const jobs = useYandexDownloadsStore((state) => state.jobs);
  const serverJobs = useYandexServerJobsStore((state) => state.serverJobs);
  const [url, setUrl] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<SearchInfo | null>(null);
  const [partStates, setPartStates] = useState<
    Partial<Record<YandexPartKey, YandexPartAvailability>>
  >({});
  const [targetChoice, setTargetChoice] = useState<YandexDownloadTarget>('server');
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Fall back to local when the server is unreachable — the upload would be
  // skipped anyway, so the control reflects that.
  const downloadTarget: YandexDownloadTarget = canDownloadToServer ? targetChoice : 'local';

  const reset = useCallback(() => {
    setUrl('');
    setSearching(false);
    setError(null);
    setInfo(null);
    setPartStates({});
    setTargetChoice('server');
  }, []);

  // Reset transient state every time the dialog reopens.
  useEffect(() => {
    if (isOpen) reset();
  }, [isOpen, reset]);

  const submit = async () => {
    const target = url.trim();
    setError(null);
    const parsed = parseYandexUrl(target);
    if (!parsed) {
      setError(_('Enter a valid books.yandex.ru or bookmate.ru link'));
      return;
    }
    if (!isSupportedYandexType(parsed.type)) {
      setError(_('Unsupported link type'));
      return;
    }
    const { token, migrated } = await hydrateYandexToken(settings);
    if (migrated) {
      // The legacy plaintext left settings.json — persist the cleaned field.
      void saveSysSettings(envConfig, 'yandexBooks', { accessToken: '' });
    }
    if (!token) {
      setError(_('Set your Yandex Books token first'));
      setYandexTokenDialogVisible(true);
      return;
    }
    setSearching(true);
    setInfo(null);
    setPartStates({});
    try {
      if (parsed.type === 'comicbook' || parsed.type === 'serial' || parsed.type === 'series') {
        const nextInfo: SearchInfo = { uuid: parsed.uuid };
        // Which Yandex resources already have real files on this device: the
        // library rows carry the origin stamp (uuid of the resource that
        // produced the book), and the files must actually exist.
        const stamped = useLibraryStore
          .getState()
          .library.filter((b) => !b.deletedAt && b.metadata?.yandex);
        const availableStamped = appService
          ? (
              await Promise.all(
                stamped.map(async (b) => ((await appService.isBookLocallyAvailable(b)) ? b : null)),
              )
            ).filter((b): b is NonNullable<typeof b> => b !== null)
          : [];
        const stampedUuids = new Set(
          availableStamped.map((b) => b.metadata?.yandex?.uuid).filter((u): u is string => !!u),
        );
        if (parsed.type === 'comicbook') {
          const comicInfo = await fetchComicbookInfo(parsed.uuid, token);
          const metadata = await fetchComicbookMetadata(parsed.uuid, token);
          const zipUrl = metadata.uris?.zip;
          if (!zipUrl) throw new Error('Comicbook archive not found');
          nextInfo.comicbook = { info: comicInfo, zipUrl };
        } else if (parsed.type === 'serial') {
          const [infoResult, episodes] = await Promise.all([
            fetchBookInfo(parsed.uuid, token).catch(() => null),
            fetchSerialEpisodes(parsed.uuid, token),
          ]);
          if (!episodes.length) throw new Error('Serial episodes not found');
          nextInfo.serial = {
            title: infoResult?.title ?? parsed.uuid,
            author: infoResult ? getAuthors(infoResult) : '',
            coverUrl: infoResult?.cover?.large ?? '',
            episodes,
            episodesAvailable: Object.fromEntries(
              episodes.map((episode) => [episode.uuid, stampedUuids.has(episode.uuid)]),
            ),
          };
        } else {
          const [seriesInfo, parts] = await Promise.all([
            fetchSeriesInfo(parsed.uuid, token),
            fetchSeriesParts(parsed.uuid, token),
          ]);
          if (!parts.length) throw new Error('Series parts not found');
          // Audiobook parts usually carry the text version only via the
          // catalogue (linked_book_uuids is empty in the REST payload) — the
          // same fallback the single-link search uses: exact title match.
          const resolvedParts = await Promise.all(
            parts.map(async (part) => {
              const type = seriesPartType(part);
              if (type === 'audiobook') {
                const abInfo = await fetchAudiobookInfo(part.uuid, token).catch(() => null);
                if (!abInfo) return part;
                const linked = abInfo.linked_book_uuids?.[0];
                if (linked) return { ...part, bookUuid: linked };
                const title = normalizeYandexTitle(abInfo.title ?? '');
                if (!title) return part;
                const hits = await searchYandexBooks(abInfo.title, token).catch(() => []);
                const hit = hits.find(
                  (h) => h.type === 'book' && normalizeYandexTitle(h.name) === title,
                );
                return hit ? { ...part, bookUuid: hit.uuid } : part;
              }
              if (type === 'book') {
                const bookInfo = await fetchBookInfo(part.uuid, token).catch(() => null);
                if (!bookInfo) return part;
                const linked = bookInfo.linked_audiobook_uuids?.[0];
                if (linked) return { ...part, audiobookUuid: linked };
                const title = normalizeYandexTitle(bookInfo.title ?? '');
                if (!title) return part;
                const hits = await searchYandexBooks(bookInfo.title, token).catch(() => []);
                const hit = hits.find(
                  (h) => h.type === 'audiobook' && normalizeYandexTitle(h.name) === title,
                );
                return hit ? { ...part, audiobookUuid: hit.uuid } : part;
              }
              return part;
            }),
          );
          nextInfo.series = {
            info: seriesInfo,
            parts: resolvedParts,
            partsAvailable: Object.fromEntries(
              resolvedParts.map((part) => [part.uuid, stampedUuids.has(part.uuid)]),
            ),
            booksAvailable: Object.fromEntries(
              resolvedParts
                .filter((part) => part.bookUuid)
                .map((part) => [part.bookUuid!, stampedUuids.has(part.bookUuid!)]),
            ),
            audiobooksAvailable: Object.fromEntries(
              resolvedParts
                .filter((part) => part.audiobookUuid)
                .map((part) => [part.audiobookUuid!, stampedUuids.has(part.audiobookUuid!)]),
            ),
          };
        }
        setInfo(nextInfo);
        return;
      }
      const [bookResult, audiobookResult] = await Promise.allSettled([
        fetchBookInfo(parsed.uuid, token),
        fetchAudiobookInfo(parsed.uuid, token),
      ]);
      if (bookResult.status === 'rejected' && audiobookResult.status === 'rejected') {
        const reason = bookResult.reason;
        setError(
          reason instanceof Error ? _(reason.message) : _('Could not find this book on Yandex'),
        );
        return;
      }

      const nextInfo: SearchInfo = { uuid: parsed.uuid };
      if (bookResult.status === 'fulfilled') {
        nextInfo.book = {
          uuid: parsed.uuid,
          info: bookResult.value,
          bytes: await probeFileSize(`${YANDEX_API_BASE}/books/${parsed.uuid}/content/v4`, token),
        };
      }
      if (audiobookResult.status === 'fulfilled') {
        const tracks = (await fetchTracks(parsed.uuid, token)).filter((track) =>
          getChapterUrl(track),
        );
        const firstUrl = tracks.length ? getChapterUrl(tracks[0]!)! : '';
        nextInfo.audiobook = {
          info: audiobookResult.value,
          tracks,
          firstChapterBytes: firstUrl ? await probeFileSize(firstUrl, token) : null,
        };
        // The ebook variant is a separate Yandex resource: follow the linked
        // uuid so "Download Book" is offered for audiobook links too.
        const linkedUuid = audiobookResult.value.linked_book_uuids?.[0];
        if (linkedUuid && !nextInfo.book) {
          try {
            const linkedInfo = await fetchBookInfo(linkedUuid, token);
            nextInfo.book = {
              uuid: linkedUuid,
              info: linkedInfo,
              bytes: await probeFileSize(
                `${YANDEX_API_BASE}/books/${linkedUuid}/content/v4`,
                token,
              ),
            };
          } catch {
            // No ebook variant available — leave the book button hidden.
          }
        }
        // The REST API leaves linked_book_uuids empty for many titles (the
        // web's "Читать" button gets its link from the GraphQL relations).
        // Fall back to a catalogue search by title: only an exact match on
        // the normalized name (case, ё/е, whitespace) is accepted.
        if (!nextInfo.book) {
          try {
            const title = normalizeYandexTitle(audiobookResult.value.title);
            const hits = await searchYandexBooks(audiobookResult.value.title, token);
            const hit = hits.find(
              (h) => h.type === 'book' && normalizeYandexTitle(h.name) === title,
            );
            if (hit) {
              const linkedInfo = await fetchBookInfo(hit.uuid, token);
              nextInfo.book = {
                uuid: hit.uuid,
                info: linkedInfo,
                bytes: await probeFileSize(
                  `${YANDEX_API_BASE}/books/${hit.uuid}/content/v4`,
                  token,
                ),
              };
            }
          } catch {
            // Search fallback failed — keep the audiobook-only offer.
          }
        }
      }
      setInfo(nextInfo);
      // Snapshot which parts are already downloaded so repeated searches can
      // disable the finished part instead of offering a re-download. Two
      // signals, OR'd: per-device availability (the local import index), and
      // the synced-library Yandex stamp (covers server-side downloads and
      // downloads made on other devices — the metadata json syncs with the
      // books channel).
      if (appService) {
        const index = await loadYandexImportIndex(appService);
        const yandexBooks = useLibraryStore
          .getState()
          .library.filter((b) => !b.deletedAt && b.metadata?.yandex);
        // Only books whose files actually exist count as downloaded: after a
        // local delete the library row (or the synced metadata) can outlive
        // the files, and the dialog would otherwise report "Downloaded"
        // forever.
        const availableYandexBooks = (
          await Promise.all(
            yandexBooks.map(async (b) => ((await appService.isBookLocallyAvailable(b)) ? b : null)),
          )
        ).filter((b): b is NonNullable<typeof b> => b !== null);
        const states: Partial<Record<YandexPartKey, YandexPartAvailability>> = {};
        if (nextInfo.book) {
          const local = await computeEbookPartState(appService, index, nextInfo.book.uuid);
          const synced = availableYandexBooks.some(
            (b) => b.metadata?.yandex?.uuid === nextInfo.book!.uuid,
          );
          states.book = local === 'downloaded' || synced ? 'downloaded' : 'not-downloaded';
        }
        if (nextInfo.audiobook) {
          const reduced = buildChapters(nextInfo.audiobook.tracks).map(
            ({ title, durationSec }) => ({ title, durationSec }),
          );
          const manifestHash = getAudiobookManifestHash(reduced);
          const local = await computeAudiobookPartState(appService, index, reduced);
          // Attached: the ebook row carries the audiobookHash stamp.
          // Standalone: the audiobook's own row carries the uuid stamp.
          const synced = availableYandexBooks.some(
            (b) =>
              b.metadata?.yandex?.audiobookHash === manifestHash ||
              (b.hash === manifestHash && b.metadata?.yandex?.uuid === nextInfo.uuid),
          );
          states.audiobook = local === 'downloaded' || synced ? 'downloaded' : 'not-downloaded';
        }
        setPartStates(states);
      }
    } catch (e) {
      setError(e instanceof Error ? _(e.message) : _('Could not fetch this book'));
    } finally {
      setSearching(false);
    }
  };

  // The Dialog stops keydown propagation (a shared shortcut guard), so
  // React's onKeyDown never fires for inputs inside it — listen natively.
  useEffect(() => {
    const input = urlInputRef.current;
    if (!input) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Enter') void submit();
    };
    input.addEventListener('keydown', listener);
    return () => input.removeEventListener('keydown', listener);
  }, [submit]);

  /**
   * Chapter list feeding the audiobook manifest hash — shared between the
   * download spec and the availability check so both hash the same input.
   */
  const buildChapters = (tracks: YandexTrack[]) =>
    tracks.map((track, index) => ({
      title: track.title ?? _('Chapter {{number}}', { number: index + 1 }),
      durationSec: getTrackDurationSec(track),
      sizeBytes: 0,
    }));

  const buildEbookSpec = (): YandexJobSpec => ({
    id: info!.book!.uuid,
    resourceType: 'book',
    title: info!.book!.info.title,
    author: getAuthors(info!.book!.info),
    coverUrl: info!.book!.info.cover?.large ?? '',
    files: [
      {
        name: `${info!.book!.uuid}.epub`,
        url: `${YANDEX_API_BASE}/books/${info!.book!.uuid}/content/v4`,
        path: `${info!.book!.uuid}.epub`,
        base: 'Cache',
      },
    ],
  });

  const buildAudiobookSpec = (attachToBookHash?: string): YandexJobSpec => {
    const { tracks } = info!.audiobook!;
    const chapters = buildChapters(tracks);
    const hash = getAudiobookManifestHash(
      chapters.map(({ title, durationSec }) => ({ title, durationSec })),
    );
    const chapterPath = (index: number) =>
      attachToBookHash
        ? getAttachedAudiobookChapterPath(attachToBookHash, index)
        : getAudiobookChapterPath(hash, index);
    return {
      // Distinct ids per variant: the ebook job keeps the plain uuid, and the
      // chained full-download audiobook must not collide with it (or with a
      // standalone audiobook job of the same uuid).
      id: attachToBookHash ? `${info!.uuid}::attached-audiobook` : `${info!.uuid}::audiobook`,
      resourceType: 'audiobook',
      title: info!.audiobook!.info.title,
      author: getAuthors(info!.audiobook!.info),
      coverUrl: info!.audiobook!.info.cover?.large ?? '',
      files: tracks.map((track, index) => ({
        name: `chapter_${String(index + 1).padStart(3, '0')}.m4a`,
        url: getChapterUrl(track)!,
        path: chapterPath(index),
        base: 'Books',
      })),
      audiobook: { hash, chapters, attachToBookHash },
    };
  };

  const startEbookDownload = async () => {
    if (!info?.book) return;
    await startDownload(buildEbookSpec(), { target: downloadTarget });
  };

  const startAudiobookDownload = async () => {
    if (!info?.audiobook) return;
    await startDownload(buildAudiobookSpec(), { target: downloadTarget });
  };

  /**
   * Combined ebook + attached-audiobook spec for the server target: one job
   * row; the server downloads the ebook, computes its hash, then attaches
   * the chapters under it. File paths are derived server-side.
   */
  const buildFullSpec = (): YandexJobSpec => {
    const book = info!.book!;
    const { tracks } = info!.audiobook!;
    const chapters = buildChapters(tracks);
    const hash = getAudiobookManifestHash(
      chapters.map(({ title, durationSec }) => ({ title, durationSec })),
    );
    return {
      id: `${info!.uuid}::full`,
      resourceType: 'book',
      title: book.info.title,
      author: getAuthors(book.info),
      coverUrl: book.info.cover?.large ?? '',
      files: [
        {
          name: `${book.uuid}.epub`,
          url: `${YANDEX_API_BASE}/books/${book.uuid}/content/v4`,
          path: `${book.uuid}.epub`,
          base: 'Cache',
        },
        ...tracks.map((track, index) => ({
          name: `chapter_${String(index + 1).padStart(3, '0')}.m4a`,
          url: getChapterUrl(track)!,
          // Server-side paths are derived from the hash fields.
          path: '',
          base: 'Books' as const,
        })),
      ],
      audiobook: { hash, chapters },
    };
  };

  /**
   * Download the ebook first, then chain the audiobook onto the imported
   * book — both formats end up as a single library entry. The dialog stays
   * open and shows the per-part progress. On the server target a single
   * combined job is submitted instead (the server chains internally).
   */
  const startFullDownload = async () => {
    if (!info?.book || !info?.audiobook) return;
    if (downloadTarget === 'server') {
      await startDownload(buildFullSpec(), { target: 'server' });
      return;
    }
    await startDownload(buildEbookSpec(), {
      target: downloadTarget,
      onBookImported: (book) => {
        void startDownload(buildAudiobookSpec(book.hash), { target: downloadTarget });
      },
    });
  };

  const buildComicbookSpec = (): YandexJobSpec => {
    const { info: comic, zipUrl } = info!.comicbook!;
    return {
      id: `${info!.uuid}::comicbook`,
      resourceType: 'comicbook',
      title: comic.title,
      author: getAuthors(comic),
      coverUrl: comic.cover?.large ?? '',
      files: [{ name: `${info!.uuid}.cbz`, url: zipUrl, path: `${info!.uuid}.cbz`, base: 'Cache' }],
    };
  };

  const startComicbookDownload = async () => {
    if (!info?.comicbook) return;
    await startDownload(buildComicbookSpec(), { target: downloadTarget });
  };

  /** A serial downloads as one book job per episode (each is its own uuid). */
  const startSerialDownload = async () => {
    if (!info?.serial) return;
    const serial = info.serial;
    await runBatchDownloads(
      serial.episodes.map((episode, index) => ({
        id: episode.uuid,
        run: async () => {
          await startDownload(
            {
              id: episode.uuid,
              resourceType: 'book',
              title: episode.title ?? `${serial.title} — ${index + 1}`,
              author: serial.author,
              coverUrl: serial.coverUrl,
              files: [
                {
                  name: `${episode.uuid}.epub`,
                  url: `${YANDEX_API_BASE}/books/${episode.uuid}/content/v4`,
                  path: `${episode.uuid}.epub`,
                  base: 'Cache',
                },
              ],
            },
            { target: downloadTarget },
          );
        },
      })),
    );
  };

  const seriesPartType = (part: YandexSeriesPart): 'book' | 'audiobook' | 'comicbook' => {
    // The REST parts list is inconsistent: books carry type 'Book', audiobook
    // parts carry no type at all but have can_be_listened set (a book-only
    // download on an audiobook uuid 404s).
    const type = part.type?.toLowerCase();
    if (type === 'comicbook' || type === 'comic') return 'comicbook';
    if (type === 'audiobook' || type === 'audio' || (part.can_be_listened && !part.can_be_read)) {
      return 'audiobook';
    }
    return 'book';
  };

  /** Lazily resolve one series part (the REST parts list carries no URLs). */
  const startSeriesPartDownload = async (part: YandexSeriesPart) => {
    if (!info?.series) return;
    const token = getYandexAccessToken(settings);
    const type = seriesPartType(part);
    const title = part.title ?? info.series.info.title;
    const cover = part.cover?.large ?? info.series.info.cover?.large ?? '';
    try {
      if (type === 'book') {
        await startDownload(
          {
            id: part.uuid,
            resourceType: 'book',
            title,
            author: '',
            coverUrl: cover,
            files: [
              {
                name: `${part.uuid}.epub`,
                url: `${YANDEX_API_BASE}/books/${part.uuid}/content/v4`,
                path: `${part.uuid}.epub`,
                base: 'Cache',
              },
            ],
          },
          { target: downloadTarget },
        );
        return;
      }
      if (type === 'comicbook') {
        const metadata = await fetchComicbookMetadata(part.uuid, token);
        const zipUrl = metadata.uris?.zip;
        if (!zipUrl) return;
        await startDownload(
          {
            id: part.uuid,
            resourceType: 'comicbook',
            title,
            author: '',
            coverUrl: cover,
            files: [
              { name: `${part.uuid}.cbz`, url: zipUrl, path: `${part.uuid}.cbz`, base: 'Cache' },
            ],
          },
          { target: downloadTarget },
        );
        return;
      }
      await startSeriesAudiobookDownload(part.uuid, cover);
    } catch (e) {
      setError(e instanceof Error ? _(e.message) : _('Could not fetch this book'));
    }
  };

  /** Resolve an audiobook by uuid and start the standalone audiobook job. */
  const startSeriesAudiobookDownload = async (uuid: string, fallbackCover: string) => {
    const token = getYandexAccessToken(settings);
    const abInfo = await fetchAudiobookInfo(uuid, token);
    const tracks = (await fetchTracks(uuid, token)).filter((track) => getChapterUrl(track));
    const chapters = buildChapters(tracks);
    const hash = getAudiobookManifestHash(
      chapters.map(({ title: t, durationSec }) => ({ title: t, durationSec })),
    );
    await startDownload(
      {
        id: `${uuid}::audiobook`,
        resourceType: 'audiobook',
        title: abInfo.title,
        author: getAuthors(abInfo),
        coverUrl: abInfo.cover?.large ?? fallbackCover,
        files: tracks.map((track, index) => ({
          name: `chapter_${String(index + 1).padStart(3, '0')}.m4a`,
          url: getChapterUrl(track)!,
          path: getAudiobookChapterPath(hash, index),
          base: 'Books',
        })),
        audiobook: { hash, chapters },
      },
      { target: downloadTarget },
    );
  };

  /**
   * The server caps concurrent Yandex jobs per user (2), so a batch of
   * series/serial parts must be submitted one at a time and each one
   * awaited. Locally the manager runs jobs in parallel and needs no
   * sequencing.
   */
  const waitForServerJob = async (id: string): Promise<void> => {
    for (;;) {
      await pollServerJobsOnce();
      const job = useYandexServerJobsStore
        .getState()
        .serverJobs.find((candidate) => candidate.id === id);
      if (job?.status === 'completed') return;
      if (job?.status === 'failed') {
        throw new Error(job.error ?? _('Could not download on the server'));
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };

  const runBatchDownloads = async (
    actions: Array<{ id: string; run: () => Promise<void> }>,
  ): Promise<void> => {
    for (const action of actions) {
      await action.run();
      if (downloadTarget === 'server') await waitForServerJob(action.id);
    }
  };

  /** Download the resolved audiobook variant of a book series part. */
  const startSeriesAudiobookVariantDownload = async (part: YandexSeriesPart) => {
    if (!info?.series || !part.audiobookUuid) return;
    const cover = part.cover?.large ?? info.series.info.cover?.large ?? '';
    try {
      await startSeriesAudiobookDownload(part.audiobookUuid, cover);
    } catch (e) {
      setError(e instanceof Error ? _(e.message) : _('Could not fetch this book'));
    }
  };

  /** Download the resolved ebook variant of an audiobook series part. */
  const startSeriesBookVariantDownload = async (part: YandexSeriesPart) => {
    if (!info?.series || !part.bookUuid) return;
    const token = getYandexAccessToken(settings);
    try {
      const bookInfo = await fetchBookInfo(part.bookUuid, token);
      await startDownload(
        {
          id: part.bookUuid,
          resourceType: 'book',
          title: bookInfo.title,
          author: getAuthors(bookInfo),
          coverUrl: bookInfo.cover?.large ?? part.cover?.large ?? '',
          files: [
            {
              name: `${part.bookUuid}.epub`,
              url: `${YANDEX_API_BASE}/books/${part.bookUuid}/content/v4`,
              path: `${part.bookUuid}.epub`,
              base: 'Cache',
            },
          ],
        },
        { target: downloadTarget },
      );
    } catch (e) {
      setError(e instanceof Error ? _(e.message) : _('Could not fetch this book'));
    }
  };

  const seriesTypeLabel = (type: 'book' | 'audiobook' | 'comicbook') =>
    type === 'audiobook' ? _('Audiobook') : type === 'comicbook' ? _('Comicbook') : _('Book');
  const seriesTypeIcon = (type: 'book' | 'audiobook' | 'comicbook') =>
    type === 'audiobook' ? (
      <RiHeadphoneFill className='h-4 w-4' />
    ) : (
      <RiBook2Fill className='h-4 w-4' />
    );

  // A per-id job row lookup for the extra part types (comic / serial / series
  // parts), which are not covered by the book/audiobook availability snapshot.
  const extraJob = (id: string): YandexDownloadJob | undefined =>
    [...jobs, ...serverJobs].find((job) => job.id === id);

  const extraPartCell = (
    id: string,
    label: string,
    icon: React.ReactNode,
    onDownload: () => void,
    downloaded = false,
  ) => {
    const job = extraJob(id);
    if (downloaded || job?.status === 'completed') {
      return (
        <button type='button' className='btn btn-contrast btn-sm' disabled>
          <MdCheck className='h-4 w-4' />
          {icon}
          {label}
        </button>
      );
    }
    if (job && (job.status === 'downloading' || job.status === 'paused')) {
      return (
        <div className='col-span-2 flex items-center gap-2 rounded-lg border border-base-200 p-2 eink-bordered'>
          <div className='bg-base-300 h-1.5 flex-1 overflow-hidden rounded-full'>
            <div
              className='bg-primary h-full transition-all'
              style={{
                width: `${
                  job.totalBytes ? Math.min(100, (job.downloadedBytes / job.totalBytes) * 100) : 0
                }%`,
              }}
            />
          </div>
          <span className='text-base-content/60 shrink-0 text-xs'>
            {job.totalBytes
              ? `${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`
              : formatBytes(job.downloadedBytes)}
          </span>
          {job.status === 'downloading' && (
            <button
              type='button'
              className='btn btn-ghost btn-sm btn-circle'
              aria-label={_('Pause')}
              onClick={() => jobPause(job)}
            >
              <MdPause className='h-4 w-4' />
            </button>
          )}
          {job.status === 'paused' && (
            <button
              type='button'
              className='btn btn-ghost btn-sm btn-circle'
              aria-label={_('Resume')}
              onClick={() => jobResume(job)}
            >
              <MdPlayArrow className='h-4 w-4' />
            </button>
          )}
          <button
            type='button'
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Cancel')}
            onClick={() => jobCancel(job)}
          >
            <MdClose className='h-4 w-4' />
          </button>
        </div>
      );
    }
    if (job?.status === 'failed') {
      return (
        <div className='col-span-2 flex items-center gap-2 rounded-lg border border-base-200 p-2 eink-bordered'>
          <span className='text-error flex-1 truncate text-sm'>{job.error ?? _('Failed')}</span>
          <button
            type='button'
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Retry')}
            onClick={() => jobResume(job)}
          >
            <MdRefresh className='h-4 w-4' />
          </button>
          <button
            type='button'
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Cancel')}
            onClick={() => jobDismiss(job)}
          >
            <MdClose className='h-4 w-4' />
          </button>
        </div>
      );
    }
    return (
      <button type='button' className='btn btn-contrast btn-sm' onClick={onDownload}>
        <MdDownload className='h-4 w-4' />
        {icon}
        {label}
      </button>
    );
  };

  // A part's live state: an active/kept job row (local session or server)
  // overrides the availability snapshot taken at search time.
  const findPartJob = (part: YandexPartKey): YandexDownloadJob | undefined => {
    if (!info) return undefined;
    const ids =
      part === 'book'
        ? [info.book?.uuid, `${info.uuid}::full`]
        : [`${info.uuid}::audiobook`, `${info.uuid}::attached-audiobook`, `${info.uuid}::full`];
    return (
      jobs.find((job) => ids.includes(job.id)) ?? serverJobs.find((job) => ids.includes(job.id))
    );
  };

  /** Whether the job row belongs to the server (controls route by API). */
  const isServerJob = (id: string): boolean => !jobs.some((job) => job.id === id);

  const jobPause = (job: YandexDownloadJob) => {
    if (isServerJob(job.id)) void pauseServerJob(job.id);
    else yandexDownloadsManager.pauseJob(job.id);
  };
  const jobResume = (job: YandexDownloadJob) => {
    if (isServerJob(job.id)) void resumeServerJob(job.id);
    else yandexDownloadsManager.resumeJob(job.id);
  };
  const jobCancel = (job: YandexDownloadJob) => {
    if (isServerJob(job.id)) void cancelServerJob(job.id);
    else void yandexDownloadsManager.cancelJob(job.id);
  };
  const jobDismiss = (job: YandexDownloadJob) => {
    if (isServerJob(job.id)) void dismissServerJob(job.id);
    else useYandexDownloadsStore.getState().removeJob(job.id);
  };

  const partState = (part: YandexPartKey): YandexPartState => {
    const job = findPartJob(part);
    if (job) return job.status === 'completed' ? 'downloaded' : job.status;
    return partStates[part] ?? 'not-downloaded';
  };

  const bookState = partState('book');
  const audioState = partState('audiobook');
  const hasActivePart =
    bookState === 'downloading' ||
    bookState === 'paused' ||
    audioState === 'downloading' ||
    audioState === 'paused';
  const hasExtraParts = !!(info?.comicbook || info?.serial || info?.series);
  const anyPartNotDownloaded =
    bookState === 'not-downloaded' || audioState === 'not-downloaded' || hasExtraParts;
  const showDownloadFully =
    !!info?.book &&
    !!info?.audiobook &&
    bookState === 'not-downloaded' &&
    audioState === 'not-downloaded';
  // When every offered part is already on this device there is nothing left
  // to download — hide the part buttons entirely.
  const offeredPartsDownloaded =
    (!info?.book || bookState === 'downloaded') &&
    (!info?.audiobook || audioState === 'downloaded') &&
    !hasExtraParts;

  const partCell = (
    part: YandexPartKey,
    label: string,
    icon: React.ReactNode,
    onDownload: () => void,
  ) => {
    const state = partState(part);
    const job = findPartJob(part);
    // A combined full download covers both parts; the book cell renders the
    // single (full-width) progress row, so the audiobook cell stays empty —
    // otherwise the same job appears twice.
    if (part === 'audiobook' && info && job?.id === `${info.uuid}::full`) return null;
    if (state === 'downloaded') {
      return (
        <button type='button' className='btn btn-contrast btn-sm' disabled>
          <MdCheck className='h-4 w-4' />
          {icon}
          {_('Downloaded')}
        </button>
      );
    }
    if ((state === 'downloading' || state === 'paused') && job) {
      return (
        <div className='col-span-2 flex items-center gap-2 rounded-lg border border-base-200 p-2 eink-bordered'>
          <div className='bg-base-300 h-1.5 flex-1 overflow-hidden rounded-full'>
            <div
              className='bg-primary h-full transition-all'
              style={{
                width: `${
                  job.totalBytes ? Math.min(100, (job.downloadedBytes / job.totalBytes) * 100) : 0
                }%`,
              }}
            />
          </div>
          <span className='text-base-content/60 shrink-0 text-xs'>
            {job.totalBytes
              ? `${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`
              : formatBytes(job.downloadedBytes)}
          </span>
          {job.status === 'downloading' && (
            <button
              type='button'
              className='btn btn-ghost btn-sm btn-circle'
              aria-label={_('Pause')}
              onClick={() => jobPause(job)}
            >
              <MdPause className='h-4 w-4' />
            </button>
          )}
          {job.status === 'paused' && (
            <button
              type='button'
              className='btn btn-ghost btn-sm btn-circle'
              aria-label={_('Resume')}
              onClick={() => jobResume(job)}
            >
              <MdPlayArrow className='h-4 w-4' />
            </button>
          )}
          <button
            type='button'
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Cancel')}
            onClick={() => jobCancel(job)}
          >
            <MdClose className='h-4 w-4' />
          </button>
        </div>
      );
    }
    if (state === 'failed' && job) {
      return (
        <div className='col-span-2 flex items-center gap-2 rounded-lg border border-base-200 p-2 eink-bordered'>
          <span className='text-error flex-1 truncate text-sm'>{job.error ?? _('Failed')}</span>
          <button
            type='button'
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Retry')}
            onClick={() => jobResume(job)}
          >
            <MdRefresh className='h-4 w-4' />
          </button>
          <button
            type='button'
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Dismiss')}
            onClick={() => jobDismiss(job)}
          >
            <MdClose className='h-4 w-4' />
          </button>
        </div>
      );
    }
    return (
      <button
        type='button'
        className='btn btn-contrast btn-sm'
        onClick={onDownload}
        disabled={hasActivePart}
      >
        <MdDownload className='h-4 w-4' />
        {icon}
        {label}
      </button>
    );
  };

  const coverUrl =
    info?.book?.info.cover?.large ??
    info?.audiobook?.info.cover?.large ??
    info?.comicbook?.info.cover?.large ??
    info?.serial?.coverUrl ??
    info?.series?.info.cover?.large ??
    '';
  const title =
    info?.book?.info.title ??
    info?.audiobook?.info.title ??
    info?.comicbook?.info.title ??
    info?.serial?.title ??
    info?.series?.info.title ??
    '';
  const author = info
    ? getAuthors(info.book?.info ?? info.audiobook?.info ?? info.comicbook?.info ?? {})
    : '';

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={_('Yandex URL')}
      boxClassName='sm:!w-[480px] sm:!max-w-[480px] sm:!h-auto sm:!max-h-[85vh]'
    >
      <div className='flex flex-col gap-4 px-6 pb-6 pt-2'>
        <p className='text-base-content/60 text-sm leading-relaxed'>
          {_('Paste a books.yandex.ru or bookmate.ru link')}
        </p>
        <div className='relative'>
          <input
            ref={urlInputRef}
            type='url'
            autoFocus
            className='input input-bordered eink-bordered placeholder:text-base-content/35 w-full pe-10'
            placeholder='https://books.yandex.ru/audiobooks/…'
            value={url}
            disabled={searching}
            onChange={(e) => setUrl(e.target.value)}
          />
          {info && (
            <button
              type='button'
              aria-label={_('Clear search')}
              className='btn btn-ghost btn-xs btn-circle absolute right-1.5 top-1/2 -translate-y-1/2'
              onClick={() => {
                reset();
                urlInputRef.current?.focus();
              }}
            >
              <MdClose className='h-4 w-4' />
            </button>
          )}
        </div>
        {error && <p className='text-error text-sm leading-relaxed'>{error}</p>}

        {info && (
          <div className='flex gap-4 rounded-lg border border-base-200 p-3'>
            {coverUrl && (
              <img
                src={coverUrl}
                alt=''
                className='h-28 w-20 shrink-0 rounded object-cover shadow'
              />
            )}
            <div className='flex min-w-0 flex-col gap-1'>
              <p className='truncate font-medium'>{title}</p>
              {author && <p className='text-base-content/70 truncate text-sm'>{author}</p>}
              {info.book && (
                <p className='text-base-content/70 text-sm'>
                  {_('Ebook: {{size}}', {
                    size: info.book.bytes ? formatBytes(info.book.bytes) : _('size unknown'),
                  })}
                </p>
              )}
              {info.comicbook && <p className='text-base-content/70 text-sm'>{_('Comicbook')}</p>}
              {info.serial && (
                <p className='text-base-content/70 text-sm'>
                  {_('Serial: {{count}} parts', { count: info.serial.episodes.length })}
                </p>
              )}
              {info.series && (
                <p className='text-base-content/70 text-sm'>
                  {_('Series: {{count}} parts', { count: info.series.parts.length })}
                </p>
              )}
              {info.audiobook && (
                <p className='text-base-content/70 text-sm'>
                  {_('Audiobook: {{duration}} · {{count}} chapters', {
                    duration: info.audiobook.info.duration
                      ? formatDuration(info.audiobook.info.duration, _)
                      : '—',
                    count: info.audiobook.tracks.length,
                  })}
                  {info.audiobook.firstChapterBytes
                    ? ` · ${_('≈{{size}} per chapter', {
                        size: formatBytes(info.audiobook.firstChapterBytes),
                      })}`
                    : ''}
                </p>
              )}
            </div>
          </div>
        )}

        <div className='flex flex-col gap-2 pt-1'>
          {!info && (
            <div className='flex justify-end gap-2'>
              <button
                type='button'
                className='btn btn-ghost btn-sm eink-bordered'
                onClick={onClose}
                disabled={searching}
              >
                {_('Cancel')}
              </button>
              <button
                type='button'
                className='btn btn-contrast btn-sm'
                onClick={() => void submit()}
                disabled={searching || !url.trim()}
              >
                {searching ? (
                  <span className='loading loading-spinner loading-xs' />
                ) : (
                  <MdSearch className='h-4 w-4' />
                )}
                {_('Search')}
              </button>
            </div>
          )}
          {info && (
            <>
              {anyPartNotDownloaded && (
                <div className='flex flex-col gap-1.5'>
                  <p className='text-base-content/60 text-sm'>{_('Where to download the book')}</p>
                  <SegmentedControl<YandexDownloadTarget>
                    options={[
                      { value: 'local', label: _('Locally') },
                      {
                        value: 'server',
                        label: _('To server'),
                        disabled: !canDownloadToServer,
                      },
                    ]}
                    value={downloadTarget}
                    onChange={setTargetChoice}
                    disabled={hasActivePart}
                    fullWidth
                    ariaLabel={_('Where to download the book')}
                  />
                </div>
              )}
              {!offeredPartsDownloaded && (
                <div className='grid grid-cols-2 gap-2'>
                  {info.book &&
                    partCell(
                      'book',
                      _('Book'),
                      <RiBook2Fill className='h-4 w-4' />,
                      () => void startEbookDownload(),
                    )}
                  {info.audiobook &&
                    partCell(
                      'audiobook',
                      _('Audiobook'),
                      <RiHeadphoneFill className='h-4 w-4' />,
                      () => void startAudiobookDownload(),
                    )}
                  {info.comicbook &&
                    extraPartCell(
                      `${info.uuid}::comicbook`,
                      _('Comicbook'),
                      <RiBook2Fill className='h-4 w-4' />,
                      () => void startComicbookDownload(),
                    )}
                  {info.serial &&
                    extraPartCell(
                      `${info.uuid}::serial`,
                      `${_('Book')} · ${info.serial.episodes.length}`,
                      <RiBook2Fill className='h-4 w-4' />,
                      () => void startSerialDownload(),
                      info.serial.episodes.every(
                        (episode) => info.serial?.episodesAvailable[episode.uuid],
                      ),
                    )}
                </div>
              )}
              {info.series && (
                <div className='flex flex-col gap-2'>
                  <div className='flex max-h-80 flex-col gap-2 overflow-y-auto pr-1'>
                    {info.series.parts.map((part) => {
                      const type = seriesPartType(part);
                      return (
                        <div
                          key={part.uuid}
                          className='flex items-center gap-3 rounded-lg border border-base-200 p-2 eink-bordered'
                        >
                          {part.cover?.large && (
                            <img
                              src={part.cover.large}
                              alt=''
                              className='h-16 w-11 shrink-0 rounded object-cover shadow'
                            />
                          )}
                          <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
                            <p className='truncate text-sm font-medium'>
                              {part.title ?? info.series!.info.title}
                            </p>
                            <p className='text-base-content/60 truncate text-xs'>
                              {seriesTypeLabel(type)}
                            </p>
                          </div>
                          <div className='flex shrink-0 items-center gap-1'>
                            {type === 'book' && part.audiobookUuid && (
                              <div className='flex flex-col items-stretch gap-1'>
                                {extraPartCell(
                                  part.uuid,
                                  seriesTypeLabel(type),
                                  seriesTypeIcon(type),
                                  () => void startSeriesPartDownload(part),
                                  info.series!.partsAvailable[part.uuid],
                                )}
                                {extraPartCell(
                                  `${part.audiobookUuid}::audiobook`,
                                  _('Audiobook'),
                                  <RiHeadphoneFill className='h-4 w-4' />,
                                  () => void startSeriesAudiobookVariantDownload(part),
                                  info.series!.audiobooksAvailable[part.audiobookUuid],
                                )}
                              </div>
                            )}
                            {type === 'audiobook' && part.bookUuid && (
                              <div className='flex flex-col items-stretch gap-1'>
                                {extraPartCell(
                                  part.bookUuid,
                                  _('Book'),
                                  <RiBook2Fill className='h-4 w-4' />,
                                  () => void startSeriesBookVariantDownload(part),
                                  info.series!.booksAvailable[part.bookUuid],
                                )}
                                {extraPartCell(
                                  `${part.uuid}::audiobook`,
                                  seriesTypeLabel(type),
                                  seriesTypeIcon(type),
                                  () => void startSeriesPartDownload(part),
                                  info.series!.partsAvailable[part.uuid],
                                )}
                              </div>
                            )}
                            {!(
                              (type === 'audiobook' && part.bookUuid) ||
                              (type === 'book' && part.audiobookUuid)
                            ) &&
                              extraPartCell(
                                part.uuid,
                                seriesTypeLabel(type),
                                seriesTypeIcon(type),
                                () => void startSeriesPartDownload(part),
                                info.series!.partsAvailable[part.uuid],
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {(() => {
                    const bookParts = info.series.parts.filter(
                      (part) => seriesPartType(part) === 'book',
                    );
                    const bookVariants = info.series.parts.filter(
                      (part) => seriesPartType(part) === 'audiobook' && part.bookUuid,
                    );
                    const bookCount = bookParts.length + bookVariants.length;
                    const audioParts = info.series.parts.filter(
                      (part) => seriesPartType(part) === 'audiobook',
                    );
                    const available = (parts: YandexSeriesPart[]) =>
                      parts.every((part) => info.series!.partsAvailable[part.uuid]);
                    const booksDone =
                      available(bookParts) &&
                      bookVariants.every((part) => info.series!.booksAvailable[part.bookUuid!]);
                    const audioVariants = info.series.parts.filter(
                      (part) => seriesPartType(part) === 'book' && part.audiobookUuid,
                    );
                    const audioCount = audioParts.length + audioVariants.length;
                    const audioDone =
                      available(audioParts) &&
                      audioVariants.every(
                        (part) => info.series!.audiobooksAvailable[part.audiobookUuid!],
                      );
                    const everythingDone = booksDone && audioDone && available(info.series.parts);
                    return (
                      <>
                        {bookCount > 0 && !booksDone && (
                          <button
                            type='button'
                            className='btn btn-contrast btn-sm'
                            onClick={() => {
                              void runBatchDownloads([
                                ...bookParts.map((part) => ({
                                  id: part.uuid,
                                  run: () => startSeriesPartDownload(part),
                                })),
                                ...bookVariants.map((part) => ({
                                  id: part.bookUuid!,
                                  run: () => startSeriesBookVariantDownload(part),
                                })),
                              ]);
                            }}
                          >
                            <MdDownload className='h-4 w-4' />
                            <RiBook2Fill className='h-4 w-4' />
                            {`${_('Book')} · ${bookCount}`}
                          </button>
                        )}
                        {audioCount > 0 && !audioDone && (
                          <button
                            type='button'
                            className='btn btn-contrast btn-sm'
                            onClick={() => {
                              void runBatchDownloads([
                                ...audioParts.map((part) => ({
                                  id: `${part.uuid}::audiobook`,
                                  run: () => startSeriesPartDownload(part),
                                })),
                                ...audioVariants.map((part) => ({
                                  id: `${part.audiobookUuid}::audiobook`,
                                  run: () => startSeriesAudiobookVariantDownload(part),
                                })),
                              ]);
                            }}
                          >
                            <MdDownload className='h-4 w-4' />
                            <RiHeadphoneFill className='h-4 w-4' />
                            {`${_('Audiobook')} · ${audioCount}`}
                          </button>
                        )}
                        {!everythingDone && (
                          <button
                            type='button'
                            className='btn btn-primary btn-sm w-full'
                            onClick={() => {
                              const all = info.series!.parts;
                              void runBatchDownloads([
                                ...all
                                  .filter(
                                    (part) =>
                                      seriesPartType(part) !== 'audiobook' || !part.bookUuid,
                                  )
                                  .map((part) => ({
                                    id:
                                      seriesPartType(part) === 'audiobook'
                                        ? `${part.uuid}::audiobook`
                                        : part.uuid,
                                    run: () => startSeriesPartDownload(part),
                                  })),
                                ...all
                                  .filter((part) => part.bookUuid)
                                  .map((part) => ({
                                    id: part.bookUuid!,
                                    run: () => startSeriesBookVariantDownload(part),
                                  })),
                                ...all
                                  .filter((part) => part.audiobookUuid)
                                  .map((part) => ({
                                    id: `${part.audiobookUuid}::audiobook`,
                                    run: () => startSeriesAudiobookVariantDownload(part),
                                  })),
                              ]);
                            }}
                          >
                            <MdDownload className='h-4 w-4' />
                            {_('Download Fully')}
                          </button>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}
              {showDownloadFully && (
                <button
                  type='button'
                  className='btn btn-primary btn-sm w-full'
                  onClick={() => void startFullDownload()}
                  disabled={hasActivePart}
                >
                  <MdDownload className='h-4 w-4' />
                  {_('Download Fully')}
                </button>
              )}
              <button
                type='button'
                className='btn btn-ghost btn-sm eink-bordered w-full'
                onClick={onClose}
                disabled={hasActivePart}
              >
                {_('Cancel')}
              </button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
};

export default YandexImportDialog;
