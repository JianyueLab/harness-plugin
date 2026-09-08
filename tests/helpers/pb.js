/** Minimal protobuf *encoder*, for building test fixtures. */
export function varint(n) {
  const out = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

const tag = (num, wire) => varint((num << 3) | wire);

/** Varint field: `vint(2, 26404)`. */
export const vint = (num, value) => Buffer.concat([tag(num, 0), varint(value)]);

/** Length-delimited field from raw bytes: `bytes(4, submessage)`. */
export const bytes = (num, buf) => Buffer.concat([tag(num, 2), varint(buf.length), buf]);

/** Length-delimited field from a string: `str(19, "gemini-3.8-flash")`. */
export const str = (num, s) => bytes(num, Buffer.from(s, "utf8"));

/** Concatenate fields into one message body. */
export const msg = (...parts) => Buffer.concat(parts);
