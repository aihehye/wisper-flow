import type { SoundSlot } from '@shared/types';

class LowLatencyAudioPlayer {
  private ctx: AudioContext | null = null;
  private cache = new Map<string, AudioBuffer>();
  private inflight = new Map<string, Promise<AudioBuffer | null>>();

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private cacheKey(slot: SoundSlot, dataUrl: string): string {
    return `${slot}::${dataUrl}`;
  }

  private decodeDataUrlToBytes(dataUrl: string): ArrayBuffer | null {
    if (!dataUrl.startsWith('data:')) return null;
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return null;
    const header = dataUrl.slice(0, commaIdx);
    const body = dataUrl.slice(commaIdx + 1);
    if (header.includes(';base64')) {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes.buffer;
    }
    const decoded = decodeURIComponent(body);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) {
      bytes[i] = decoded.charCodeAt(i);
    }
    return bytes.buffer;
  }

  async preload(slot: SoundSlot, dataUrl: string): Promise<AudioBuffer | null> {
    if (!dataUrl) return null;
    const key = this.cacheKey(slot, dataUrl);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const task = (async (): Promise<AudioBuffer | null> => {
      const ctx = this.getContext();
      if (!ctx) return null;
      try {
        let arrayBuf = this.decodeDataUrlToBytes(dataUrl);
        if (!arrayBuf) {
          const resp = await fetch(dataUrl);
          arrayBuf = await resp.arrayBuffer();
        }
        const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
        // Evict stale buffers for the same slot if custom folder changed
        for (const existingKey of this.cache.keys()) {
          if (existingKey.startsWith(`${slot}::`) && existingKey !== key) {
            this.cache.delete(existingKey);
          }
        }
        this.cache.set(key, decoded);
        return decoded;
      } catch {
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, task);
    return task;
  }

  async play(slot: SoundSlot, dataUrl: string, volume = 0.85): Promise<void> {
    if (!dataUrl) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const key = this.cacheKey(slot, dataUrl);
    let buffer: AudioBuffer | null | undefined = this.cache.get(key);
    if (!buffer) {
      buffer = await this.preload(slot, dataUrl);
    }
    if (!buffer) return;

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        return;
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));

    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);
  }
}

export const audioPlayer = new LowLatencyAudioPlayer();
