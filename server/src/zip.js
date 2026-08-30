import zlib from 'node:zlib';

// A minimal ZIP writer, for the one archive this server produces: the Install Kit.
//
// No dependency, for the same reason there is no i18n package and no TOTP package — what is needed
// here is one function over a format that has not changed since 1993. Deliberately the boring subset:
// deflate or store, no encryption, no ZIP64, no data descriptors. The Install Kit is a 273 KB exe and
// four text files; none of the corners a general-purpose library exists to handle are reachable from
// here, and the ones that are (a >4 GB member, a non-ASCII filename) are asserted against below rather
// than silently mis-encoded.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0 — the version that introduced deflate.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let c = ~0;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

/**
 * MS-DOS date and time, which is what a ZIP central directory stores.
 *
 * Two-second resolution and an epoch of 1980, so anything older than that clamps rather than wrapping
 * into a date from the future — an extracted file dated 2107 is the kind of thing that makes a parent
 * distrust the whole download.
 */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

/**
 * Build a ZIP from `entries` — `{ name, data, mtime }`, all at the archive root.
 *
 * Members are deflated unless that makes them bigger, which it does for an already-compressed member
 * and for very short ones. Falling back to store keeps the archive smaller than a blanket deflate and
 * costs one comparison.
 */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    // The flag bit that says "this name is UTF-8" is deliberately not set, so every name must be
    // plain ASCII. Nothing in the Install Kit is otherwise, and a name that needs the bit is a bug
    // worth stopping on rather than handing a parent an archive their Explorer renders as mojibake.
    if (name.length !== entry.name.length) throw new Error(`zip: non-ASCII entry name: ${entry.name}`);
    if (entry.data.length > 0xffffffff) throw new Error(`zip: ${entry.name} needs ZIP64`);

    const deflated = zlib.deflateRawSync(entry.data);
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const { date, time } = dosStamp(entry.mtime);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4); // version made by: 2.0, MS-DOS
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with the directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, directory, eocd]);
}
