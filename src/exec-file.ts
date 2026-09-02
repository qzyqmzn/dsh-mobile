import { execFile, type ExecFileOptions } from 'node:child_process'

/** Capture both output streams even when a desktop host wraps execFile without Node's promisify metadata. */
export function execFileText(
  file: string,
  args: readonly string[],
  options: Omit<ExecFileOptions, 'encoding'> & { encoding?: 'utf8' } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { windowsHide: true, ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) { reject(error); return }
      if (typeof stdout !== 'string' || typeof stderr !== 'string') {
        reject(new Error('subprocess returned invalid text output'))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}
