//! ISO base media file format (ISO/IEC 14496-12) box-writing primitives.
//!
//! Every box is `size:u32 + type:u32 [+ version:u8 + flags:u24 for a FullBox]`
//! followed by its payload, all big-endian. Sizes are not known until children
//! are written, so [`BoxWriter::begin`] reserves the size field and
//! [`BoxWriter::end`] patches it.

/// Sequential big-endian writer for ISO-BMFF structures.
#[derive(Default)]
pub struct BoxWriter {
    buf: Vec<u8>,
}

/// Marks an open box; must be passed to [`BoxWriter::end`] to finalize its size.
#[must_use = "an opened box must be closed with BoxWriter::end"]
pub struct OpenBox(usize);

impl BoxWriter {
    /// Create an empty writer.
    ///
    /// Muxing paths all know their approximate output size and use
    /// [`Self::with_capacity`]; this is kept for callers that do not.
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Create a writer with pre-allocated capacity.
    pub fn with_capacity(cap: usize) -> Self {
        Self {
            buf: Vec::with_capacity(cap),
        }
    }

    /// Bytes written so far.
    pub fn len(&self) -> usize {
        self.buf.len()
    }

    /// Consume the writer, returning the encoded bytes.
    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    /// Borrow the encoded bytes without consuming the writer.
    #[allow(dead_code)]
    pub fn as_bytes(&self) -> &[u8] {
        &self.buf
    }

    // ---- primitives -------------------------------------------------------

    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }

    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub fn i16(&mut self, v: i16) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub fn i32(&mut self, v: i32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(v);
        self
    }

    /// Write `n` zero bytes.
    pub fn zeros(&mut self, n: usize) -> &mut Self {
        self.buf.resize(self.buf.len() + n, 0);
        self
    }

    /// The unity video transformation matrix, as required by `tkhd`/`mvhd`.
    pub fn unity_matrix(&mut self) -> &mut Self {
        const UNITY: [i32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];
        for v in UNITY {
            self.i32(v);
        }
        self
    }

    // ---- boxes ------------------------------------------------------------

    /// Open a plain box, reserving its size field.
    pub fn begin(&mut self, kind: &[u8; 4]) -> OpenBox {
        let start = self.buf.len();
        self.u32(0); // size placeholder, patched by `end`
        self.bytes(kind);
        OpenBox(start)
    }

    /// Open a FullBox (a box carrying a version and 24-bit flags).
    pub fn begin_full(&mut self, kind: &[u8; 4], version: u8, flags: u32) -> OpenBox {
        let open = self.begin(kind);
        self.u8(version);
        // 24-bit flags, big-endian.
        self.u8(((flags >> 16) & 0xff) as u8);
        self.u8(((flags >> 8) & 0xff) as u8);
        self.u8((flags & 0xff) as u8);
        open
    }

    /// Close a box, back-patching its size field.
    pub fn end(&mut self, open: OpenBox) {
        let size = self.buf.len().saturating_sub(open.0);
        // A box larger than u32::MAX would need a 64-bit `largesize`; we never
        // produce one because segment size is bounded well below 4 GiB.
        let size = u32::try_from(size).unwrap_or(u32::MAX);
        patch_u32(&mut self.buf, open.0, size);
    }

    /// Write a complete box whose payload is produced by `f`.
    pub fn boxed(&mut self, kind: &[u8; 4], f: impl FnOnce(&mut Self)) -> &mut Self {
        let open = self.begin(kind);
        f(self);
        self.end(open);
        self
    }

    /// Write a complete FullBox whose payload is produced by `f`.
    pub fn full_boxed(
        &mut self,
        kind: &[u8; 4],
        version: u8,
        flags: u32,
        f: impl FnOnce(&mut Self),
    ) -> &mut Self {
        let open = self.begin_full(kind, version, flags);
        f(self);
        self.end(open);
        self
    }

    /// Overwrite a previously written big-endian `u32` at `offset`.
    ///
    /// Used to back-patch `trun`'s `data_offset` once the enclosing `moof`
    /// size is known.
    pub fn patch_u32_at(&mut self, offset: usize, value: u32) {
        patch_u32(&mut self.buf, offset, value);
    }
}

/// Overwrite four bytes at `at` with `value`, big-endian.
///
/// Silently ignores an out-of-range offset rather than panicking: a panic in
/// WASM aborts the caller's page (SECURITY.md §3).
fn patch_u32(buf: &mut [u8], at: usize, value: u32) {
    if let Some(slot) = buf.get_mut(at..at.saturating_add(4)) {
        slot.copy_from_slice(&value.to_be_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::BoxWriter;

    /// Read the `size` and `type` of the box starting at `at`.
    fn header(buf: &[u8], at: usize) -> (u32, String) {
        let size = u32::from_be_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
        let kind = String::from_utf8_lossy(&buf[at + 4..at + 8]).into_owned();
        (size, kind)
    }

    #[test]
    fn empty_box_is_header_only() {
        let mut w = BoxWriter::new();
        w.boxed(b"free", |_| {});
        let buf = w.into_bytes();
        assert_eq!(buf.len(), 8);
        assert_eq!(header(&buf, 0), (8, "free".to_string()));
    }

    #[test]
    fn full_box_carries_version_and_flags() {
        let mut w = BoxWriter::new();
        w.full_boxed(b"tfdt", 1, 0x00_0000, |w| {
            w.u64(12345);
        });
        let buf = w.into_bytes();
        assert_eq!(header(&buf, 0), (20, "tfdt".to_string()));
        assert_eq!(buf[8], 1, "version");
        assert_eq!(&buf[9..12], &[0, 0, 0], "flags");
        assert_eq!(u64::from_be_bytes(buf[12..20].try_into().unwrap()), 12345);
    }

    #[test]
    fn flags_are_written_as_24_bits() {
        let mut w = BoxWriter::new();
        w.full_boxed(b"tfhd", 0, 0x02_0000, |_| {});
        let buf = w.into_bytes();
        assert_eq!(&buf[9..12], &[0x02, 0x00, 0x00]);
    }

    #[test]
    fn nested_sizes_are_patched_correctly() {
        let mut w = BoxWriter::new();
        w.boxed(b"moof", |w| {
            w.full_boxed(b"mfhd", 0, 0, |w| {
                w.u32(1);
            });
        });
        let buf = w.into_bytes();
        // moof = 8 header + mfhd(8 header + 4 ver/flags + 4 payload = 16) = 24
        assert_eq!(header(&buf, 0), (24, "moof".to_string()));
        assert_eq!(header(&buf, 8), (16, "mfhd".to_string()));
        assert_eq!(buf.len(), 24);
    }

    #[test]
    fn patch_u32_at_overwrites_in_place() {
        let mut w = BoxWriter::new();
        w.u32(0xdead_beef);
        w.patch_u32_at(0, 42);
        assert_eq!(w.as_bytes(), &42u32.to_be_bytes());
    }

    #[test]
    fn patch_out_of_range_is_ignored_not_panicking() {
        let mut w = BoxWriter::new();
        w.u32(1);
        w.patch_u32_at(9_999, 7); // must not panic
        assert_eq!(w.len(), 4);
    }

    #[test]
    fn unity_matrix_is_36_bytes() {
        let mut w = BoxWriter::new();
        w.unity_matrix();
        let buf = w.into_bytes();
        assert_eq!(buf.len(), 36);
        assert_eq!(&buf[0..4], &0x0001_0000u32.to_be_bytes());
        assert_eq!(&buf[32..36], &0x4000_0000u32.to_be_bytes());
    }
}
