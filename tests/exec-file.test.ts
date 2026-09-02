import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ stdout: 'hello\n' as unknown, stderr: '' as unknown, error: null as Error | null }))
vi.mock('node:child_process', () => ({
  // A desktop-style callback wrapper has no custom promisify metadata.
  execFile: (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: unknown, stderr: unknown) => void) => {
    callback(state.error, state.stdout, state.stderr)
  },
}))
import { execFile } from 'node:child_process'
import { execFileText } from '../src/exec-file.js'

afterEach(() => { state.stdout = 'hello\n'; state.stderr = ''; state.error = null })

describe('desktop-compatible subprocess output', () => {
  it('reproduces the lost stdout property with generic promisify', async () => {
    const result = await promisify(execFile)('fixture', [], { encoding: 'utf8' })
    expect(result).toBe('hello\n')
    expect(result.stdout).toBeUndefined()
  })

  it('preserves both streams without relying on promisify metadata', async () => {
    state.stderr = 'warning\n'
    await expect(execFileText('fixture', [])).resolves.toEqual({ stdout: 'hello\n', stderr: 'warning\n' })
  })

  it('propagates command failures instead of accepting output', async () => {
    state.error = new Error('permission denied')
    await expect(execFileText('fixture', [])).rejects.toBe(state.error)
  })

  it('rejects missing output with an actionable error instead of a trim crash', async () => {
    state.stdout = undefined
    await expect(execFileText('fixture', [])).rejects.toThrow('subprocess returned invalid text output')
  })
})
