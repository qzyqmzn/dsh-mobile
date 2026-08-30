import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileAccessControlState, MobileAccessControlStore } from '../src/control.js'
import { FrpConfigStore } from '../src/frp-config.js'
import { FrpController } from '../src/frp.js'
import type { MobileAccessGateway } from '../src/gateway.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

class MemoryControlStore implements MobileAccessControlStore {
  state: MobileAccessControlState = { version: 1, enabled: false }

  async load(): Promise<MobileAccessControlState> { return this.state }
  async save(state: MobileAccessControlState): Promise<void> { this.state = state }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null

  kill(): boolean {
    if (this.exitCode !== null) return false
    this.exitCode = 0
    setImmediate(() => { this.emit('close', 0) })
    return true
  }
}

async function fixture(): Promise<{
  directory: string
  executable: string
  config: FrpConfigStore
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-'))
  temporaryDirectories.push(directory)
  const executable = join(directory, 'component', 'frpc.exe')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'fake-frpc')
  const config = new FrpConfigStore(join(directory, 'config'))
  await config.initialize()
  await config.configure({
    serverAddress: 'frp.example.com',
    serverPort: 7000,
    token: '0123456789abcdef0123456789abcdef',
    publicOrigin: 'https://dsh.example.com',
  })
  return { directory, executable, config }
}

function gateway(): MobileAccessGateway {
  return {
    address: () => ({ host: '127.0.0.1', port: 42123, origin: 'http://127.0.0.1:42123' }),
    close: vi.fn(async () => undefined),
  } as unknown as MobileAccessGateway
}

describe('FRP provider lifecycle', () => {
  it('uses discovery identity rather than log text to become ready', async () => {
    const { executable, config } = await fixture()
    const child = new FakeChild()
    const activeGateway = gateway()
    const probeDiscovery = vi.fn(async () => true)
    const controller = new FrpController({
      store: new MemoryControlStore(),
      executable,
      config,
      instanceId: 'a'.repeat(64),
      createGateway: async () => activeGateway,
      probeVhostExposure: async () => false,
      verifyConfig: async () => undefined,
      launchClient: () => child as unknown as ChildProcessWithoutNullStreams,
      probeDiscovery,
      startTimeoutMs: 500,
      retryIntervalMs: 1,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    await vi.waitFor(() => { expect(controller.status()).toEqual({ enabled: true, state: 'ready', origin: 'https://dsh.example.com' }) })
    expect(probeDiscovery).toHaveBeenCalledWith('https://dsh.example.com', 'a'.repeat(64), expect.any(AbortSignal))
    await controller.setEnabled(false)
    expect(controller.status()).toEqual({ enabled: false, state: 'off' })
    expect(activeGateway.close).toHaveBeenCalledOnce()
  })

  it('rejects a publicly reachable plaintext vhost before starting the gateway', async () => {
    const { executable, config } = await fixture()
    const createGateway = vi.fn(async () => gateway())
    const controller = new FrpController({
      store: new MemoryControlStore(),
      executable,
      config,
      instanceId: 'b'.repeat(64),
      createGateway,
      probeVhostExposure: async () => true,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    expect(controller.status()).toEqual({
      enabled: true,
      state: 'error',
      origin: 'https://dsh.example.com',
      errorCode: 'frp_vhost_publicly_reachable',
    })
    expect(createGateway).not.toHaveBeenCalled()
    await controller.close()
  })
})
