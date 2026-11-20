import { LinuxBridge } from './linux';
import type { PlatformBridge } from './types';
import { WindowsBridge } from './windows';

export function createPlatformBridge(): PlatformBridge {
  if (process.platform === 'win32') {
    return new WindowsBridge();
  }
  return new LinuxBridge();
}

export type {
  FocusedTextResult,
  ForegroundAppInfo,
  PlatformBridge,
  PlatformEventHandlers,
  PlatformPasteOptions,
} from './types';
