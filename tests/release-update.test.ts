import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  PluginReleaseManager,
  comparePluginVersions,
  isRegistryPluginSpec,
  launchedProfileName,
  releaseProfileDirectory,
} from '../src/release-update.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function profileDirectory(spec: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-release-'))
  temporaryDirectories.push(directory)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ dependencies: { 'dsh-mobile': spec } }))
  return directory
}

function releaseFetch(version: string): typeof globalThis.fetch {
  return vi.fn(async input => {
    const url = String(input)
    if (url.includes('registry.npmjs.org')) {
      return new Response(JSON.stringify({ version }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('', {
      status: 302,
      headers: { location: `https://github.com/saya-ch/dsh-mobile/releases/tag/v${version}` },
    })
  }) as unknown as typeof globalThis.fetch
}

describe('profile-local release updates', () => {
  it('compares stable and prerelease SemVer values', () => {
    expect(comparePluginVersions('0.3.3', '0.3.2')).toBe(1)
    expect(comparePluginVersions('0.4.0', '0.3.2')).toBe(1)
    expect(comparePluginVersions('0.4.0-alpha.2', '0.4.0-alpha.1')).toBe(1)
    expect(comparePluginVersions('0.4.0-alpha.1', '0.4.0')).toBe(-1)
    expect(comparePluginVersions('not-a-version', '0.4.0')).toBeUndefined()
  })

  it('updates only npm registry dependencies and resolves the active profile', () => {
    expect(isRegistryPluginSpec('0.4.0')).toBe(true)
    expect(isRegistryPluginSpec('^0.3.2')).toBe(true)
    expect(isRegistryPluginSpec('>=0.3.0 <0.5.0')).toBe(true)
    expect(isRegistryPluginSpec('0.3.x || >=1.0.0 <2.0.0')).toBe(true)
    expect(isRegistryPluginSpec('0.3.0 - 0.4.0')).toBe(true)
    expect(isRegistryPluginSpec('latest')).toBe(true)
    expect(isRegistryPluginSpec('next-1')).toBe(true)
    expect(isRegistryPluginSpec('link:C:/develop/dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('file:../dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('../dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('C:\\develop\\dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('saya-ch/dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('github:saya-ch/dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('npm:dsh-mobile-fork@0.4.0')).toBe(false)
    expect(isRegistryPluginSpec('git://github.com/saya-ch/dsh-mobile.git')).toBe(false)
    expect(isRegistryPluginSpec('git+ssh://git@github.com/saya-ch/dsh-mobile.git')).toBe(false)
    expect(isRegistryPluginSpec('git@github.com:saya-ch/dsh-mobile.git')).toBe(false)
    expect(isRegistryPluginSpec('https://example.com/dsh-mobile.tgz')).toBe(false)
    expect(isRegistryPluginSpec('dsh-mobile-0.4.0.tgz')).toBe(false)
    expect(isRegistryPluginSpec('dsh-mobile-0.4.0.tar')).toBe(false)
    expect(launchedProfileName(['node', 'dsh', '--profile', 'work'])).toBe('work')
    expect(launchedProfileName(['node', 'dsh', '--profile=web'])).toBe('web')
    expect(launchedProfileName(['node', 'dsh'])).toBe('web')
  })

  it('reports plugin and Android releases, then installs into the active profile', async () => {
    const directory = await profileDirectory('^0.3.2')
    const runUpdate = vi.fn(async () => {})
    const manager = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
      runUpdate,
      readInstalledVersion: async () => '0.3.3',
    })

    await expect(manager.status()).resolves.toMatchObject({
      installedVersion: '0.3.2',
      latestVersion: '0.3.3',
      updateAvailable: true,
      updateSupported: true,
      androidVersion: '0.3.3',
      androidDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/v0.3.3/dsh-mobile-android-v0.3.3.apk',
    })
    await expect(manager.update()).resolves.toEqual({ installedVersion: '0.3.3', restartRequired: true })
    expect(runUpdate).toHaveBeenCalledWith(directory, '0.3.3')
  })

  it('uses the launcher-selected Desktop directory instead of the CLI Web profile', async () => {
    const directory = await profileDirectory('^0.3.2')
    const ctx = new Context()
    ctx.provide('desktopRuntime', { platform: 'win32' })
    ctx.provide('desktopProfiles', { current: { name: 'desktop-test', dir: directory } })
    const selectedDirectory = releaseProfileDirectory(ctx, tmpdir(), ['--profile', 'web'])
    expect(selectedDirectory).toBe(directory)
    const runUpdate = vi.fn(async () => {})
    const manager = new PluginReleaseManager({
      profileDirectory: selectedDirectory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
      runUpdate,
      readInstalledVersion: async () => '0.3.3',
    })
    await expect(manager.status()).resolves.toMatchObject({ updateAvailable: true, updateSupported: true })
    await expect(manager.update()).resolves.toEqual({ installedVersion: '0.3.3', restartRequired: true })
    expect(runUpdate).toHaveBeenCalledExactlyOnceWith(directory, '0.3.3')
  })

  it.each([
    undefined,
    {},
    { current: {} },
    { current: { dir: '' } },
    { current: { dir: './profiles/desktop' } },
  ])('disables updating when Desktop has no usable current directory: %j', async profiles => {
    const ctx = new Context()
    ctx.provide('desktopRuntime', { platform: 'win32' })
    if (profiles !== undefined) ctx.provide('desktopProfiles', profiles)
    const selectedDirectory = releaseProfileDirectory(ctx, tmpdir(), ['--profile', 'web'])
    expect(selectedDirectory).toBeUndefined()
    const runUpdate = vi.fn(async () => {})
    const manager = new PluginReleaseManager({
      profileDirectory: selectedDirectory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
      runUpdate,
    })
    await expect(manager.status()).resolves.toMatchObject({
      updateAvailable: false,
      updateSupported: false,
      androidVersion: '0.3.3',
    })
    await expect(manager.update()).rejects.toThrow('plugin_update_unsupported')
    expect(runUpdate).not.toHaveBeenCalled()
  })

  it('does not fall back to Web when only the Desktop profile service is present', () => {
    const ctx = new Context()
    ctx.provide('desktopProfiles', { current: {} })
    expect(releaseProfileDirectory(ctx, tmpdir(), ['--profile', 'web'])).toBeUndefined()
  })

  it('retains default and explicit CLI profile resolution outside Desktop', () => {
    const ctx = new Context()
    expect(releaseProfileDirectory(ctx, tmpdir(), [])).toBe(join(tmpdir(), 'profiles', 'web'))
    expect(releaseProfileDirectory(ctx, tmpdir(), ['--profile', 'work'])).toBe(join(tmpdir(), 'profiles', 'work'))
    expect(releaseProfileDirectory(ctx, tmpdir(), ['--profile=work'])).toBe(join(tmpdir(), 'profiles', 'work'))
  })

  it('never offers to overwrite a linked source checkout', async () => {
    const directory = await profileDirectory('link:C:/develop/dsh-mobile')
    const manager = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
    })

    await expect(manager.status()).resolves.toMatchObject({
      updateAvailable: false,
      updateSupported: false,
      androidVersion: '0.3.3',
    })
    await expect(manager.update()).rejects.toThrow('plugin_update_unsupported')
  })

  it('falls back to the releases page when Android release metadata is unavailable', async () => {
    const directory = await profileDirectory('^0.3.2')
    const fetcher = vi.fn(async input => {
      if (String(input).includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: '0.3.3' }), { status: 200 })
      }
      throw new Error('github unavailable')
    }) as unknown as typeof globalThis.fetch
    const manager = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: fetcher,
    })

    const status = await manager.status()
    expect(status).not.toHaveProperty('androidVersion')
    expect(status.androidDownloadUrl).toBe('https://github.com/saya-ch/dsh-mobile/releases')
  })

  it('runs pnpm.cmd through the fixed Windows command interpreter without shell mode', async () => {
    const directory = await profileDirectory('^0.3.2')
    const start = vi.fn(() => ({
      completion: Promise.resolve({ code: 0, signal: null }),
      terminateTree: vi.fn(async () => {}),
    }))
    const manager = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
      readInstalledVersion: async () => '0.3.3',
      updateProcess: { platform: 'win32', windowsCommandInterpreter: 'C:\\Windows\\System32\\cmd.exe', start },
    })

    await expect(manager.update()).resolves.toEqual({ installedVersion: '0.3.3', restartRequired: true })
    expect(start).toHaveBeenCalledWith({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', 'add', 'dsh-mobile@0.3.3'],
      cwd: directory,
      detached: false,
      platform: 'win32',
      shell: false,
    })
  })

  it.skipIf(process.platform !== 'win32')('launches the real pnpm.cmd shim through cmd.exe', async () => {
    const version = await new Promise<string>((resolveVersion, rejectVersion) => {
      execFile(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', '--version'], {
        windowsHide: true,
        timeout: 10_000,
      }, (error, stdout) => {
        if (error === null) resolveVersion(stdout.trim())
        else rejectVersion(error)
      })
    })
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-.+)?$/u)
  })

  it('terminates the update tree on timeout and waits for process close before rejecting', async () => {
    const directory = await profileDirectory('^0.3.2')
    let completeProcess!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { completeProcess = resolve })
    let expire!: () => void
    const deadline = vi.fn(() => ({
      promise: new Promise<void>(resolve => { expire = resolve }),
      cancel: vi.fn(),
    }))
    const terminateTree = vi.fn(async () => {})
    const start = vi.fn(() => ({ completion, terminateTree }))
    const manager = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
      readInstalledVersion: async () => '0.3.3',
      updateProcess: { platform: 'win32', start, deadline },
    })

    const update = manager.update()
    const observed = update.then(
      () => ({ settled: true, error: undefined }),
      error => ({ settled: true, error }),
    )
    await vi.waitFor(() => { expect(start).toHaveBeenCalledOnce() })
    expire()
    await vi.waitFor(() => { expect(terminateTree).toHaveBeenCalledOnce() })
    let settled = false
    void observed.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    completeProcess({ code: null, signal: 'SIGKILL' })
    const result = await observed
    expect(result.settled).toBe(true)
    expect(result.error).toBeInstanceOf(Error)
    expect((result.error as Error).message).toBe('plugin_update_failed')
  })
})
