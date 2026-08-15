/**
 * A translation job: one chapter, one target language, one endpoint.
 *
 * Jobs are persisted per chunk, so closing the tab mid-run costs at most the chunk
 * in flight. `bookFile + chapter + lang` is also the identity of the artifact users
 * exchange, which keeps "what have I already paid for" answerable across machines.
 */
import type { Lang } from "../scenario/model";

export type ChunkStatus = "pending" | "done" | "failed";

export interface JobChunk {
  index: number;
  /** Unit ids this chunk covers, so progress survives re-chunking. */
  uids: string[];
  status: ChunkStatus;
  attempts: number;
  error?: string;
  /** Units the model never returned, even after repair. */
  missing?: string[];
}

export interface JobUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export interface Job {
  id: string;
  bookFile: string;
  srcHash: string;
  chapter: string;
  lang: Lang;
  presetId: string;
  model: string;
  chunks: JobChunk[];
  usage: JobUsage;
  createdAt: number;
  updatedAt: number;
  /** Non-fatal problems worth showing after the run. */
  warnings?: string[];
}

export function jobId(bookFile: string, chapter: string, lang: Lang): string {
  return `${bookFile}::${chapter}::${lang}`;
}

export function jobProgress(job: Job): { done: number; total: number; failed: number } {
  return {
    done: job.chunks.filter((c) => c.status === "done").length,
    total: job.chunks.length,
    failed: job.chunks.filter((c) => c.status === "failed").length,
  };
}

export function isComplete(job: Job): boolean {
  return job.chunks.length > 0 && job.chunks.every((c) => c.status === "done");
}
