//! Bounds-checked cursor for parsing untrusted binary.
//!
//! Every read returns `Option`/`Result` instead of panicking: this parser sees
//! attacker-controlled bytes, and a panic in WASM aborts the caller's whole
//! page (SECURITY.md §3).

/// A read cursor over a byte slice.
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    /// Create a cursor at the start of `buf`.
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    /// Current offset from the start of the slice.
    pub fn pos(&self) -> usize {
        self.pos
    }

    /// Bytes remaining.
    pub fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    /// True when no bytes remain.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.remaining() == 0
    }

    /// Advance by `n`, failing if that would run past the end.
    pub fn skip(&mut self, n: usize) -> Option<()> {
        let next = self.pos.checked_add(n)?;
        if next > self.buf.len() {
            return None;
        }
        self.pos = next;
        Some(())
    }

    /// Take the next `n` bytes.
    pub fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let slice = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }

    /// Borrow the rest without consuming it.
    pub fn rest(&self) -> &'a [u8] {
        self.buf.get(self.pos..).unwrap_or(&[])
    }

    pub fn u8(&mut self) -> Option<u8> {
        let b = self.take(1)?;
        b.first().copied()
    }

    pub fn u16(&mut self) -> Option<u16> {
        let b: [u8; 2] = self.take(2)?.try_into().ok()?;
        Some(u16::from_be_bytes(b))
    }

    pub fn u32(&mut self) -> Option<u32> {
        let b: [u8; 4] = self.take(4)?.try_into().ok()?;
        Some(u32::from_be_bytes(b))
    }

    pub fn i32(&mut self) -> Option<i32> {
        let b: [u8; 4] = self.take(4)?.try_into().ok()?;
        Some(i32::from_be_bytes(b))
    }

    pub fn u64(&mut self) -> Option<u64> {
        let b: [u8; 8] = self.take(8)?.try_into().ok()?;
        Some(u64::from_be_bytes(b))
    }

    /// Read a four-character box type.
    pub fn fourcc(&mut self) -> Option<[u8; 4]> {
        self.take(4)?.try_into().ok()
    }

    /// Read a FullBox's version and 24-bit flags.
    pub fn version_flags(&mut self) -> Option<(u8, u32)> {
        let version = self.u8()?;
        let a = u32::from(self.u8()?);
        let b = u32::from(self.u8()?);
        let c = u32::from(self.u8()?);
        Some((version, (a << 16) | (b << 8) | c))
    }
}

/// One box header plus its payload.
pub struct BoxHeader<'a> {
    /// The four-character box type, e.g. `b"moov"`.
    pub kind: [u8; 4],
    /// The box contents, excluding its header.
    pub payload: &'a [u8],
}

impl BoxHeader<'_> {
    /// True when this box has the given type.
    pub fn is(&self, kind: &[u8; 4]) -> bool {
        &self.kind == kind
    }
}

/// Iterate the boxes contained in `buf`.
///
/// Stops cleanly at the first malformed header rather than erroring, so a
/// truncated trailing box does not discard everything parsed before it.
pub fn boxes(buf: &[u8]) -> Vec<BoxHeader<'_>> {
    let mut out = Vec::new();
    let mut r = Reader::new(buf);

    while r.remaining() >= 8 {
        let start = r.pos();
        let Some(size32) = r.u32() else { break };
        let Some(kind) = r.fourcc() else { break };

        // size 1 => 64-bit `largesize` follows; size 0 => box runs to EOF.
        let size = match size32 {
            0 => buf.len().saturating_sub(start),
            1 => {
                let Some(large) = r.u64() else { break };
                match usize::try_from(large) {
                    Ok(v) => v,
                    Err(_) => break,
                }
            }
            n => n as usize,
        };

        let header_len = r.pos().saturating_sub(start);
        if size < header_len {
            break; // impossible size; refuse to loop forever
        }
        let payload_len = size - header_len;
        let Some(payload) = r.take(payload_len) else {
            break; // truncated
        };
        out.push(BoxHeader { kind, payload });
    }
    out
}

/// Payload of the first child box named `kind`.
pub fn find<'a>(buf: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(buf).into_iter().find(|b| b.is(kind)).map(|b| b.payload)
}

