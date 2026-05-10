/**
 * Heuristic take detector.
 *
 * Given a transcript of segments (start/end/text), finds clusters where the
 * speaker re-started — said the same opening words multiple times within a
 * short window. The last attempt in each cluster is treated as the "kept"
 * take; everything before it is a "draft" candidate to cut.
 *
 * Pure function. No SDK or Premiere dependency. Easy to unit test.
 */

import type { TranscriptSegment } from './sdk.js';

export interface TakeDetectorOptions {
  /** Number of opening tokens compared between segments. Default 4. */
  prefixWords?: number;
  /** Max time (seconds) between two starts for them to count as restarts. Default 30. */
  maxGapSeconds?: number;
  /** Minimum confidence to surface a candidate (0..1). Default 0.6. */
  minConfidence?: number;
}

export type TakeMatchReason = 'exact-prefix' | 'fuzzy-prefix' | 'bigram-overlap';

export interface TakeCutCandidate {
  /** Index of the segment to cut. */
  cutSegmentIndex: number;
  cutStart: number;
  cutEnd: number;
  cutText: string;
  /** Index of the segment treated as the "kept" final take. */
  finalTakeIndex: number;
  finalTakeStart: number;
  finalTakeText: string;
  confidence: number; // 0..1
  reason: TakeMatchReason;
}

export interface TakeGroup {
  finalTakeIndex: number;
  finalTakeStart: number;
  finalTakeText: string;
  /**
   * Time range to ripple-delete. Spans from the earliest draft in the group
   * up to (but not including) the start of the final take. Includes any
   * non-matching segments in between — asides, false starts, "let me start
   * over" filler — because they're all part of the discarded attempts.
   */
  cutRangeStart: number;
  cutRangeEnd: number;
  /** Individual segments that triggered the match (for review UI highlighting). */
  drafts: TakeCutCandidate[];
  /** All segments swept up by the cut range (includes drafts + intervening asides). */
  segmentsInRange: TranscriptSegment[];
}

export interface TakeDetectionResult {
  groups: TakeGroup[];
  candidates: TakeCutCandidate[]; // flat list, sorted by cutStart
  segmentCount: number;
}

const STOPWORDS_LEADING = new Set(['um', 'uh', 'uhh', 'er', 'ah', 'so', 'ok', 'okay', 'and', 'but']);

/** Tokenize: lowercase, strip punctuation, drop leading filler words. */
function tokenize(text: string): string[] {
  const cleaned = text.toLowerCase().replace(/[.,!?;:"()\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const tokens = cleaned.split(' ');
  // Drop leading fillers ("um, today we're going to..." → ["today", "we're", "going", "to"])
  let i = 0;
  while (i < tokens.length && STOPWORDS_LEADING.has(tokens[i])) i++;
  return tokens.slice(i);
}

function prefixOf(tokens: string[], n: number): string[] {
  return tokens.slice(0, n);
}

/** Levenshtein distance between two short token arrays (treated as words). */
function tokenLevenshtein(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp: number[] = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;
  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = tmp;
    }
  }
  return dp[m];
}

