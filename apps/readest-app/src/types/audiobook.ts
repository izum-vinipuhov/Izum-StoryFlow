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
