import { definePlugin } from '@mayday/sdk';

interface EvilTwinConfig {
  transcriptSource: 'auto' | 'whisper' | 'premiere';
  anthropicApiKey: string;
  requireTakeApproval: boolean;
  preRollMs: number;
  postRollMs: number;
  rampThresholdDb: number;
  heuristicConfidenceCutoff: number;
}

const NOT_IMPL = 'Not implemented yet — Evil Twin is at scaffolding stage (build step 1).';

export default definePlugin({
  async activate(ctx: any) {
    ctx.log.info('Cutting Board Evil Twin activated');

    const cfg = ctx.config as Partial<EvilTwinConfig>;
    if (!cfg.anthropicApiKey) {
      ctx.log.info('No Anthropic API key set — LLM tiebreak will be skipped (heuristic-only).');
    }
  },

  async deactivate(ctx: any) {
    ctx.log.info('Cutting Board Evil Twin deactivated');
  },

  commands: {
    async run(_ctx: any, _args?: Record<string, unknown>) {
      throw new Error(NOT_IMPL);
    },

    async transcribe(_ctx: any, _args?: Record<string, unknown>) {
      throw new Error(NOT_IMPL);
    },

    async 'silence-pass'(_ctx: any, _args?: Record<string, unknown>) {
      throw new Error(NOT_IMPL);
    },

    async 'detect-takes'(_ctx: any, _args?: Record<string, unknown>) {
      throw new Error(NOT_IMPL);
    },

    async 'apply-take-cuts'(_ctx: any, _args?: Record<string, unknown>) {
      throw new Error(NOT_IMPL);
    },

    async 'refine-cuts'(_ctx: any, _args?: Record<string, unknown>) {
      throw new Error(NOT_IMPL);
    },
  },
});
