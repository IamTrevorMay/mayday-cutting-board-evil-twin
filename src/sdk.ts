/**
 * Minimal SDK shim — provides definePlugin for standalone builds.
 * The full @mayday/sdk is not needed as a dependency because:
 * - definePlugin is a thin validation wrapper (~15 lines)
 * - All type imports are erased at compile time
 * - esbuild bundles this into the output .mjs
 *
 * When creating a new plugin, copy this file as-is. Add any additional
 * type interfaces your plugin imports from @mayday/sdk here.
 */

export interface PluginDefinition<TConfig = Record<string, unknown>> {
  activate: (ctx: any) => Promise<void> | void;
  deactivate?: (ctx: any) => Promise<void> | void;
  commands?: Record<string, (ctx: any) => Promise<any> | any>;
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