/** Bigram overlap ratio: |bigrams(a) ∩ bigrams(b)| / max(|a|, |b|) bigrams. */
function bigramOverlap(a: string[], b: string[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (arr: string[]): Set<string> => {
    const s = new Set<string>();
    for (let i = 0; i < arr.length - 1; i++) s.add(arr[i] + ' ' + arr[i + 1]);
    return s;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const denom = Math.max(A.size, B.size);
  return denom === 0 ? 0 : inter / denom;
}

/**
 * Score how strongly segment B looks like a restart of segment A.
 * Returns { confidence (0..1), reason } or null if no plausible match.
 */
function scoreRestart(prefA: string[], prefB: string[]): { confidence: number; reason: TakeMatchReason } | null {
  if (prefA.length === 0 || prefB.length === 0) return null;

  // Exact prefix: identical token-for-token (up to the shorter length)
  const minLen = Math.min(prefA.length, prefB.length);
  let exactMatch = 0;
  for (let i = 0; i < minLen; i++) {
    if (prefA[i] === prefB[i]) exactMatch++;
    else break;
  }
  if (exactMatch >= 3) {
    // 3+ tokens of identical opening = high confidence restart
    const conf = Math.min(0.95, 0.6 + 0.1 * exactMatch);
    return { confidence: conf, reason: 'exact-prefix' };
  }

  // Below 3 leading-exact tokens, require at least 2 exact tokens before
  // considering fuzzy matches — prevents "the first..." matching "the second..."
  // on a single shared word.
  if (exactMatch < 2) return null;

  // Fuzzy prefix: edit distance on first N tokens
  const editDist = tokenLevenshtein(prefA, prefB);
  const maxLen = Math.max(prefA.length, prefB.length);
  const editRatio = 1 - editDist / maxLen;
  if (editRatio >= 0.7 && maxLen >= 3) {
    return { confidence: 0.6 + 0.25 * (editRatio - 0.7) / 0.3, reason: 'fuzzy-prefix' };
  }

  // Bigram overlap fallback
  const overlap = bigramOverlap(prefA, prefB);
  if (overlap >= 0.5 && maxLen >= 3) {
    return { confidence: 0.5 + 0.3 * (overlap - 0.5) / 0.5, reason: 'bigram-overlap' };
  }

  return null;
}

/**
 * Pre-processor: splits segments at internal restart points.
 *
 * Whisper often packs multiple takes into a single audio-energy-based
 * segment ("Hey guys welcome to the channel my name is trip hey guys
 * welcome to the channel my name is Trevor"). The base detector compares
 * BETWEEN segments, so it can't see those internal restarts.
 *
 * This pass concatenates all words into a stream with estimated
 * per-word timestamps, finds N-gram phrases (default 4+ words) that
 * repeat within maxGap seconds, and inserts segment boundaries at every
 * occurrence. The downstream detector then sees the takes as separate
 * segments and groups them normally.
 */
export function splitOnInternalRestarts(
  segments: TranscriptSegment[],
  minPhraseLen = 4,
  maxGapSeconds = 30,
): TranscriptSegment[] {
  if (segments.length === 0) return segments;

  // Word stream with estimated per-word timestamps and back-references
  type W = { text: string; time: number; segIdx: number; tokIdx: number };
  const stream: W[] = [];
  const segTokenCounts: number[] = [];
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const toks = tokenize(seg.text);
    segTokenCounts.push(toks.length);
    const dur = Math.max(seg.end - seg.start, 0.001);
    for (let tokIdx = 0; tokIdx < toks.length; tokIdx++) {
      const time = seg.start + (tokIdx / Math.max(toks.length, 1)) * dur;
      stream.push({ text: toks[tokIdx], time, segIdx, tokIdx });
    }
  }

  // Index N-gram phrases → list of stream positions
  const phraseAt = new Map<string, number[]>();
  for (let i = 0; i + minPhraseLen <= stream.length; i++) {
    const phrase = stream.slice(i, i + minPhraseLen).map((w) => w.text).join(' ');
    let list = phraseAt.get(phrase);
    if (!list) {
      list = [];
      phraseAt.set(phrase, list);
    }
    list.push(i);
  }

  // Collect stream positions that are take starts.
  // We need EVERY occurrence of a repeated phrase to become a segment
  // boundary — including the LAST one (the keeper's start), so the
  // downstream prefix detector can see the keeper as the start of its own
  // segment instead of buried inside the previous take's tail.
  const restartPositions = new Set<number>();
  for (const positions of phraseAt.values()) {
    if (positions.length < 2) continue;
    // A cluster is valid if at least two occurrences fall within maxGap of each other
    for (let i = 0; i < positions.length; i++) {
      let inCluster = false;
      for (let j = 0; j < positions.length; j++) {
        if (i === j) continue;
        if (Math.abs(stream[positions[i]].time - stream[positions[j]].time) <= maxGapSeconds) {
          inCluster = true;
          break;
        }
      }
      if (inCluster) restartPositions.add(positions[i]);
    }
  }

  if (restartPositions.size === 0) return segments;

  // Dedup consecutive runs: each repeated phrase produces a run of consecutive
  // marked positions (one per overlapping 4-gram window). Only the FIRST
  // position in each run is the actual take boundary — keep that, drop the rest.
  const sortedPositions = [...restartPositions].sort((a, b) => a - b);
  const dedupedPositions: number[] = [];
  let lastAdded = -2;
  for (const p of sortedPositions) {
    if (p - lastAdded > 1) {
      dedupedPositions.push(p);
    }
    lastAdded = p;
  }

  // For each segment, find restart positions falling inside it (excluding position 0
  // of the first segment, which would create an empty leading sub-segment)
  type Cut = { tokIdx: number; time: number };
  const cutsPerSeg = new Map<number, Cut[]>();
  for (const pos of dedupedPositions) {
    const w = stream[pos];
    if (w.tokIdx === 0) continue; // splitting at the very start of a segment is a no-op
    const list = cutsPerSeg.get(w.segIdx) ?? [];
    list.push({ tokIdx: w.tokIdx, time: w.time });
    cutsPerSeg.set(w.segIdx, list);
  }

  if (cutsPerSeg.size === 0) return segments;

  // Build new segments: walk each original, splitting at the cut points
  const newSegs: TranscriptSegment[] = [];
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const cuts = cutsPerSeg.get(segIdx);
    if (!cuts || cuts.length === 0) {
      newSegs.push(seg);
      continue;
    }
    cuts.sort((a, b) => a.tokIdx - b.tokIdx);
    const tokens = tokenize(seg.text);
    const dur = Math.max(seg.end - seg.start, 0.001);

    let prevTok = 0;
    let prevTime = seg.start;
    for (const cut of cuts) {
      if (cut.tokIdx <= prevTok) continue;
      newSegs.push({
        start: prevTime,
        end: cut.time,
        text: tokens.slice(prevTok, cut.tokIdx).join(' '),
      });
      prevTok = cut.tokIdx;
      prevTime = cut.time;
    }
    if (prevTok < tokens.length) {
      newSegs.push({
        start: prevTime,
        end: seg.end,
        text: tokens.slice(prevTok).join(' '),
      });
    }
  }

  return newSegs;
}

