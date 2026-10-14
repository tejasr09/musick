const MAX_INPUT_BYTES = 512 * 1024 * 1024;

const decoderMessages = {
  1: "The AAC M4A container is invalid or incomplete.",
  2: "The M4A does not contain a supported AAC audio track.",
  3: "The local AAC decoder supports AAC-LC only; this file may use another AAC profile or channel layout.",
  4: "The AAC track could not be decoded.",
  5: "Decoded AAC audio exceeds the 256 MB safety limit."
};

async function loadDecoder() {
  const response = await fetch(new URL("./vendor/m4a-aac.wasm", import.meta.url));
  if (!response.ok) throw new Error(`AAC decoder download failed with HTTP ${response.status}.`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
  return instance.exports;
}

self.onmessage = async event => {
  const buffer = event.data;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0 || buffer.byteLength > MAX_INPUT_BYTES) {
    self.postMessage({ error: "The AAC M4A input is empty or exceeds the 512 MB safety limit." });
    return;
  }

  let exports;
  let inputHandle;
  let inputPtr;
  let outputHandle;
  try {
    exports = await loadDecoder();
    inputHandle = exports.alloc_input(buffer.byteLength);
    inputPtr = exports.input_data(inputHandle);
    new Uint8Array(exports.memory.buffer, inputPtr, buffer.byteLength).set(new Uint8Array(buffer));
    outputHandle = exports.decode_aac(inputPtr, buffer.byteLength);
    const status = exports.output_status(outputHandle);
    if (status !== 0) throw new Error(decoderMessages[status] || "The AAC decoder failed unexpectedly.");
    const dataPtr = exports.output_data(outputHandle);
    const dataLength = exports.output_len(outputHandle);
    const wav = new Uint8Array(exports.memory.buffer, dataPtr, dataLength).slice().buffer;
    self.postMessage({ wav }, [wav]);
  } catch (error) {
    self.postMessage({ error: error.message || "The AAC decoder failed unexpectedly." });
  } finally {
    if (exports && inputHandle) exports.free_input(inputHandle);
    if (exports && outputHandle) exports.free_output(outputHandle);
  }
};
