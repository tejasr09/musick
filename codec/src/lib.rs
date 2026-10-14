use std::io::Cursor;
use std::mem;
use std::slice;

use symphonia::core::codecs::audio::{well_known::CODEC_ID_AAC, AudioDecoderOptions};
use symphonia::core::errors::Error;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::formats::probe::Hint;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

const STATUS_OK: u32 = 0;
const STATUS_INVALID_FILE: u32 = 1;
const STATUS_NOT_AAC: u32 = 2;
const STATUS_UNSUPPORTED_AAC: u32 = 3;
const STATUS_DECODE_FAILED: u32 = 4;
const STATUS_OUTPUT_TOO_LARGE: u32 = 5;
const MAX_WAV_BYTES: usize = 256 * 1024 * 1024;

#[repr(C)]
pub struct InputBuffer {
    bytes: Box<[u8]>,
}

#[repr(C)]
pub struct DecodeOutput {
    status: u32,
    wav: Box<[u8]>,
}

fn output(status: u32, wav: Vec<u8>) -> *mut DecodeOutput {
    Box::into_raw(Box::new(DecodeOutput {
        status,
        wav: wav.into_boxed_slice(),
    }))
}

fn decode(input: &[u8]) -> Result<Vec<u8>, u32> {
    let source = MediaSourceStream::new(Box::new(Cursor::new(input)), Default::default());
    let hint = Hint::new();
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|_| STATUS_INVALID_FILE)?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or(STATUS_NOT_AAC)?;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .ok_or(STATUS_NOT_AAC)?;
    if params.codec != CODEC_ID_AAC {
        return Err(STATUS_NOT_AAC);
    }
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|_| STATUS_UNSUPPORTED_AAC)?;
    let track_id = track.id;
    let mut wav = vec![0; 44];
    let mut sample_rate = None;
    let mut channels = None;

    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(_) => return Err(STATUS_INVALID_FILE),
        };
        if packet.track_id != track_id {
            continue;
        }
        let audio = decoder.decode(&packet).map_err(|error| match error {
            Error::DecodeError(_) => STATUS_UNSUPPORTED_AAC,
            _ => STATUS_DECODE_FAILED,
        })?;
        let rate = audio.spec().rate();
        let channel_count = audio.spec().channels().count() as u16;
        if rate == 0 || channel_count == 0 || channel_count > 2 {
            return Err(STATUS_UNSUPPORTED_AAC);
        }
        if sample_rate.is_some_and(|known| known != rate)
            || channels.is_some_and(|known| known != channel_count)
        {
            return Err(STATUS_UNSUPPORTED_AAC);
        }
        sample_rate = Some(rate);
        channels = Some(channel_count);

        let sample_count = audio.samples_interleaved();
        let packet_bytes = sample_count
            .checked_mul(mem::size_of::<f32>())
            .ok_or(STATUS_OUTPUT_TOO_LARGE)?;
        if wav.len().checked_add(packet_bytes).is_none_or(|size| size > MAX_WAV_BYTES) {
            return Err(STATUS_OUTPUT_TOO_LARGE);
        }
        let mut samples = vec![0.0f32; sample_count];
        audio.copy_to_slice_interleaved(&mut samples);
        wav.reserve(packet_bytes);
        for sample in samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
    }

    let rate = sample_rate.ok_or(STATUS_DECODE_FAILED)?;
    let channel_count = channels.ok_or(STATUS_DECODE_FAILED)?;
    let data_size = u32::try_from(wav.len() - 44).map_err(|_| STATUS_OUTPUT_TOO_LARGE)?;
    let byte_rate = rate
        .checked_mul(channel_count as u32)
        .and_then(|value| value.checked_mul(4))
        .ok_or(STATUS_UNSUPPORTED_AAC)?;
    let block_align = channel_count.checked_mul(4).ok_or(STATUS_UNSUPPORTED_AAC)?;

    wav[0..4].copy_from_slice(b"RIFF");
    wav[4..8].copy_from_slice(&(data_size + 36).to_le_bytes());
    wav[8..16].copy_from_slice(b"WAVEfmt ");
    wav[16..20].copy_from_slice(&16u32.to_le_bytes());
    wav[20..22].copy_from_slice(&3u16.to_le_bytes());
    wav[22..24].copy_from_slice(&channel_count.to_le_bytes());
    wav[24..28].copy_from_slice(&rate.to_le_bytes());
    wav[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    wav[32..34].copy_from_slice(&block_align.to_le_bytes());
    wav[34..36].copy_from_slice(&32u16.to_le_bytes());
    wav[36..40].copy_from_slice(b"data");
    wav[40..44].copy_from_slice(&data_size.to_le_bytes());

    Ok(wav)
}

#[no_mangle]
pub extern "C" fn alloc_input(size: u32) -> *mut InputBuffer {
    Box::into_raw(Box::new(InputBuffer {
        bytes: vec![0; size as usize].into_boxed_slice(),
    }))
}

#[no_mangle]
pub unsafe extern "C" fn input_data(handle: *mut InputBuffer) -> *mut u8 {
    if handle.is_null() {
        return std::ptr::null_mut();
    }
    (*handle).bytes.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn free_input(handle: *mut InputBuffer) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

#[no_mangle]
pub unsafe extern "C" fn decode_aac(ptr: *const u8, size: u32) -> *mut DecodeOutput {
    if ptr.is_null() || size == 0 {
        return output(STATUS_INVALID_FILE, Vec::new());
    }
    let bytes = slice::from_raw_parts(ptr, size as usize);
    match decode(bytes) {
        Ok(wav) => output(STATUS_OK, wav),
        Err(status) => output(status, Vec::new()),
    }
}

#[no_mangle]
pub unsafe extern "C" fn output_status(handle: *const DecodeOutput) -> u32 {
    if handle.is_null() {
        return STATUS_DECODE_FAILED;
    }
    (*handle).status
}

#[no_mangle]
pub unsafe extern "C" fn output_data(handle: *const DecodeOutput) -> *const u8 {
    if handle.is_null() {
        return std::ptr::null();
    }
    (*handle).wav.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn output_len(handle: *const DecodeOutput) -> u32 {
    if handle.is_null() {
        return 0;
    }
    (&(*handle).wav).len() as u32
}

#[no_mangle]
pub unsafe extern "C" fn free_output(handle: *mut DecodeOutput) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}
