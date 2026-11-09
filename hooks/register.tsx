import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Behind } from '../types'

const behind = atom({ plugin: 'rebase-button', key: 'behind' } as const, null)
const isBusy = atom({ plugin: 'rebase-button', key: 'isBusy' } as const, false)
// Trunk whose rebase just aborted on conflicts; the band then offers a merge Claude finishes.
const conflict = atom({ plugin: 'rebase-button', key: 'conflict' } as const, null)

const CHECK_MS = 60_000
const FETCH_MS = 5 * 60_000

let lastFetch = 0

function git($: EngineInterface, ...args: string[]) {
  return $.process.run(['git', ...args], { timeoutMs: 60_000 })
}

async function trunkOf($: EngineInterface): Promise<string> {
  const head = await git($, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  const trunk = head.stdout.trim()
  // The name comes from the cloned repo and goes into git arguments and the prompt sent as the person,
  // so it must not read as an option or carry anything but a plain branch name.
  return head.exitCode === 0 && /^origin\/[A-Za-z0-9._/-]{1,64}$/.test(trunk) ? trunk : 'origin/main'
}

async function check($: EngineInterface): Promise<void> {
  const inRepo = await git($, 'rev-parse', '--is-inside-work-tree')
  if (inRepo.exitCode !== 0) {
    await update($, behind, () => null)
    return
  }

  const trunk = await trunkOf($)
  if (Date.now() - lastFetch >= FETCH_MS) {
    lastFetch = Date.now()
    await git($, 'fetch', '--quiet', 'origin', trunk.replace(/^origin\//, 'refs/heads/'))
  }
  const count = await git($, 'rev-list', '--count', `HEAD..${trunk}`)
  const n = count.exitCode === 0 ? Number(count.stdout.trim()) : 0
  const next: Behind | null = n > 0 ? { count: n, trunk } : null
  await update($, behind, () => next)
  if (next === null) await update($, conflict, () => null)
}

async function isRebasing($: EngineInterface): Promise<boolean> {
  const dirs = await git($, 'rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply')
  const [merge, apply] = dirs.stdout.trim().split('\n')
  if (dirs.exitCode !== 0 || !merge || !apply) return false
  return (await $.process.run(['test', '-d', merge, '-o', '-d', apply])).exitCode === 0
}

async function rebase($: EngineInterface, trunk: string): Promise<void> {
  // A rebase already under way is the person's own: starting ours fails, and aborting would discard theirs.
  if (await isRebasing($)) {
    $.ui.toast('A rebase is already in progress. Finish or abort it first.')
    return
  }
  await update($, isBusy, () => true)
  try {
    const r = await git($, 'rebase', '--autostash', trunk)
    if (r.exitCode === 0) {
      $.ui.toast(`Rebased onto ${trunk}`)
    } else if (await isRebasing($)) {
      // Never leave the worktree mid-rebase: back out and let the person resolve it by hand.
      await git($, 'rebase', '--abort')
      await update($, conflict, () => trunk)
    } else {
      // Git refused to start, so there is nothing to abort.
      $.ui.toast(`Rebase onto ${trunk} failed: ${r.stderr.trim().split('\n')[0]}`)
    }
  } finally {
    await update($, isBusy, () => false)
    await check($)
  }
}

async function mergeForClaude($: EngineInterface, trunk: string): Promise<void> {
  await update($, conflict, () => null)
  await update($, isBusy, () => true)
  try {
    const m = await git($, 'merge', '--no-edit', '--autostash', trunk)
    if (m.exitCode === 0) {
      $.ui.toast(`Merged ${trunk}`)
      return
    }
    const files = (await git($, 'diff', '--name-only', '--diff-filter=U')).stdout.trim()
    if (files === '') {
      // Merge failed before touching the tree (e.g. it refused to start); nothing for Claude to fix.
      $.ui.toast(`Merge of ${trunk} failed: ${m.stderr.trim().split('\n')[0]}`)
      return
    }
    // File names come from the repo, so Claude lists them itself: they must not be sent as the person's words.
    void $.prompt.submit({
      text:
        `I merged ${trunk} into this branch and it left conflicts. ` +
        'List them with `git diff --name-only --diff-filter=U`. Resolve each conflict, keeping the intent of both sides. Ask me if a conflict needs a judgment call. ' +
        'Then stage the files and finish with `git commit --no-edit`. If it goes wrong, `git merge --abort` restores the branch.',
    })
  } finally {
    await update($, isBusy, () => false)
    await check($)
  }
}

export const register: Register = on => {
  lastFetch = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Not awaited: the first check fetches, and a slow network must not hold up the session.
    void check($)
    $.clock.every(CHECK_MS, () => check($))
    return result
  })

  // The model may have committed, pulled or switched branches.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void check($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, behind)
    if (e.props.hasSurvey || state === null) return next(e)

    const busy = await read($, isBusy)
    const conflicted = await read($, conflict)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (conflicted !== null && !busy) {
      return (
        <Box>
          <Text color="error">Rebase onto {conflicted} hit conflicts and was undone. </Text>
          <Button key="merge" label="Merge and let Claude fix" onPress={() => mergeForClaude($, conflicted)} />
          <Button key="dismiss" label="Dismiss" onPress={() => update($, conflict, () => null)} />
        </Box>
      )
    }

    return (
      <Box>
        <Text color="warning">
          {state.count} commit{state.count === 1 ? '' : 's'} behind {state.trunk}{' '}
        </Text>
        {busy ? (
          <Text dimColor>Working…</Text>
        ) : (
          <Button key="rebase" label="Rebase" onPress={() => rebase($, state.trunk)} />
        )}
      </Box>
    )
  })
}
