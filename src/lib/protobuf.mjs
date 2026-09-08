/**
 * The smallest protobuf reader that answers one question: what is in this blob,
 * when nobody shipped us a `.proto`?
 *
 * The wire format carries field numbers and wire types but no names, so this
 * indexes everything by dotted field path (`1.4.2`) and leaves the meaning to
 * the caller. A length-delimited field is ambiguous by design — the same bytes
 * may be a nested message, a string, or neither — so it is recorded as whatever
 * it successfully parses as, sometimes both. Reading by a known path is
 * therefore exact; guessing from the shape is not, which is why the caller
 * checks invariants rather than trusting a field number alone.
 *
 * Bounded on purpose: a hostile or simply unlucky blob must not turn a hook
 * into an unbounded walk.
 */

function readVarint(b, i) {
  let result = 0;
  let shift = 0;
  while (i < b.length) {
    const byte = b[i++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7;
    if (shift > 63) throw new RangeError("varint too long");
  }
  throw new RangeError("truncated varint");
}

/** True when the bytes decode as UTF-8 without control characters. */
function asString(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  if (text.length === 0) return null;
  if (Buffer.byteLength(text, "utf8") !== bytes.length) return null; // lossy: not text
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return null;
  }
  return text;
}

/**
 * Could these bytes be a message? A purely structural check that allocates
 * nothing and mutates nothing, so a string that merely looks like a submessage
 * costs one extra scan instead of a rollback of everything found so far.
 */
function looksLikeMessage(buf) {
  if (buf.length === 0) return false;
  let i = 0;
  while (i < buf.length) {
    let key;
    try {
      [key, i] = readVarint(buf, i);
    } catch {
      return false;
    }
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 0) return false;
    if (wire === 0) {
      try {
        [, i] = readVarint(buf, i);
      } catch {
        return false;
      }
    } else if (wire === 1) {
      if (i + 8 > buf.length) return false;
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return false;
      i += 4;
    } else if (wire === 2) {
      let length;
      try {
        [length, i] = readVarint(buf, i);
      } catch {
        return false;
      }
      if (i + length > buf.length) return false;
      i += length;
    } else {
      return false;
    }
  }
  return true;
}

/** Thrown when the node budget runs out; distinct from "these bytes are not protobuf". */
class BudgetExceeded extends Error {}

export function scan(bytes, { maxDepth = 8, maxNodes = 200_000 } = {}) {
  const varints = new Map();
  const strings = new Map();
  const submessages = new Map();
  let nodes = 0;

  const push = (map, path, value) => {
    const list = map.get(path);
    if (list) list.push(value);
    else map.set(path, [value]);
  };

  const walk = (buf, prefix, depth) => {
    let i = 0;
    while (i < buf.length) {
      if (++nodes > maxNodes) throw new BudgetExceeded();
      let key;
      [key, i] = readVarint(buf, i);
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (field === 0) throw new RangeError("field number 0");
      const path = prefix ? `${prefix}.${field}` : String(field);

      if (wire === 0) {
        let value;
        [value, i] = readVarint(buf, i);
        push(varints, path, value);
      } else if (wire === 1) {
        if (i + 8 > buf.length) throw new RangeError("truncated fixed64");
        i += 8;
      } else if (wire === 5) {
        if (i + 4 > buf.length) throw new RangeError("truncated fixed32");
        i += 4;
      } else if (wire === 2) {
        let length;
        [length, i] = readVarint(buf, i);
        if (i + length > buf.length) throw new RangeError("truncated bytes");
        const payload = buf.subarray(i, i + length);
        i += length;
        if (depth < maxDepth && looksLikeMessage(payload)) {
          walk(payload, path, depth + 1);
          push(submessages, path, payload);
        }
        const text = asString(payload);
        if (text !== null) push(strings, path, text);
      } else {
        throw new RangeError(`unsupported wire type ${wire}`);
      }
    }
  };

  try {
    walk(Buffer.from(bytes), "", 0);
  } catch (err) {
    // A budget overflow keeps whatever was indexed before the cap; anything
    // else means these bytes were never protobuf, and yield nothing at all.
    if (!(err instanceof BudgetExceeded)) {
      return { varints: new Map(), strings: new Map(), submessages: new Map() };
    }
  }
  return { varints, strings, submessages };
}
