const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

function readBoxes(view, start, end) {
  const boxes = [];
  for (let offset = start; offset + 8 <= end;) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new Error("The M4A file contains a truncated MP4 box.");
      const largeSize = view.getBigUint64(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The M4A file is too large to decode in this browser.");
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) throw new Error("The M4A file contains invalid MP4 box sizes.");
    boxes.push({ type, data: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

function findBox(view, parent, type) {
  return readBoxes(view, parent.data, parent.end).find(box => box.type === type);
}

function hasAudioSampleEntry(buffer, sampleEntry) {
  const view = new DataView(buffer);
  const moov = readBoxes(view, 0, buffer.byteLength).find(box => box.type === "moov");
  if (!moov) throw new Error("The M4A file has no movie metadata.");
  for (const trak of readBoxes(view, moov.data, moov.end).filter(box => box.type === "trak")) {
    const mdia = findBox(view, trak, "mdia");
    if (!mdia) continue;
    const hdlr = findBox(view, mdia, "hdlr");
    if (!hdlr || String.fromCharCode(view.getUint8(hdlr.data + 8), view.getUint8(hdlr.data + 9), view.getUint8(hdlr.data + 10), view.getUint8(hdlr.data + 11)) !== "soun") continue;
    const minf = findBox(view, mdia, "minf");
    const stbl = minf && findBox(view, minf, "stbl");
    const stsd = stbl && findBox(view, stbl, "stsd");
    if (stsd && readBoxes(view, stsd.data + 8, stsd.end).some(box => box.type === sampleEntry)) return true;
  }
  return false;
}

function decodeAlacM4aToWavBlob(buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./m4a-alac-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = event => {
      worker.terminate();
      if (event.data.error) {
        reject(new Error(event.data.error));
        return;
      }
      const { bits, channels, pcm, sampleRate } = event.data;
      const bytesPerSample = bits / 8;
      if (![16, 24].includes(bits) || ![1, 2].includes(channels) || !(pcm instanceof ArrayBuffer) || !pcm.byteLength || pcm.byteLength > MAX_OUTPUT_BYTES || !sampleRate) {
        reject(new Error("This ALAC track uses an unsupported bit depth, channel count, or size."));
        return;
      }
      const header = new ArrayBuffer(44);
      const view = new DataView(header);
      const writeText = (offset, text) => { for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index)); };
      writeText(0, "RIFF");
      view.setUint32(4, 36 + pcm.byteLength, true);
      writeText(8, "WAVEfmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, channels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * channels * bytesPerSample, true);
      view.setUint16(32, channels * bytesPerSample, true);
      view.setUint16(34, bits, true);
      writeText(36, "data");
      view.setUint32(40, pcm.byteLength, true);
      resolve(new Blob([header, pcm], { type: "audio/wav" }));
    };
    worker.onerror = event => {
      worker.terminate();
      reject(new Error(`The ALAC decoder worker failed: ${event.message || "the decoder module could not be loaded."}`));
    };
    worker.postMessage(buffer, [buffer]);
  });
}

function decodeAacM4aToWavBlob(buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./m4a-aac-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = event => {
      worker.terminate();
      if (event.data.error) {
        reject(new Error(event.data.error));
        return;
      }
      const { wav } = event.data;
      if (!(wav instanceof ArrayBuffer) || wav.byteLength < 44 || wav.byteLength > MAX_OUTPUT_BYTES) {
        reject(new Error("The AAC decoder returned invalid or oversized audio."));
        return;
      }
      resolve(new Blob([wav], { type: "audio/wav" }));
    };
    worker.onerror = event => {
      worker.terminate();
      reject(new Error(`The AAC decoder worker failed: ${event.message || "the decoder module could not be loaded."}`));
    };
    worker.postMessage(buffer, [buffer]);
  });
}

async function decodeM4aToWavBlob(blob) {
  if (typeof Worker !== "function") throw new Error("This browser cannot start the background M4A decoder.");
  if (blob.size > MAX_INPUT_BYTES) throw new Error("This M4A exceeds the 512 MB input safety limit for in-browser decoding.");
  const buffer = await blob.arrayBuffer();
  if (hasAudioSampleEntry(buffer, "alac")) return decodeAlacM4aToWavBlob(buffer);
  if (hasAudioSampleEntry(buffer, "mp4a")) return decodeAacM4aToWavBlob(buffer);
  throw new Error("This M4A uses an unsupported audio codec. The local fallback supports ALAC and AAC-LC tracks.");
}

export { decodeM4aToWavBlob };
