import { describe, it, expect } from 'vitest';
import manifestRaw from '../public/manifest.webmanifest?raw';

/**
 * Static guard on the PWA manifest.
 *
 * It exists because the exact failure it checks for already happened once:
 * the manifest referenced /icon-192.png and /icon-512.png for an entire
 * task while neither file existed. Nothing caught it, and an installed iOS
 * PWA is a hard prerequisite for Task 6's Web Push.
 *
 * `import.meta.glob` (a Vite feature, typed by vite/client) is what lets
 * this assert the files are really on disk without pulling in node:fs and
 * @types/node, which client/CLAUDE.md's fixed dependency list excludes.
 */

const publicFiles = import.meta.glob('../public/*.png');

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}

const manifest = JSON.parse(manifestRaw) as {
  readonly icons?: readonly ManifestIcon[];
  readonly display?: string;
  readonly start_url?: string;
};

describe('manifest.webmanifest', () => {
  it('declares both icon sizes', () => {
    expect(manifest.icons?.map((icon) => icon.sizes).sort()).toEqual(['192x192', '512x512']);
  });

  it('references icons that actually exist on disk', () => {
    const present = Object.keys(publicFiles).map((path) => path.replace('../public', ''));
    for (const icon of manifest.icons ?? []) {
      expect(present, `${icon.src} is referenced by the manifest`).toContain(icon.src);
    }
  });

  it('marks the icons maskable, which the artwork is already drawn for', () => {
    // generate-icons.mjs keeps every mark inside a circle of radius 0.4
    // about the centre precisely so an Android adaptive crop cannot clip
    // one. Without this declaration that work goes unused and the launcher
    // letterboxes the icon on a plate instead.
    for (const icon of manifest.icons ?? []) {
      expect(icon.purpose).toBe('any maskable');
    }
  });

  it('stays standalone, which iOS Web Push requires', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
  });
});