/// Walk a chain of nested container boxes.
pub fn find_path<'a>(buf: &'a [u8], path: &[&[u8; 4]]) -> Option<&'a [u8]> {
    let mut cur = buf;
    for kind in path {
        cur = find(cur, kind)?;
    }
    Some(cur)
}

#[cfg(test)]
mod tests {
    use super::{boxes, find, find_path, Reader};

    /// Build `size + type + payload`.
    fn bx(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let size = (8 + payload.len()) as u32;
        let mut v = size.to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn reads_primitives_in_big_endian() {
        let data = [0x01u8, 0x02, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff];
        let mut r = Reader::new(&data);
        assert_eq!(r.u16(), Some(0x0102));
        assert_eq!(r.u16(), Some(0x0304));
        assert_eq!(r.i32(), Some(-1));
        assert!(r.is_empty());
    }

    #[test]
    fn reads_past_end_return_none_rather_than_panicking() {
        let mut r = Reader::new(&[0u8; 3]);
        assert_eq!(r.u32(), None);
        assert_eq!(r.u64(), None);
        assert_eq!(r.take(99), None);
        assert_eq!(r.skip(99), None);
        // Position must not move on a failed read.
        assert_eq!(r.pos(), 0);
    }

    #[test]
    fn version_flags_unpacks_24_bit_flags() {
        let data = [1u8, 0x02, 0x00, 0x00];
        let mut r = Reader::new(&data);
        assert_eq!(r.version_flags(), Some((1, 0x02_0000)));
    }

    #[test]
    fn iterates_sibling_boxes() {
        let mut buf = bx(b"ftyp", b"isom");
        buf.extend(bx(b"moov", b"xx"));
        let found = boxes(&buf);
        assert_eq!(found.len(), 2);
        assert!(found[0].is(b"ftyp"));
        assert_eq!(found[1].payload, b"xx");
    }

    #[test]
    fn handles_64_bit_largesize() {
        let mut buf = 1u32.to_be_bytes().to_vec(); // size == 1 => largesize
        buf.extend_from_slice(b"mdat");
        buf.extend_from_slice(&20u64.to_be_bytes()); // total size
        buf.extend_from_slice(&[0xab; 4]); // payload
        let found = boxes(&buf);
        assert_eq!(found.len(), 1);
        assert!(found[0].is(b"mdat"));
        assert_eq!(found[0].payload, &[0xab; 4]);
    }

    #[test]
    fn size_zero_means_rest_of_buffer() {
        let mut buf = 0u32.to_be_bytes().to_vec();
        buf.extend_from_slice(b"mdat");
        buf.extend_from_slice(&[7u8; 10]);
        let found = boxes(&buf);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].payload.len(), 10);
    }

    #[test]
    fn truncated_trailing_box_does_not_discard_earlier_ones() {
        let mut buf = bx(b"ftyp", b"isom");
        buf.extend_from_slice(&999u32.to_be_bytes()); // claims 999 bytes
        buf.extend_from_slice(b"moov");
        buf.extend_from_slice(b"short");
        let found = boxes(&buf);
        assert_eq!(found.len(), 1, "the intact ftyp survives");
        assert!(found[0].is(b"ftyp"));
    }

    #[test]
    fn bogus_size_smaller_than_header_terminates_cleanly() {
        // size = 4 is impossible (header alone is 8) and must not loop forever.
        let mut buf = 4u32.to_be_bytes().to_vec();
        buf.extend_from_slice(b"junk");
        buf.extend_from_slice(&[0u8; 16]);
        assert!(boxes(&buf).is_empty());
    }

    #[test]
    fn finds_nested_paths() {
        let inner = bx(b"mdhd", &[1, 2, 3]);
        let mdia = bx(b"mdia", &inner);
        let trak = bx(b"trak", &mdia);

        // `find` searches a buffer's *top-level* boxes, so the outermost box
        // must be named in the path rather than assumed to be entered.
        assert_eq!(find(&trak, b"trak").map(|p| p.len()), Some(mdia.len()));
        assert_eq!(find(&trak, b"mdia"), None, "mdia is nested, not top-level");

        assert_eq!(find_path(&trak, &[b"trak", b"mdia", b"mdhd"]), Some(&[1u8, 2, 3][..]));
        assert_eq!(find_path(&trak, &[b"trak", b"mdia", b"nope"]), None);
    }
}
