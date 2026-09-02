import { chmod } from 'node:fs/promises'
import { execFileText as execFile } from './exec-file.js'

let userSidTask: Promise<string> | undefined

async function currentWindowsUserSid(): Promise<string> {
  userSidTask ??= execFile('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  }).then(({ stdout }) => {
    const match = /,"(S-\d(?:-\d+)+)"\s*$/u.exec(stdout.trim())
    if (match?.[1] === undefined) throw new Error('unable to resolve the current Windows user SID')
    return match[1]
  }).catch((error: unknown) => {
    userSidTask = undefined
    throw error
  })
  return userSidTask
}

/** Restrict a sensitive regular file to the current user and Windows administrators. */
export async function restrictPrivateFile(file: string, mode = 0o600): Promise<void> {
  await chmod(file, mode)
  if (process.platform !== 'win32') return
  const userSid = await currentWindowsUserSid()
  await execFile('icacls.exe', [
    file,
    '/inheritance:r',
    '/grant:r',
    `*${userSid}:(F)`,
    '*S-1-5-18:(F)',
    '*S-1-5-32-544:(F)',
    '/remove:g',
    '*S-1-1-0',
    '*S-1-5-11',
    '*S-1-5-32-545',
  ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
}
