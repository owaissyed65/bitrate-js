//! Object-key sanitization — see SECURITY.md §2.
//!
//! Segment names must never be derived verbatim from user-supplied file names: `../`
//! or absolute paths could write outside the intended bucket prefix.

use wasm_bindgen::prelude::*;

/// Max length of a single key component, to bound storage-side surprises.
const MAX_LEN: usize = 128;

/// Reduce an untrusted string to a safe single path component.
///
/// Strips directory traversal, separators, control characters and NUL; keeps only
/// `[A-Za-z0-9._-]`; collapses runs of `.` so `..` can never survive; caps length.
/// Returns `"_"` if nothing safe remains, so callers always get a usable component.
#[wasm_bindgen]
pub fn sanitize_key(input: &str) -> String {
    let mut out = String::with_capacity(input.len().min(MAX_LEN));
    let mut prev_dot = false;

    for ch in input.chars() {
        // Reject separators, control chars and anything outside the allowlist.
        let keep = matches!(ch, 'A'..='Z' | 'a'..='z' | '0'..='9' | '.' | '_' | '-');
        if !keep || ch.is_control() {
            continue;
        }
        // Collapse consecutive dots so `..` (traversal) cannot form.
        if ch == '.' {
            if prev_dot {
                continue;
            }
            prev_dot = true;
        } else {
            prev_dot = false;
        }
        if out.len() >= MAX_LEN {
            break;
        }
        out.push(ch);
    }

    // A leading dot would create a hidden/relative-looking key.
    let trimmed = out.trim_start_matches('.').to_string();
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_key;

    #[test]
    fn strips_traversal() {
        assert_eq!(sanitize_key("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_key(".."), "_");
        assert_eq!(sanitize_key("../"), "_");
    }

    #[test]
    fn strips_separators_and_control_chars() {
        assert_eq!(sanitize_key("a/b\\c"), "abc");
        assert_eq!(sanitize_key("a\0b\nc"), "abc");
        assert_eq!(sanitize_key("/absolute"), "absolute");
    }

    #[test]
    fn keeps_normal_names() {
        assert_eq!(sanitize_key("1080p_00001.m4s"), "1080p_00001.m4s");
        assert_eq!(sanitize_key("master.m3u8"), "master.m3u8");
    }

    #[test]
    fn caps_length_and_handles_empty() {
        assert_eq!(sanitize_key(""), "_");
        assert_eq!(sanitize_key("!!!"), "_");
        assert!(sanitize_key(&"a".repeat(500)).len() <= 128);
    }
}
