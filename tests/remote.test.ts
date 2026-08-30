import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configuredRemoteProvider,
  JsonRemoteProviderStore,
  parseRemoteProviderState,
  RemoteProviderCoordinator,
  settleRemoteResources,
  terminateRemoteProcess,
  type RemoteProviderController,
  type RemoteProviderStatus,
} from '../src/remote.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

class FakeRemoteController implements RemoteProviderController {
  enabled = false
  readonly changes: boolean[] = []

  async initialize(): Promise<void> {}
  gateway(): undefined { return undefined }
  status(): RemoteProviderStatus { return { enabled: this.enabled, state: this.enabled ? 'ready' : 'off' } }
  async setEnabled(enabled: boolean): Promise<RemoteProviderStatus> {
    this.changes.push(enabled)
    this.enabled = enabled
    return this.status()
  }
  async reconnect(): Promise<RemoteProviderStatus> { return this.setEnabled(true) }
  async reset(): Promise<RemoteProviderStatus> { return this.setEnabled(false) }
  async close(): Promise<void> {}
}

describe('remote provider selection', () => {
  it('accepts only one supported provider and no extra fields', () => {
    expect(parseRemoteProviderState({ version: 1, provider: 'tailscale' })).toEqual({ version: 1, provider: 'tailscale' })
    expect(parseRemoteProviderState({ version: 1, provider: 'cpolar' })).toEqual({ version: 1, provider: 'cpolar' })
    expect(parseRemoteProviderState({ version: 1, provider: 'frp' })).toEqual({ version: 1, provider: 'frp' })
    expect(() => parseRemoteProviderState({ version: 1, provider: 'other' })).toThrow('unsupported format')
    expect(() => parseRemoteProviderState({ version: 1, provider: 'cpolar', token: 'secret' })).toThrow('unsupported format')
  })

  it('uses the environment only for the first-run default', async () => {
    expect(configuredRemoteProvider({})).toBe('tailscale')
    expect(configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'cpolar' })).toBe('cpolar')
    expect(configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'frp' })).toBe('frp')
    expect(() => configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'invalid' })).toThrow('must be tailscale, cpolar, or frp')

    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-remote-provider-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'state', 'provider.json')
    const store = new JsonRemoteProviderStore(file, 'tailscale')
    expect(await store.load()).toEqual({ version: 1, provider: 'tailscale' })
    await store.save({ version: 1, provider: 'cpolar' })
    expect(await new JsonRemoteProviderStore(file, 'tailscale').load()).toEqual({ version: 1, provider: 'cpolar' })
  })

  it('serializes enable and selection so the previous provider cannot finish late', async () => {
    const controllers = {
      tailscale: new FakeRemoteController(),
      cpolar: new FakeRemoteController(),
      frp: new FakeRemoteController(),
    }
    const saved: string[] = []
    const coordinator = new RemoteProviderCoordinator('tailscale', controllers, {
      save: async state => { saved.push(state.provider) },
    })
    let releaseEnable: (() => void) | undefined
    const enableGate = new Promise<void>(resolve => { releaseEnable = resolve })
    let enableStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { enableStarted = resolve })

    const enabling = coordinator.mutate(async controller => {
      enableStarted?.()
      await enableGate
      return controller.setEnabled(true)
    })
    await started
    const selecting = coordinator.select('frp')
    expect(saved).toEqual([])
    releaseEnable?.()
    await Promise.all([enabling, selecting])

    expect(coordinator.selected).toBe('frp')
    expect(saved).toEqual(['frp'])
    expect(controllers.tailscale.enabled).toBe(false)
    expect(controllers.cpolar.enabled).toBe(false)
  })

  it('restores the single-provider invariant even when a mutation fails', async () => {
    const controllers = {
      tailscale: new FakeRemoteController(),
      cpolar: new FakeRemoteController(),
      frp: new FakeRemoteController(),
    }
    controllers.cpolar.enabled = true
    const coordinator = new RemoteProviderCoordinator('tailscale', controllers, { save: async () => {} })
    await expect(coordinator.mutate(async () => { throw new Error('operation failed') })).rejects.toThrow('operation failed')
    expect(controllers.cpolar.enabled).toBe(false)
    expect(controllers.frp.enabled).toBe(false)
  })

  it('waits for process close after escalating from TERM to KILL', async () => {
    vi.useFakeTimers()
    const process = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: ReturnType<typeof vi.fn>
    }
    process.exitCode = null
    process.signalCode = null
    process.kill = vi.fn(() => true)
    let completed = false
    const stopping = terminateRemoteProcess(process as unknown as ChildProcess, 100, 100)
      .then(() => { completed = true })

    await vi.advanceTimersByTimeAsync(100)
    expect(process.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(process.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(completed).toBe(false)
    process.emit('close', null, null)
    await stopping
    expect(completed).toBe(true)
  })

  it('does not wait again after a process has already exited by signal', async () => {
    const process = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: ReturnType<typeof vi.fn>
    }
    process.exitCode = null
    process.signalCode = 'SIGTERM'
    process.kill = vi.fn(() => true)

    await terminateRemoteProcess(process as unknown as ChildProcess)

    expect(process.kill).not.toHaveBeenCalled()
  })

  it('settles every provider resource before aggregating cleanup failures', async () => {
    const completed: string[] = []
    let failure: unknown
    try {
      await settleRemoteResources([
        async () => { completed.push('process'); throw new Error('process failed') },
        async () => { completed.push('gateway') },
        async () => { completed.push('config'); throw new Error('config failed') },
      ])
    } catch (error) { failure = error }
    expect(completed).toEqual(['process', 'gateway', 'config'])
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
  })
})
