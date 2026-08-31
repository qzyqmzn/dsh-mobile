import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { Loader, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'

const auto = '@deepseek-ai/dsh-host-directory-picker-auto'
const browseHost = '@deepseek-ai/dsh-host-directory-picker-browse'
const browseSurface = '@deepseek-ai/dsh-client-ui-directory-picker-browse'
const platforms = ['win32', 'darwin', 'linux'] as const
type Platform = typeof platforms[number]

const mobilePatches = yaml.load(
  readFileSync(resolve(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'),
  { schema: entryListSchema },
) as PatchOptions[]

// dsh-desktop e71a9ef0, dsh-plugin-desktop/src/profile.ts:986-1008.
// Desktop appends this Windows-only layer after user bundle patches.
const desktopWindowsPatches: PatchOptions[] = [
  { id: 'directory-picker', name: auto, disabled: true },
  { insert: [
    { id: 'desktop-directory-picker-browse-host', name: browseHost },
    { id: 'desktop-directory-picker-browse-surface', name: browseSurface },
  ] },
]

function compose(desktop: boolean, platform: Platform, desktopFirst = false, legacy = false): EntryOptions[] {
  const mobile = structuredClone(mobilePatches)
  if (legacy) {
    for (const patch of mobile) {
      for (const entry of patch.insert ?? []) {
        if (entry.id === 'directory-picker-mobile-host' || entry.id === 'directory-picker-mobile-surface') {
          delete entry.disabled
        }
      }
    }
  }
  const desktopLayer = desktop && platform === 'win32' ? desktopWindowsPatches : []
  const patches = desktopFirst ? [...desktopLayer, ...mobile] : [...mobile, ...desktopLayer]
  const warn = vi.fn()
  const entries = applyEntryPatches([{ id: 'directory-picker', name: auto }], patches, warn)
  expect(warn).not.toHaveBeenCalled()
  // The gateway is outside this directory-picker composition test.
  return applyEntryPatches(entries, [{ id: 'mobile-access', disabled: true }], warn)
}

async function withPickerHost(
  desktop: boolean,
  platform: Platform,
  run: (ctx: Context, loader: Loader, providers: Set<string>, surfaces: Set<string>) => Promise<void>,
): Promise<void> {
  // Scope only the expression evaluator's process.platform, not Node's globals.
  const ctx = new Context().extend({ process: { platform } })
  if (desktop) ctx.provide('desktopRuntime', { platform })
  await ctx.plugin(Loader).await()
  const loader = ctx.loader
  const providers = new Set<string>()
  const surfaces = new Set<string>()

  class BrowseDirectoryPicker extends Service {
    readonly owner: string

    constructor(pickerContext: Context) {
      // Real Cordis registration reproduces the fixed-name collision from #22.
      super(pickerContext, 'directoryPicker')
      this.owner = pickerContext.fiber.entry!.options.id
      pickerContext.effect(() => {
        providers.add(this.owner)
        return () => { providers.delete(this.owner) }
      })
    }
  }

  const surface = {
    apply(surfaceContext: Context) {
      const owner = surfaceContext.fiber.entry!.options.id
      surfaceContext.effect(() => {
        surfaces.add(owner)
        return () => { surfaces.delete(owner) }
      })
    },
  }
  const imports = vi.spyOn(loader, 'import').mockImplementation(async name => {
    if (name === browseHost) return BrowseDirectoryPicker
    if (name === browseSurface) return surface
    throw new Error(`unexpected picker harness import: ${name}`)
  })

  try {
    await run(ctx, loader, providers, surfaces)
  } finally {
    await loader.root.stop()
    await ctx.fiber.dispose()
    imports.mockRestore()
  }
  expect(providers.size).toBe(0)
  expect(surfaces.size).toBe(0)
}

describe('directory picker host composition', () => {
  it.each(platforms)('keeps the in-page picker for stock Web on %s', async platform => {
    await withPickerHost(false, platform, async (ctx, loader, providers, surfaces) => {
      await loader.root.update(compose(false, platform))
      await loader.await()
      expect(ctx.get('directoryPicker')).toMatchObject({ owner: 'directory-picker-mobile-host' })
      expect([...providers]).toEqual(['directory-picker-mobile-host'])
      expect([...surfaces]).toEqual(['directory-picker-mobile-surface'])
      expect(loader.resolve('directory-picker').disabled).toBe(true)
    })
  })

  it.each([false, true])('reuses the Windows Desktop pair (Desktop layer first: %s)', async desktopFirst => {
    await withPickerHost(true, 'win32', async (ctx, loader, providers, surfaces) => {
      await loader.root.update(compose(true, 'win32', desktopFirst))
      await loader.await()
      expect(ctx.get('directoryPicker')).toMatchObject({ owner: 'desktop-directory-picker-browse-host' })
      expect([...providers]).toEqual(['desktop-directory-picker-browse-host'])
      expect([...surfaces]).toEqual(['desktop-directory-picker-browse-surface'])
      expect(loader.resolve('directory-picker-mobile-host').disabled).toBe(true)
      expect(loader.resolve('directory-picker-mobile-surface').disabled).toBe(true)
      expect(loader.resolve('directory-picker').disabled).toBe(true)
    })
  })

  it.each(['darwin', 'linux'] as const)('retains the Mobile pair on Desktop %s', async platform => {
    await withPickerHost(true, platform, async (ctx, loader, providers, surfaces) => {
      await loader.root.update(compose(true, platform))
      await loader.await()
      expect(ctx.get('directoryPicker')).toMatchObject({ owner: 'directory-picker-mobile-host' })
      expect([...providers]).toEqual(['directory-picker-mobile-host'])
      expect([...surfaces]).toEqual(['directory-picker-mobile-surface'])
      expect(loader.resolve('directory-picker').disabled).toBe(true)
    })
  })

  it('reproduces the reported duplicate service without the two Mobile conditions', async () => {
    await withPickerHost(true, 'win32', async (_ctx, loader) => {
      await expect(loader.root.update(compose(true, 'win32', false, true)))
        .rejects.toThrow('service "directoryPicker" has been registered')
    })
  })
})
