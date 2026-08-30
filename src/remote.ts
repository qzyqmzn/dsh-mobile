import { randomBytes } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { MobileAccessGateway } from './gateway.js'
import { restrictPrivateFile } from './private-file.js'

/** Remote transports supported by the desktop plugin and Android client. */
export type RemoteProvider = 'tailscale' | 'cpolar' | 'frp'

/** Common safe status returned by every remote provider controller. */
export interface RemoteProviderStatus {
  readonly enabled: boolean
  readonly state: string
  readonly origin?: string
  readonly loginUrl?: string
  readonly setupUrl?: string
  readonly errorCode?: string
}

/** Lifecycle shared by selectable remote providers. */
export interface RemoteProviderController {
  initialize(): Promise<void>
  gateway(): MobileAccessGateway | undefined
  status(): RemoteProviderStatus
  setEnabled(enabled: boolean): Promise<RemoteProviderStatus>
  reconnect(): Promise<RemoteProviderStatus>
  reset(): Promise<RemoteProviderStatus>
  close(): Promise<void>
}

/** Durable selection for the single active remote transport. */
export interface RemoteProviderState {
  readonly version: 1
  readonly provider: RemoteProvider
}

const REMOTE_PROVIDERS: readonly RemoteProvider[] = ['tailscale', 'cpolar', 'frp']

/** Persist only the selected remote provider. */
export interface RemoteProviderStore {
  save(state: RemoteProviderState): Promise<void>
}

function aggregateErrors(errors: readonly unknown[], message: string): Error | undefined {
  if (errors.length === 0) return undefined
  if (errors.length === 1 && errors[0] instanceof Error) return errors[0]
  return new AggregateError(errors, message)
}

/** Settle independent remote cleanup work before reporting any collected failure. */
export async function settleRemoteResources(
  steps: readonly (() => void | Promise<void>)[],
  message = 'remote resource cleanup failed',
): Promise<void> {
  const results = await Promise.allSettled(steps.map(async step => step()))
  const errors = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason as unknown)
  const failure = aggregateErrors(errors, message)
  if (failure !== undefined) throw failure
}

/**
 * Serialize all provider mutations and preserve the single-provider invariant.
 * Operations read the selected controller only after reaching the front of the queue.
 */
export class RemoteProviderCoordinator {
  private selectedValue: RemoteProvider
  private queue: Promise<void> = Promise.resolve()

  constructor(
    selected: RemoteProvider,
    private readonly controllers: Readonly<Record<RemoteProvider, RemoteProviderController>>,
    private readonly store: RemoteProviderStore,
  ) {
    this.selectedValue = selected
  }

  /** Return the durable provider currently selected by the desktop UI. */
  get selected(): RemoteProvider {
    return this.selectedValue
  }

  /** Return the controller selected when this method is called. */
  controller(): RemoteProviderController {
    return this.controllers[this.selectedValue]
  }

  /** Run a provider-owned mutation after all earlier provider work settles. */
  mutate<T>(operation: (controller: RemoteProviderController) => Promise<T>): Promise<T> {
    return this.enqueue(() => operation(this.controller()))
  }

  /** Disable the previous provider, persist the new selection, and retain rollback on write failure. */
  select(provider: RemoteProvider): Promise<void> {
    return this.enqueue(async () => {
      if (provider === this.selectedValue) return
      const previous = this.controllers[this.selectedValue]
      const restore = previous.status().enabled
      if (restore) await previous.setEnabled(false)
      try {
        await this.store.save({ version: 1, provider })
        this.selectedValue = provider
      } catch (error) {
        if (restore) {
          try { await previous.setEnabled(true) }
          catch (restoreError) { throw new AggregateError([error, restoreError], 'remote provider selection rollback failed') }
        }
        throw error
      }
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(
      () => this.runAndEnforce(operation),
      () => this.runAndEnforce(operation),
    )
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private async runAndEnforce<T>(operation: () => Promise<T>): Promise<T> {
    let value: T | undefined
    let operationError: unknown
    try { value = await operation() } catch (error) { operationError = error }
    const results = await Promise.allSettled(
      REMOTE_PROVIDERS
        .filter(provider => provider !== this.selectedValue)
        .map(provider => this.controllers[provider].setEnabled(false)),
    )
    const errors = [
      ...(operationError === undefined ? [] : [operationError]),
      ...results.filter(result => result.status === 'rejected').map(result => result.reason as unknown),
    ]
    const failure = aggregateErrors(errors, 'remote provider operation failed')
    if (failure !== undefined) throw failure
    return value as T
  }
}

/** Stop an owned provider process and do not report completion before its close event. */
export async function terminateRemoteProcess(
  child: ChildProcess,
  gracefulTimeoutMs = 1_500,
  forcedTimeoutMs = 1_500,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveClose, rejectClose) => {
    let gracefulTimer: NodeJS.Timeout | undefined
    let forcedTimer: NodeJS.Timeout | undefined
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (gracefulTimer !== undefined) clearTimeout(gracefulTimer)
      if (forcedTimer !== undefined) clearTimeout(forcedTimer)
      child.off('close', onClose)
      if (error === undefined) resolveClose()
      else rejectClose(error)
    }
    const onClose = (): void => { finish() }
    child.once('close', onClose)
    try { child.kill('SIGTERM') } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (settled) return
    gracefulTimer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (settled) return
      forcedTimer = setTimeout(() => {
        finish(new Error('remote_process_stop_timeout'))
      }, forcedTimeoutMs)
      forcedTimer.unref()
    }, gracefulTimeoutMs)
    gracefulTimer.unref()
  })
}

/** Validate the provider selection loaded across the filesystem boundary. */
export function parseRemoteProviderState(value: unknown): RemoteProviderState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('remote provider state must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1
    || (record.provider !== 'tailscale' && record.provider !== 'cpolar' && record.provider !== 'frp')
    || Reflect.ownKeys(record).some(key => key !== 'version' && key !== 'provider')) {
    throw new Error('remote provider state has an unsupported format')
  }
  return Object.freeze({ version: 1, provider: record.provider })
}

/** Atomic selection store whose absent-file state uses the configured default. */
export class JsonRemoteProviderStore {
  constructor(private readonly file: string, private readonly defaultProvider: RemoteProvider) {}

  async load(): Promise<RemoteProviderState> {
    let stat
    try {
      stat = await lstat(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return Object.freeze({ version: 1, provider: this.defaultProvider })
      }
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
      throw new Error('remote provider state must be a regular file no larger than 4 KiB')
    }
    await restrictPrivateFile(this.file)
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown } catch (error) {
      throw new Error('remote provider state is not valid JSON', { cause: error })
    }
    return parseRemoteProviderState(parsed)
  }

  async save(state: RemoteProviderState): Promise<void> {
    const validated = parseRemoteProviderState(state)
    const directory = dirname(this.file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      const current = await lstat(this.file)
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new Error('remote provider state target must remain a regular file')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = join(directory, `.${basename(this.file)}.${randomBytes(12).toString('hex')}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(validated)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, this.file)
      await restrictPrivateFile(this.file)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}

/** Resolve the first-run provider without letting environment values bypass validation. */
export function configuredRemoteProvider(environment: NodeJS.ProcessEnv): RemoteProvider {
  const value = environment.DSH_MOBILE_REMOTE_PROVIDER ?? 'tailscale'
  if (value !== 'tailscale' && value !== 'cpolar' && value !== 'frp') {
    throw new Error('DSH_MOBILE_REMOTE_PROVIDER must be tailscale, cpolar, or frp')
  }
  return value
}