export function detectTakes(
  segments: TranscriptSegment[],
  options: TakeDetectorOptions = {},
): TakeDetectionResult {
  const prefixWords = options.prefixWords ?? 4;
  const maxGap = options.maxGapSeconds ?? 30;
  const minConf = options.minConfidence ?? 0.6;

  // Pre-process: split segments at internal restart points so whisper's
  // long mixed-take segments become detectable.
  segments = splitOnInternalRestarts(segments, prefixWords, maxGap);

  const tokenized = segments.map((s) => tokenize(s.text));
  const prefixes = tokenized.map((t) => prefixOf(t, prefixWords));

  // Build links: for each segment, find its closest later "successor" that looks like a continuation/restart
  // edge[i] = j means segment j is a restart of segment i (j cuts i out)
  const successor: Array<{ next: number; confidence: number; reason: TakeMatchReason } | null> = segments.map(() => null);

  for (let i = 0; i < segments.length; i++) {
    if (prefixes[i].length === 0) continue;
    // Look ahead for a restart within maxGap seconds
    let best: { next: number; confidence: number; reason: TakeMatchReason } | null = null;
    for (let j = i + 1; j < segments.length; j++) {
      if (segments[j].start - segments[i].end > maxGap) break;
      if (prefixes[j].length === 0) continue;
      const score = scoreRestart(prefixes[i], prefixes[j]);
      if (!score || score.confidence < minConf) continue;
      if (!best || score.confidence > best.confidence) {
        best = { next: j, confidence: score.confidence, reason: score.reason };
      }
    }
    if (best) successor[i] = best;
  }

  // Walk chains forward: i → succ[i] → succ[succ[i]] → ... until null. The terminal is the "final take".
  // Group all earlier links as drafts of that final.
  const finalOf = new Array<number>(segments.length);
  for (let i = 0; i < segments.length; i++) {
    let cur = i;
    const seen = new Set<number>([cur]);
    while (successor[cur] && !seen.has(successor[cur]!.next)) {
      cur = successor[cur]!.next;
      seen.add(cur);
    }
    finalOf[i] = cur;
  }

  // Build groups
  const groupsByFinal = new Map<number, TakeCutCandidate[]>();
  for (let i = 0; i < segments.length; i++) {
    if (finalOf[i] === i) continue; // not a draft
    const succ = successor[i]!;
    const candidate: TakeCutCandidate = {
      cutSegmentIndex: i,
      cutStart: segments[i].start,
      cutEnd: segments[i].end,
      cutText: segments[i].text,
      finalTakeIndex: finalOf[i],
      finalTakeStart: segments[finalOf[i]].start,
      finalTakeText: segments[finalOf[i]].text,
      confidence: succ.confidence,
      reason: succ.reason,
    };
    const list = groupsByFinal.get(finalOf[i]) ?? [];
    list.push(candidate);
    groupsByFinal.set(finalOf[i], list);
  }

  const groups: TakeGroup[] = [];
  for (const [finalIdx, drafts] of groupsByFinal) {
    drafts.sort((a, b) => a.cutStart - b.cutStart);
    // The cut range spans from the earliest draft's start to the final take's start.
    // Everything in between gets swept (asides, "let me start over" filler, etc.)
    // because they're part of the discarded attempts.
    const cutRangeStart = drafts[0].cutStart;
    const cutRangeEnd = segments[finalIdx].start;
    const segmentsInRange = segments.filter(
      (s) => s.start >= cutRangeStart && s.start < cutRangeEnd,
    );
    groups.push({
      finalTakeIndex: finalIdx,
      finalTakeStart: segments[finalIdx].start,
      finalTakeText: segments[finalIdx].text,
      cutRangeStart,
      cutRangeEnd,
      drafts,
      segmentsInRange,
    });
  }
  groups.sort((a, b) => a.finalTakeStart - b.finalTakeStart);

  const candidates = groups.flatMap((g) => g.drafts).sort((a, b) => a.cutStart - b.cutStart);

  return {
    groups,
    candidates,
    segmentCount: segments.length,
  };
}

