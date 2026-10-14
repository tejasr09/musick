import { closeTrack, decodeTrack, openTrack } from "./vendor/alac-decoder.mjs";

self.onmessage = event => {
  let track;
  try {
    track = openTrack(new Uint8Array(event.data));
    if (!track) throw new Error("The M4A did not contain an ALAC audio track.");
    if (![16, 24].includes(track.bits) || ![1, 2].includes(track.channels)) {
      throw new Error("The ALAC fallback supports 16-bit or 24-bit mono and stereo tracks.");
    }
    const outputBytes = track.samples * track.bytesPerSample;
    if (!Number.isSafeInteger(outputBytes) || outputBytes > 256 * 1024 * 1024) {
      throw new Error("Decoded ALAC audio would exceed the 256 MB WAV safety limit.");
    }
    const pcm = decodeTrack(track, 0, track.samples);
    if (!pcm.byteLength || pcm.byteLength !== outputBytes) {
      throw new Error("The ALAC decoder returned incomplete PCM audio.");
    }
    self.postMessage({
      bits: track.bits,
      channels: track.channels,
      pcm: pcm.buffer,
      sampleRate: track.sampleRate
    }, [pcm.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  } finally {
    if (track) closeTrack(track);
  }
};
