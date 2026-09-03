import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const commands = vi.hoisted(() => ({
  exec: vi.fn(),
  chmod: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('node:child_process', () => ({ execFile: commands.exec }))
vi.mock('node:fs/promises', () => ({ chmod: commands.chmod }))

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  commands.exec.mockReset()
  commands.chmod.mockClear()
  commands.exec.mockImplementation((file, _args, _options, callback) => {
    callback(null, file === 'whoami.exe' ? '"desktop\\user","S-1-5-21-123-456-789-1001"\r\n' : '', '')
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('Windows private files under a desktop execFile wrapper', () => {
  it('resolves a SID and still applies restrictive ACLs', async () => {
    const { restrictPrivateFile } = await import('../src/private-file.js')
    await restrictPrivateFile('fixture.json')
    expect(commands.chmod).toHaveBeenCalledWith('fixture.json', 0o600)
    expect(commands.exec).toHaveBeenLastCalledWith('icacls.exe', expect.arrayContaining([
      'fixture.json', '/inheritance:r', '*S-1-5-21-123-456-789-1001:(F)', '/remove:g', '*S-1-1-0',
    ]), expect.objectContaining({ timeout: 10_000, windowsHide: true }), expect.any(Function))
    await restrictPrivateFile('second.json')
    expect(commands.exec.mock.calls.filter(call => call[0] === 'whoami.exe')).toHaveLength(1)
  })

  it('rejects an invalid SID without running icacls and retries on the next request', async () => {
    commands.exec.mockImplementationOnce((_file, _args, _options, callback) => callback(null, 'invalid SID', ''))
    const { restrictPrivateFile } = await import('../src/private-file.js')
    await expect(restrictPrivateFile('fixture.json')).rejects.toThrow('unable to resolve the current Windows user SID')
    expect(commands.exec).toHaveBeenCalledTimes(1)
    await expect(restrictPrivateFile('fixture.json')).resolves.toBeUndefined()
    expect(commands.exec).toHaveBeenCalledTimes(3)
  })

  it('does not report success when applying the ACL fails', async () => {
    commands.exec.mockImplementation((file, _args, _options, callback) => {
      callback(file === 'icacls.exe' ? new Error('ACL denied') : null, '"user","S-1-5-21-123"', '')
    })
    const { restrictPrivateFile } = await import('../src/private-file.js')
    await expect(restrictPrivateFile('fixture.json')).rejects.toThrow('ACL denied')
  })
})
