// A minimal PE with one .rsrc section, built in code rather than committed as a binary fixture so
// the tests say out loud which bytes the parser depends on. Verified against real output from
// client/publish.sh (0.1.0) and client/build.sh (0.1.0+dev.<sha>).
export function fakeExe(value, { sectionName = '.rsrc', pad = 2, filler = 0 } = {}) {
  const key = Buffer.from('ProductVersion', 'utf16le');
  const rsrc = Buffer.concat([
    Buffer.alloc(16, filler),                           // leading junk the parser must skip past
    key,
    Buffer.alloc(2 + pad * 2),                          // NUL terminator + 32-bit alignment padding
    value === null ? Buffer.alloc(0) : Buffer.from(value, 'utf16le'),
    Buffer.alloc(2),
  ]);

  const peOffset = 0x80;
  const rsrcOffset = 0x200;
  const buf = Buffer.alloc(rsrcOffset + rsrc.length);

  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.write('PE\0\0', peOffset, 'latin1');
  buf.writeUInt16LE(0x8664, peOffset + 4);              // machine
  buf.writeUInt16LE(1, peOffset + 6);                   // number of sections
  buf.writeUInt16LE(0, peOffset + 20);                  // size of optional header

  const section = peOffset + 24;
  buf.write(sectionName.padEnd(8, '\0'), section, 'latin1');
  buf.writeUInt32LE(rsrc.length, section + 16);         // SizeOfRawData
  buf.writeUInt32LE(rsrcOffset, section + 20);          // PointerToRawData
  rsrc.copy(buf, rsrcOffset);
  return buf;
}
