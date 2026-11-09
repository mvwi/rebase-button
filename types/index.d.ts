export type Behind = { count: number; trunk: string }

declare module 'claude-code' {
  interface PluginState {
    'rebase-button': { behind: Behind | null; isBusy: boolean; conflict: string | null }
  }
}
