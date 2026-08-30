import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function read(relativePath) {
  return readFile(resolve(root, relativePath), 'utf8')
}

async function readBinary(relativePath) {
  return readFile(resolve(root, relativePath))
}

function singleMatch(source, pattern, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1 || matches[0][1] === undefined) {
    throw new Error(`${label} must appear exactly once`)
  }
  return matches[0][1]
}

function positiveBuildNumber(value, label) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

async function main() {
  const manifest = JSON.parse(await read('package.json'))
  if (typeof manifest.version !== 'string') throw new Error('package.version must be a string')

  const packageVersion = manifest.version
  const packageLock = JSON.parse(await read('package-lock.json'))
  const lockRootVersion = packageLock?.packages?.['']?.version
  if (packageLock?.version !== packageVersion || lockRootVersion !== packageVersion) {
    throw new Error(`package-lock versions ${JSON.stringify(packageLock?.version)} and ${JSON.stringify(lockRootVersion)} must equal package.version ${JSON.stringify(packageVersion)}`)
  }
  const android = await read('apps/mobile/android/app/build.gradle.kts')

  const androidVersion = singleMatch(android, /^\s*versionName\s*=\s*"([^"]+)"\s*$/gm, 'Android versionName')
  const androidBuild = positiveBuildNumber(
    singleMatch(android, /^\s*versionCode\s*=\s*(\d+)\s*$/gm, 'Android versionCode'),
    'Android versionCode',
  )
  if (androidVersion !== packageVersion) {
    throw new Error(`Android versionName ${JSON.stringify(androidVersion)} must equal package.version ${JSON.stringify(packageVersion)}`)
  }

  if (process.argv.includes('--tag-env')) {
    const expectedTag = `v${packageVersion}`
    const actualTag = process.env.GITHUB_REF_NAME
    if (actualTag !== expectedTag) {
      throw new Error(`GITHUB_REF_NAME ${JSON.stringify(actualTag)} must equal ${JSON.stringify(expectedTag)}`)
    }

    const [changelog, readme, englishReadme] = await Promise.all([
      read('CHANGELOG.md'),
      read('README.md'),
      read('README.en.md'),
    ])
    const escapedVersion = packageVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const finalizedHeading = new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`, 'mu')
    if (!finalizedHeading.test(changelog)) {
      throw new Error(`CHANGELOG.md must finalize ${packageVersion} with an ISO release date before tagging`)
    }
    const developmentMarkers = [
      `${packageVersion} 开发中`,
      `${packageVersion}（开发中）`,
      `${packageVersion} 更新（待发布）`,
      `${packageVersion} 尚未发布`,
      `${packageVersion} is in development`,
      `${packageVersion} (in development)`,
      `${packageVersion} update (unreleased)`,
      `${packageVersion} is not published yet`,
    ]
    for (const [source, label] of [[readme, 'README.md'], [englishReadme, 'README.en.md']]) {
      const marker = developmentMarkers.find(candidate => source.includes(candidate))
      if (marker !== undefined) throw new Error(`${label} still marks ${marker} as in development`)
      const apk = `releases/download/v${packageVersion}/dsh-mobile-android-v${packageVersion}.apk`
      const release = `releases/tag/v${packageVersion}`
      if (!source.includes(apk) || !source.includes(release)) {
        throw new Error(`${label} must link the Android download and release notes for ${packageVersion}`)
      }
    }
    for (const screenshot of [
      'assets/screenshots/lan-access.png',
      'assets/screenshots/remote-access.png',
      'assets/screenshots/lan-access-en.png',
      'assets/screenshots/remote-access-en.png',
    ]) {
      if ((await readBinary(screenshot)).byteLength === 0) {
        throw new Error(`${screenshot} must exist and be non-empty before tagging`)
      }
    }
    console.log(`release tag ok: ${actualTag}`)
  }

  console.log(`release versions ok: package=${packageVersion}, Android=${androidVersion} (${androidBuild})`)
}

main().catch((error) => {
  console.error(`release version check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
