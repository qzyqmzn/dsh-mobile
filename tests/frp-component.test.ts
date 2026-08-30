import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FRP_COMPONENT_RELEASES,
  FrpComponentManager,
  selectFrpExecutableEntry,
} from '../src/frp-component.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('managed FRP component', () => {
  it('pins official artifacts for each supported desktop target', () => {
    expect(Object.keys(FRP_COMPONENT_RELEASES).sort()).toEqual([
      'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
    ])
    for (const release of Object.values(FRP_COMPONENT_RELEASES)) {
      expect(release.downloadUrl).toMatch(/^https:\/\/github\.com\/fatedier\/frp\/releases\/download\/v0\.70\.1\//u)
      expect(release.downloadSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(release.downloadBytes).toBeGreaterThan(10_000_000)
    }
  })

  it('recognizes only the managed version and purges all owned files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-component-'))
    temporaryDirectories.push(directory)
    const manager = new FrpComponentManager({
      stateDirectory: directory,
      platform: 'win32',
      arch: 'x64',
      inspectExecutable: async () => '0.70.1',
    })
    await mkdir(dirname(manager.executable), { recursive: true })
    await writeFile(manager.executable, 'fake-frpc')
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: true, installed: true, version: '0.70.1' })
    await manager.purge()
    expect(manager.status()).toMatchObject({ supported: true, installed: false, installedBytes: 0 })
  })

  it('reports unsupported targets without downloading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-component-'))
    temporaryDirectories.push(directory)
    const manager = new FrpComponentManager({ stateDirectory: directory, platform: 'freebsd', arch: 'x64' })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: false, installed: false })
    await expect(manager.install()).rejects.toThrow('frp_component_unsupported')
  })

  it('accepts the official top-level directory while rejecting archive escapes', () => {
    expect(selectFrpExecutableEntry([
      'frp_0.70.1_windows_amd64/',
      'frp_0.70.1_windows_amd64/LICENSE',
      'frp_0.70.1_windows_amd64/frpc.exe',
    ], 'frpc.exe')).toBe('frp_0.70.1_windows_amd64/frpc.exe')
    expect(() => selectFrpExecutableEntry([
      'frp_0.70.1_windows_amd64/',
      '../frpc.exe',
    ], 'frpc.exe')).toThrow('frp_archive_path_invalid')
  })
})
