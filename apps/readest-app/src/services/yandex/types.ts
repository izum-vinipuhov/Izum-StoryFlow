export interface YandexPerson {
  name: string;
}

export interface YandexCover {
  large?: string;
  small?: string;
}

export interface YandexBookInfo {
  title: string;
  cover?: YandexCover;
  /** A plain string on /books/{uuid}, unlike the audiobook's array shape. */
  authors?: Array<YandexPerson | string> | string;
  /** Audiobook variants of the same title (the web's «Слушать» button). */
  linked_audiobook_uuids?: string[];
}

export interface YandexAudiobookInfo {
  title: string;
  cover?: YandexCover;
  /** Total duration in seconds. */
  duration?: number;
  authors?: YandexPerson[];
  narrators?: YandexPerson[];
  /** Uuids of the linked ebook variant(s) — a separate Yandex resource. */
  linked_book_uuids?: string[];
}

export interface YandexTrack {
  /** Chapter number (the API numbers tracks from 1). */
  number: number;
  title?: string;
  /** Chapter duration — an object like `{seconds, offset, preview}`. */
  duration?: number | { seconds?: number; offset?: number; preview?: number };
  offline?: {
    min_bit_rate?: { url: string };
    max_bit_rate?: { url: string };
  };
}

export interface YandexTracksResponse {
  tracks?: YandexTrack[];
}

export interface YandexComicbookInfo {
  title: string;
  cover?: YandexCover;
  authors?: YandexPerson[];
}

export interface YandexComicbookMetadata {
  /** Whole-comic zip archive — saved as a .cbz and imported directly. */
  uris?: { zip?: string };
}

export interface YandexSerialEpisode {
  uuid: string;
  title?: string;
}

export interface YandexSeriesInfo {
  title: string;
  cover?: YandexCover;
  authors?: YandexPerson[];
}

export interface YandexSeriesPart {
  uuid: string;
  title?: string;
  /** 'Book' for books; audiobook parts have no type but can_be_listened. */
  type?: string;
  cover?: YandexCover;
  can_be_listened?: boolean;
  can_be_read?: boolean;
  /** Position within the series (from the REST parts wrapper). */
  position?: number;
  /** Resolved ebook variant of an audiobook part (linked uuid or a catalogue
   * search match by title) — set by the dialog at search time. */
  bookUuid?: string;
  /** Resolved audiobook variant of a book part (linked_audiobook_uuids or a
   * catalogue search match by title) — set by the dialog at search time. */
  audiobookUuid?: string;
}
