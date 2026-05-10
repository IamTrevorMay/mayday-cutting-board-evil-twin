import { definePlugin } from '@mayday/sdk';
import type { PluginContext, SilentRegion, TranscriptionResult, RippleDeleteRangeResult, DuplicateSequenceResult, TranscriptSegment } from '@mayday/sdk';
import { detectTakes, SAMPLE_TRANSCRIPT, type TakeDetectorOptions } from './take-detector.js';

interface EvilTwinConfig {
  transcriptSource: 'auto' | 'whisper' | 'premiere';
  anthropicApiKey: string;
  requireTakeApproval: boolean;
  preRollMs: number;
  postRollMs: number;
  rampThresholdDb: number;
  heuristicConfidenceCutoff: number;
}

const NOT_IMPL = 'Not implemented yet — Evil Twin is past scaffolding (build step 1) but earlier than feature step.';

export default definePlugin({
  async activate(ctx: PluginContext) {
    ctx.log.info('Cutting Board Evil Twin activated');

    const cfg = ctx.config as Partial<EvilTwinConfig>;
    if (!cfg.anthropicApiKey) {
      ctx.log.info('No Anthropic API key set — LLM tiebreak will be skipped (heuristic-only).');
    }
  },

  async deactivate(ctx: PluginContext) {
    ctx.log.info('Cutting Board Evil Twin deactivated');
  },

  commands: {
    /**
     * Full Run pipeline. Not yet wired — will orchestrate the three steps once each is validated.
     */
    async run(_ctx: PluginContext, _args?: Record<string, unknown>) {
      throw new Error(NOT_IMPL);
    },

    /**
     * STEP 3 VALIDATION (Transcript adapter).
     * Args: { filePath: string; language?: string }
     * Returns the normalized TranscriptionResult so we can confirm whisper segments come through.
     */
    async transcribe(ctx: PluginContext, args?: Record<string, unknown>) {
      const filePath = String(args?.filePath ?? '');
      if (!filePath) throw new Error('transcribe: required arg "filePath" missing');
      const language = (args?.language as string | undefined) ?? 'en';

      ctx.log.info(`[step3-validate] transcribing ${filePath} (lang=${language})`);
      const result: TranscriptionResult = await ctx.services.media.transcribe(filePath, { language });
      ctx.log.info(`[step3-validate] got ${result.segments.length} segments, language=${result.language}, ${result.fullText.length} chars`);
      return {
        segmentCount: result.segments.length,
        language: result.language,
        firstThree: result.segments.slice(0, 3),
        textPreview: result.fullText.slice(0, 200),
      };
    },

    /**
     * STEP 2 VALIDATION (Silence Remover IPC bridge — CRITICAL gate).
     * Calls silence-remover's "analyze" command via ctx.invokePlugin and reports what came back.
     * Validates that cross-plugin invocation works AND returns structured data.
     */
    async 'silence-pass'(ctx: PluginContext, _args?: Record<string, unknown>) {
      ctx.log.info('[step2-validate] invoking silence-remover/analyze via ctx.invokePlugin...');
      try {
        const result = await ctx.invokePlugin('silence-remover', 'analyze');
        const regions = (result as SilentRegion[] | undefined) ?? [];
        ctx.log.info(`[step2-validate] silence-remover returned ${regions.length} region(s)`);
        return {
          gate: 'step2-cross-plugin-invocation',
          ok: true,
          returnedType: Array.isArray(result) ? 'array' : typeof result,
          regionCount: regions.length,
          firstThree: regions.slice(0, 3),
        };
      } catch (err) {
        ctx.log.error('[step2-validate] FAILED:', err);
        return {
          gate: 'step2-cross-plugin-invocation',
          ok: false,
          error: String(err),
        };
      }
    },

    /**
     * STEP 5 — heuristic take detector.
     * Args: { segments?: TranscriptSegment[]; useSample?: boolean; prefixWords?: number; maxGapSeconds?: number; minConfidence?: number }
     * Returns the detected take groups + flat list of cut candidates.
     * If `useSample: true` (or no segments provided), runs against the built-in
     * sample transcript so the algorithm can be exercised without whisper.
     */
    async 'detect-takes'(ctx: PluginContext, args?: Record<string, unknown>) {
      const useSample = Boolean(args?.useSample) || !args?.segments;
      const segments: TranscriptSegment[] = useSample
        ? SAMPLE_TRANSCRIPT
        : (args!.segments as TranscriptSegment[]);

      const options: TakeDetectorOptions = {
        prefixWords: typeof args?.prefixWords === 'number' ? args!.prefixWords as number : undefined,
        maxGapSeconds: typeof args?.maxGapSeconds === 'number' ? args!.maxGapSeconds as number : undefined,
        minConfidence: typeof args?.minConfidence === 'number' ? args!.minConfidence as number : undefined,
      };

      ctx.log.info(`[step5] detect-takes on ${segments.length} segments (sample=${useSample})`);
      const result = detectTakes(segments, options);
      ctx.log.info(`[step5] found ${result.groups.length} take group(s), ${result.candidates.length} draft segment(s)`);

      // Lift "actionable" data to the top — the cut ranges are what feed
      // ripple-delete. Drafts + segmentsInRange are kept inside groups for
      // the review UI.
      const cutRanges = result.groups.map((g) => ({
        startSeconds: g.cutRangeStart,
        endSeconds: g.cutRangeEnd,
        durationSeconds: g.cutRangeEnd - g.cutRangeStart,
        keepStartingAt: g.finalTakeStart,
        keepText: g.finalTakeText,
        segmentsCutCount: g.segmentsInRange.length,
      }));

      return {
        usedSample: useSample,
        segmentCount: result.segmentCount,
        groupCount: result.groups.length,
        cutRanges,
        groups: result.groups,
      };
    },

    async 'apply-take-cuts'(_ctx: PluginContext, _args?: Record<string, unknown>) {
      throw new Error(NOT_IMPL);
    },

    async 'refine-cuts'(_ctx: PluginContext, _args?: Record<string, unknown>) {
      throw new Error(NOT_IMPL);
    },

    /**
     * STEP 4 VALIDATION (sequence duplication + range ripple delete — CRITICAL gate).
     * Args: { startSeconds: number; endSeconds: number }
     * Duplicates the active sequence, then ripple-deletes the range across all unlocked tracks
     * on the duplicate. Validates frame accuracy + multi-track sync — open the duplicate in
     * Premiere and confirm clips after the range have shifted back exactly endSeconds-startSeconds
     * with audio still in sync.
     *
     * Caveat: Premiere's Extract command requires the Timeline panel to have focus. Click the
     * timeline before invoking.
     */
    async 'duplicate-and-clear-range'(ctx: PluginContext, args?: Record<string, unknown>) {
      const startSeconds = Number(args?.startSeconds);
      const endSeconds = Number(args?.endSeconds);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        throw new Error('duplicate-and-clear-range: needs numeric args { startSeconds, endSeconds } with end > start');
      }

      ctx.log.info(`[step4-validate] duplicating active sequence...`);
      const dup: DuplicateSequenceResult | null = await ctx.services.timeline.duplicateSequence();
      if (!dup) {
        return { gate: 'step4-duplicate-and-range-delete', ok: false, error: 'duplicateSequence returned null (no active sequence?)' };
      }
      ctx.log.info(`[step4-validate] duplicated: ${dup.originalName} → ${dup.backupName}`);

      ctx.log.info(`[step4-validate] ripple-deleting range [${startSeconds}, ${endSeconds}] on the duplicate...`);
      const deleted: RippleDeleteRangeResult = await ctx.services.timeline.rippleDeleteRange(startSeconds, endSeconds);

      if (!deleted || !deleted.ok) {
        ctx.log.warn('[step4-validate] FAILED:', deleted);
        return {
          gate: 'step4-duplicate-and-range-delete',
          ok: false,
          duplicate: dup,
          diagnostic: deleted,
        };
      }

      ctx.log.info(`[step4-validate] removed ${deleted.durationRemoved.toFixed(3)}s from duplicate (actualIn=${deleted.actualIn}, actualOut=${deleted.actualOut})`);
      return {
        gate: 'step4-duplicate-and-range-delete',
        ok: true,
        duplicate: dup,
        rangeRemoved: deleted,
      };
    },
  },
});
