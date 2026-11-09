export type Behind = { count: number; trunk: string }

declare module 'claude-code' {
  interface PluginState {
    'trunk-behind': { behind: Behind | null; isBusy: boolean; conflict: string | null }
  }
}