/**
 * A built-in sample transcript with deliberate restarts.
 * Used by the panel's "test detector" button so users can see the algorithm
 * work without needing whisper or a real recording.
 */
export const SAMPLE_TRANSCRIPT: TranscriptSegment[] = [
  { start: 0.0,  end: 2.5,  text: "Today we're going to talk about... uh, hold on." },
  { start: 3.0,  end: 4.2,  text: "Sorry, let me start over." },
  { start: 5.0,  end: 8.0,  text: "Today we're going to talk about plant-based protein sources." },
  { start: 8.5,  end: 12.0, text: "There are three main categories worth knowing about." },
  { start: 12.5, end: 15.0, text: "The first is legumes, which include beans, lentils, and chickpeas." },
  { start: 16.0, end: 18.5, text: "Wait, I should mention something first." },
  { start: 19.0, end: 20.5, text: "OK so, the first is..." },
  { start: 21.0, end: 24.0, text: "The first category is legumes — beans, lentils, chickpeas." },
  { start: 25.0, end: 28.0, text: "These are dirt cheap and packed with fiber." },
  { start: 29.5, end: 32.0, text: "The second is, um, the second category is whole grains." },
  { start: 33.0, end: 36.0, text: "The second category is whole grains like quinoa, oats, and brown rice." },
  { start: 37.0, end: 40.0, text: "Lastly, nuts and seeds round out the trio." },
  { start: 41.0, end: 44.0, text: "Mix and match these for a complete amino acid profile." },
];
