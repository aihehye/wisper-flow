import fs from 'node:fs';
import path from 'node:path';
import { SOUND_SLOT_FILES } from '../../shared/defaults';
import type { SoundSlot, SoundSlotStatus } from '../../shared/types';

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export class SoundResolver {
  private readonly bundledDir: string;
  private readonly defaultCustomDir: string;

  constructor(bundledDir: string, customDir = '') {
    this.bundledDir = path.resolve(bundledDir);
    this.defaultCustomDir = customDir.trim();
  }

  resolveSlot(slot: SoundSlot, customDir = this.defaultCustomDir): SoundSlotStatus {
    const spec = SOUND_SLOT_FILES[slot];
    const trimmedCustom = customDir.trim();

    if (trimmedCustom) {
      const customRoot = path.resolve(trimmedCustom);
      const primaryCandidate = path.join(customRoot, spec.primary);
      if (isExistingFile(primaryCandidate)) {
        return {
          slot,
          fileName: spec.primary,
          source: 'custom',
          resolvedPath: primaryCandidate,
        };
      }

      for (const alt of spec.alternates) {
        const altCandidate = path.join(customRoot, alt);
        if (isExistingFile(altCandidate)) {
          return {
            slot,
            fileName: alt,
            source: 'custom',
            resolvedPath: altCandidate,
          };
        }
        // Also check parent folder if user picked a pack subfolder (e.g. .../sounds/v12)
        const parentAlt = path.join(customRoot, '..', alt);
        if (isExistingFile(parentAlt)) {
          return {
            slot,
            fileName: alt,
            source: 'custom',
            resolvedPath: parentAlt,
          };
        }
      }
      const parentPrimary = path.join(customRoot, '..', spec.primary);
      if (isExistingFile(parentPrimary)) {
        return {
          slot,
          fileName: spec.primary,
          source: 'custom',
          resolvedPath: parentPrimary,
        };
      }
    }

    const bundledPath = path.join(this.bundledDir, spec.primary);
    return {
      slot,
      fileName: spec.primary,
      source: 'bundled',
      resolvedPath: bundledPath,
    };
  }

  listStatuses(customDir = this.defaultCustomDir): SoundSlotStatus[] {
    const slots = Object.keys(SOUND_SLOT_FILES) as SoundSlot[];
    return slots.map((slot) => this.resolveSlot(slot, customDir));
  }

  getSlotDataUrl(slot: SoundSlot, customDir = this.defaultCustomDir): string | null {
    const status = this.resolveSlot(slot, customDir);
    if (!isExistingFile(status.resolvedPath)) {
      return null;
    }

    try {
      const wavBytes = fs.readFileSync(status.resolvedPath);
      return `data:audio/wav;base64,${wavBytes.toString('base64')}`;
    } catch {
      return null;
    }
  }
}
