export interface AudiobookChapter {
  /** File name inside the book directory, e.g. `chapter_001.m4a`. */
  file: string;
  title: string;
  durationSec: number;
  sizeBytes: number;
}

export interface AudiobookManifest {
  schemaVersion: 1;
  title: string;
  author: string;
  totalDurationSec: number;
  chapters: AudiobookChapter[];
}

export interface AudiobookPosition {
  chapterIndex: number;
  positionSec: number;
  /**
   * The moment this position was actually saved by a listener (persist
   * time). Drives last-writer-wins across devices so sync order and
   * unrelated config writes can't regress a fresher playback position.
   */
  updatedAt?: number;
}
