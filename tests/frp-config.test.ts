import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FrpConfigStore,
  createFrpServerTemplate,
  createFrpcToml,
  parseFrpSettings,
} from '../src/frp-config.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const input = {
  serverAddress: 'frp.example.com',
  serverPort: 7000,
  token: '0123456789abcdef0123456789abcdef',
  publicOrigin: 'https://dsh.example.com',
}

describe('restricted FRP configuration', () => {
  it('accepts only the fixed single-purpose inputs', () => {
    expect(parseFrpSettings(input)).toEqual({ version: 1, ...input })
    expect(() => parseFrpSettings({ ...input, publicOrigin: 'http://dsh.example.com' })).toThrow('frp_public_origin_invalid')
    expect(() => parseFrpSettings({ ...input, publicOrigin: 'https://127.0.0.1' })).toThrow('frp_public_origin_invalid')
    expect(() => parseFrpSettings({ ...input, token: 'too-short' })).toThrow('frp_token_invalid')
    expect(() => parseFrpSettings({ ...input, localPort: 3080 })).toThrow('frp_settings_invalid')
  })

  it('generates one encrypted HTTP vhost and a loopback-only server template', () => {
    const settings = parseFrpSettings(input)
    const client = createFrpcToml(settings, 42123)
    expect(client).toContain('type = "http"')
    expect(client).toContain('localIP = "127.0.0.1"')
    expect(client).toContain('localPort = 42123')
    expect(client).toContain('customDomains = ["dsh.example.com"]')
    expect(client).toContain('transport.useEncryption = true')
    expect(client).not.toMatch(/tcp|udp|plugin/u)

    const server = createFrpServerTemplate(settings)
    expect(server).toContain('proxyBindAddr = "127.0.0.1"')
    expect(server).toContain('vhostHTTPPort = 7080')
    expect(server).toContain('reverse_proxy 127.0.0.1:7080')
  })

  it('keeps the token private and removes all owned configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-config-'))
    temporaryDirectories.push(directory)
    const store = new FrpConfigStore(join(directory, 'frp'))
    await store.initialize()
    expect(store.status()).toMatchObject({ configured: false, vhostHttpPort: 7080 })
    await store.configure(input)
    expect(store.status()).toMatchObject({
      configured: true,
      serverAddress: input.serverAddress,
      serverPort: input.serverPort,
      publicOrigin: input.publicOrigin,
    })
    expect(JSON.stringify(store.status())).not.toContain(input.token)
    expect(await readFile(store.settingsFile, 'utf8')).toContain(input.token)
    await store.writeRuntimeConfig(41234)
    expect((await lstat(store.runtimeConfigFile)).isFile()).toBe(true)
    await store.purge()
    expect(store.status()).toMatchObject({ configured: false })
    await expect(lstat(store.settingsFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
