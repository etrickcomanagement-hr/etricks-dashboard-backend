'use strict';
const { HttpError } = require('./util');

/*
 * Pictures and voice notes in the client chat.
 * - They travel as base64 inside the JSON request, and are stored in the database (so every backup holds them).
 * - The file type is decided from the first bytes of the file, never from what the sender says it is. Only these are accepted:
 *   pictures: JPEG, PNG, GIF, WebP        voice: WebM, Ogg (Opus), MP4/M4A, MP3, WAV
 *   Nothing that a browser could run (SVG, HTML ...) is ever accepted.
 */
const MAX_IMAGE = 4 * 1024 * 1024; // bytes after decoding
const MAX_AUDIO = 3 * 1024 * 1024;
const MAX_BODY = 8_000_000; // the request (base64 is a third bigger than the file)

const ascii = (b, from, to) => b.subarray(from, to).toString('latin1');

// -> { kind: 'image' | 'audio', mime } or null
function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return { kind: 'image', mime: 'image/png' };
  if (ascii(b, 0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'audio', mime: 'audio/webm' };
  if (ascii(b, 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg' };
  if (ascii(b, 4, 8) === 'ftyp') return { kind: 'audio', mime: 'audio/mp4' };
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav' };
  return null;
}

// The attachment of a request body ({ data: base64 }) -> { kind, mime, data: Buffer, size }, or null when there is none.
function parse(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'object' || typeof raw.data !== 'string') throw new HttpError(400, 'The attachment is not valid');
  const text = raw.data.replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/\r\n]+=*\s*$/.test(text)) throw new HttpError(400, 'The attachment is not valid');
  const data = Buffer.from(text, 'base64');
  const type = sniff(data);
  if (!type) throw new HttpError(400, 'Only pictures (JPEG, PNG, GIF, WebP) and voice notes can be sent');
  if (type.kind === 'image' && data.length > MAX_IMAGE) throw new HttpError(400, `The picture is too big (the most is ${MAX_IMAGE / 1048576} MB)`);
  if (type.kind === 'audio' && data.length > MAX_AUDIO) throw new HttpError(400, `The voice note is too big (the most is ${MAX_AUDIO / 1048576} MB, about 5 minutes)`);
  return { kind: type.kind, mime: type.mime, data, size: data.length };
}

// Answers a request for a stored file, with byte ranges (a browser needs them to play and skip through a voice note).
function serve(ctx, att) {
  const headers = {
    'Content-Type': att.mime, 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin',
  };
  const buf = att.data;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(ctx.req.headers.range || ''));
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start = m[1] === '' ? Math.max(0, buf.length - Number(m[2])) : Number(m[1]);
    let end = m[1] === '' || m[2] === '' ? buf.length - 1 : Math.min(Number(m[2]), buf.length - 1);
    if (start > end || start >= buf.length) return ctx.raw(416, { ...headers, 'Content-Range': `bytes */${buf.length}` }, Buffer.alloc(0));
    return ctx.raw(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${buf.length}` }, buf.subarray(start, end + 1));
  }
  return ctx.raw(200, headers, buf);
}

module.exports = { parse, serve, sniff, MAX_BODY, MAX_IMAGE, MAX_AUDIO };
