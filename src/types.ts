export const PIPELINE_VERSION = "1.0.0";

export type SubtitleSource = "manual" | "auto";

export interface VideoMeta {
  id: string;
  title: string;
  url: string;
  /** YYYY-MM-DD, best-effort from yt-dlp's upload_date */
  uploadDate: string;
  /** seconds; may be undefined if yt-dlp didn't include it in flat-playlist mode */
  duration?: number;
}

export interface SubtitleTrack {
  videoId: string;
  lang: string;
  source: SubtitleSource;
  vttPath: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface ProcessedTranscript {
  id: string;
  title: string;
  url: string;
  uploadDate: string;
  duration?: number;
  subtitleLang: string;
  subtitleSource: SubtitleSource;
  segments: TranscriptSegment[];
  processedAt: string;
  pipelineVersion: string;
}

export interface ManifestEntry {
  title: string;
  url: string;
  uploadDate: string;
  duration?: number;
  processedPath: string;
  markdownPath: string;
  subtitleLang: string;
  subtitleSource: SubtitleSource;
  downloadedAt: string;
  pipelineVersion: string;
}

export interface SkippedEntry {
  reason: "no-subtitles" | "fetch-failed" | "parse-failed";
  lastTriedAt: string;
  message?: string;
}

export interface Manifest {
  channelUrl: string;
  channelSlug: string;
  lastRun?: string;
  videos: Record<string, ManifestEntry>;
  skipped: Record<string, SkippedEntry>;
}

export interface ChannelConfig {
  slug: string;
  url: string;
  name: string;
}
