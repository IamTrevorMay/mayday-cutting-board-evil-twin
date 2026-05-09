/**
 * Minimal SDK shim — provides definePlugin + types for standalone builds.
 * The full @mayday/sdk is not needed as a dependency because:
 * - definePlugin is a thin validation wrapper (~15 lines)
 * - All type imports are erased at compile time
 * - esbuild bundles this into the output .mjs
 */

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  segments: TranscriptSegment[];
  language: string;
  fullText: string;
}

export interface SilentRegion {
  start: number;
  end: number;
  duration: number;
}

export interface RippleDeleteRangeResult {
  rangeStart: number;
  rangeEnd: number;
  durationRemoved: number;
}

export interface DuplicateSequenceResult {
  originalName: string;
  backupName: string;
}

export interface MediaServiceAPI {
  detectSilence(filePath: string, options?: { threshold?: number; minDuration?: number }): Promise<SilentRegion[]>;
  transcribe(filePath: string, options?: { language?: string }): Promise<TranscriptionResult>;
}

export interface TimelineServiceAPI {
  getActiveSequence(): Promise<{ name: string; duration: number; inPoint: number; outPoint: number } | null>;
  duplicateSequence(): Promise<DuplicateSequenceResult | null>;
  rippleDeleteRange(startSeconds: number, endSeconds: number): Promise<RippleDeleteRangeResult | null>;
}

export interface PluginContext {
  pluginId: string;
  config: Record<string, unknown>;
  log: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
  };
  services: {
    timeline: TimelineServiceAPI;
    media: MediaServiceAPI;
  };
  ui: {
    showToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
    showProgress: (label: string, progress: number) => void;
    hideProgress: () => void;
  };
  data: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  invokePlugin(pluginId: string, commandId: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface PluginDefinition<TConfig = Record<string, unknown>> {
  activate: (ctx: PluginContext) => Promise<void> | void;
  deactivate?: (ctx: PluginContext) => Promise<void> | void;
  commands?: Record<string, (ctx: PluginContext, args?: Record<string, unknown>) => Promise<unknown> | unknown>;
}

export function definePlugin<TConfig = Record<string, unknown>>(
  definition: PluginDefinition<TConfig>
): PluginDefinition<TConfig> {
  if (typeof definition.activate !== 'function') {
    throw new Error('Plugin must define an activate() function');
  }

  if (definition.commands) {
    for (const [id, handler] of Object.entries(definition.commands)) {
      if (typeof handler !== 'function') {
        throw new Error(`Command "${id}" must be a function`);
      }
    }
  }

  return definition;
}
