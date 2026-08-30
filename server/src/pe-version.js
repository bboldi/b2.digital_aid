// Reads the version a Windows exe declares about itself, so the server never has to trust a version
// typed into a form. .NET writes the project's InformationalVersion into the PE's
// StringFileInfo\ProductVersion, which is the full SemVer string — build metadata included — and is
// therefore also what lets us tell a release apart from a `+dev` scratch build.
//
// This walks the PE far enough to find the .rsrc section and scans only inside it. A whole-file scan
// would be shorter, but this gate decides what is allowed to reach a kid's PC, and constraining the
// search to the resource section removes any chance of matching a stray byte sequence elsewhere in
// the (multi-hundred-KB, self-extracting) file.

const PRODUCT_VERSION_KEY = Buffer.from('ProductVersion', 'utf16le');

/**
 * @param {Buffer} buf  the whole exe
 * @returns {string|null} e.g. "0.2.0" or "0.1.0+dev.abc1234", or null if the file declares none
 */
export function readProductVersion(buf) {
  const rsrc = findResourceSection(buf);
  if (!rsrc) return null;

  const at = rsrc.indexOf(PRODUCT_VERSION_KEY);
  if (at < 0) return null;

  // A String entry is: wLength, wValueLength, wType, szKey (NUL-terminated UTF-16), padding to a
  // 32-bit boundary, then the value as NUL-terminated UTF-16.
  let i = at + PRODUCT_VERSION_KEY.length;
  while (i + 1 < rsrc.length && rsrc.readUInt16LE(i) === 0) i += 2;   // key terminator + alignment

  const chars = [];
  for (; i + 1 < rsrc.length; i += 2) {
    const code = rsrc.readUInt16LE(i);
    if (code === 0) break;
    chars.push(code);
    if (chars.length > 128) return null;   // not a version string; refuse rather than guess
  }

  const value = String.fromCharCode(...chars).trim();
  return value || null;
}

/** True for anything build.sh produced — a scratch build that must never be shipped to a Client. */
export function isDevBuild(version) {
  return typeof version === 'string' && version.includes('+');
}

function findResourceSection(buf) {
  try {
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null;   // 'MZ'

    const peOffset = buf.readUInt32LE(0x3c);
    if (buf.readUInt32LE(peOffset) !== 0x00004550) return null;             // 'PE\0\0'

    const sectionCount = buf.readUInt16LE(peOffset + 6);
    const optionalHeaderSize = buf.readUInt16LE(peOffset + 20);
    let section = peOffset + 24 + optionalHeaderSize;

    for (let n = 0; n < sectionCount; n++, section += 40) {
      if (section + 40 > buf.length) return null;
      const name = buf.toString('latin1', section, section + 8).replace(/\0+$/, '');
      if (name !== '.rsrc') continue;

      const size = buf.readUInt32LE(section + 16);
      const offset = buf.readUInt32LE(section + 20);
      if (offset + size > buf.length) return null;
      return buf.subarray(offset, offset + size);
    }
    return null;
  } catch {
    // A malformed or truncated upload is a rejection, not a crash.
    return null;
  }
}
