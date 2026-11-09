// Types for the catalog pipeline's plain-JS helpers (used by the tests).
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PipelineEdition {
  key: string;
  source: 'gutenberg' | 'standard-ebooks';
  title: string;
  authors: string[];
  authorKeys: string[];
  translators: string[];
  subjects: string[];
  genres: string[];
  language: string;
  description: string;
  issued: string;
  downloads: number;
  cover?: string;
  pageUrl: string;
  epubUrl: string;
  gutenbergIds: number[];
  wordCount?: number;
}
export const SNAPSHOT_VERSION: number;
export const GENRE_PATTERNS: Record<string, RegExp>;
export function decodeEntities(s: string): string;
export function clean(s: string | undefined): string;
export function stripHtml(s: string | undefined): string;
export function titleKey(t: string): string;
export function mainTitleKey(t: string): string;
export function authorKey(n: string): string;
export function displayName(n: string): string;
export function lang2(c: string | undefined): string;
export function genresOf(labels: string[]): string[];
export function readTar(stream: AsyncIterable<Buffer>, onFile: (name: string, body: Buffer) => void | Promise<void>): Promise<void>;
export function parseGutenbergRdf(xml: string): any;
export function isReadableGutenberg(rec: any): { ok: boolean; reason?: string };
export function gutenbergEdition(rec: any): PipelineEdition;
export function seSlugFromHomepage(h: string | null | undefined): string | null;
export function parseStandardEbooksOpf(xml: string, slug: string): PipelineEdition;
export function editionMatchKey(e: PipelineEdition): string | null;
export function groupEditions(editions: PipelineEdition[], providerWorkOf?: (e: PipelineEdition) => string | null): PipelineEdition[][];
export function titleSimilarity(a: string, b: string): number;
export function authorsAgree(keys: string[], names: string[] | undefined): boolean | null;
export function judgeIdentifierMatch(e: PipelineEdition, doc: any): { ok: boolean; confidence?: number; method?: string; reason?: string };
export function judgeSearchMatch(e: PipelineEdition, docs: any[]): { ok: boolean; doc?: any; confidence?: number; method?: string; reason?: string };
export function weightedRating(value: number | null, count: number, confidence: number, mean: number, prior?: number): number | null;
export function toWorkRecord(group: PipelineEdition[], rating?: any): any;
