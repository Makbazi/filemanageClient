//! 缩略图与相机 RAW 内嵌预览提取（0.2.1）。
//!
//! 浏览器（WebView2/webkitgtk）无法解码相机 RAW（NEF/CR2/ARW/RAF…），但这些
//! 文件内部都嵌有相机生成的 JPEG 预览（小缩略图 + 常有的全尺寸预览）。本模块
//! 用纯字节扫描提取其中最大的完整 JPEG（SOI FFD8FF 起、按段链走到 EOI FFD9，
//! 段链非法即判为垃圾拒绝——绝不误取半张图），对前端呈现为普通 .jpg 媒体缓存
//! 文件；非 RAW 图像再经 `image` 解码缩至 ≤512px JPEG 作为网格缩略图。
//! 该方案覆盖各品牌 RAW（TIFF 容器 NEF/CR2/ARW/RW2/ORF/PEF/DNG…、非 TIFF 的
//! RAF/CR3/X3F…均可，只要内含 JPEG——确实不含内嵌 JPEG 的极少数机型回退图标）。
//! 零服务端依赖：字节来源就是既有 `/api/v1/preview` 的媒体缓存下载。

use std::fs;
use std::path::{Path, PathBuf};

use crate::config::AppState;

/// 相机 RAW 扩展名（与前端 lib/preview.ts RAW_EXT 一致，全小写）。
pub fn is_raw_ext(ext: &str) -> bool {
    matches!(
        ext,
        "nef" | "nrw" // Nikon
            | "cr2" | "cr3" | "crw" // Canon
            | "arw" | "srf" | "sr2" // Sony
            | "raf" // Fuji
            | "rw2" | "raw" // Panasonic
            | "orf" // Olympus
            | "pef" // Pentax
            | "rwl" // Leica
            | "3fr" // Hasselblad
            | "srw" // Samsung
            | "x3f" // Sigma
            | "erf" | "fff" // Epson / Phase One
            | "mrw" | "dcs" | "kdc" // Minolta / Kodak
    )
}

/// 缩略图最长边（px）。
const MAX_SIDE: u32 = 512;

fn be16(buf: &[u8], i: usize) -> Option<usize> {
    let hi = *buf.get(i)? as usize;
    let lo = *buf.get(i + 1)? as usize;
    Some((hi << 8) | lo)
}

/// 若 buf[start..] 是一个完整 JPEG（FFD8FF 起），返回其总长度（含 EOI FFD9），
/// 否则 None。按段链前进：各 marker 用头内长度跳段；SOS 之后进入熵数据扫描
/// （FF00 填充字节/RST 段/扫描间 DHT 合法，progressive 多扫描不误伤），遇 EOI
/// 收束。校验只保证"结构完整"，解码侧还会二次把关。
fn jpeg_full_len(buf: &[u8], start: usize) -> Option<usize> {
    // 合法 JPEG：FFD8 之后必紧跟 0xFF 开头的下一个段（填充 FFFF 也满足）
    if buf.get(start) != Some(&0xFF) || buf.get(start + 1) != Some(&0xD8) || buf.get(start + 2) != Some(&0xFF) {
        return None;
    }
    let mut p = start + 2;
    let mut in_scan = false;
    loop {
        if p >= buf.len() {
            return None;
        }
        if buf[p] != 0xFF {
            // 熵数据中间的任意字节继续前扫；段边界处出现非 FF 即非法
            if in_scan {
                p += 1;
                continue;
            }
            return None;
        }
        let m = *buf.get(p + 1)?;
        match m {
            0xD9 => return Some(p + 2 - start), // EOI
            0xFF => p += 1,                     // 填充字节
            0x00 | 0x01 | 0xD0..=0xD7 => p += 2, // 填充 FF00 / TEM / RSTn
            0xDA => {
                // SOS：跳过头部进入熵数据
                let l = be16(buf, p + 2)?;
                if l < 2 {
                    return None;
                }
                p += 2 + l;
                in_scan = true;
            }
            // 其余一切带长度头的段（SOF/DHT/DAC/APPn/COM/EOL…）
            _ => {
                let l = be16(buf, p + 2)?;
                if l < 2 {
                    return None;
                }
                p += 2 + l;
                in_scan = false; // 扫描间表段出现 = 当前扫描结束
            }
        }
    }
}

/// 扫描整个缓冲，提取所有结构完整的内嵌 JPEG；返回**最大**的那个（相机 RAW 的
/// 全尺寸预览；小内嵌缩略图留给后续 thumbnail 通道自行降采样）。
pub fn extract_preview(buf: &[u8]) -> Option<Vec<u8>> {
    let mut best: Option<(usize, usize)> = None; // (start,len)
    let mut i = 0usize;
    while i + 3 < buf.len() {
        if buf[i] == 0xFF && buf[i + 1] == 0xD8 && buf[i + 2] == 0xFF {
            if let Some(len) = jpeg_full_len(buf, i) {
                if len >= 128 && best.map(|(_, bl)| len > bl).unwrap_or(true) {
                    best = Some((i, len));
                }
                i += len.max(1); // 命中的完整 JPEG 不再进入其内部找嵌套
                continue;
            }
        }
        i += 1;
    }
    best.map(|(s, l)| buf[s..s + l].to_vec())
}

fn thumb_name(key: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut h);
    format!("{:x}.thumb.jpg", h.finish())
}

/// 生成（或复用）媒体缓存目录下的 ≤512px 缩略图 JPEG，返回其绝对路径。
/// src 必须是媒体缓存后的**浏览器/`image` 可解码**文件（RAW 已在其上游的
/// media_cache 换成内嵌预览 .jpg）。失败返回 Err（前端回退类型图标）。
pub fn ensure_thumb(st: &AppState, key: &str, src: &Path) -> Result<PathBuf, String> {
    let dir = st.media_cache_dir();
    let _ = fs::create_dir_all(&dir);
    let dest = dir.join(thumb_name(key));
    if dest.exists() {
        return Ok(dest);
    }
    let jpeg = fs::read(src).map_err(|e| format!("读取失败: {e}"))?;
    let img = image::load_from_memory(&jpeg).map_err(|e| format!("无法解码: {e}"))?;
    use image::{ExtendedColorType, ImageEncoder};
    let small = img.thumbnail(MAX_SIDE, MAX_SIDE);
    let rgb = small.to_rgb8();
    let mut out: Vec<u8> = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80);
    enc.write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .map_err(|e| format!("缩略图编码失败: {e}"))?;
    fs::write(&dest, &out).map_err(|e| format!("缩略图写入失败: {e}"))?;
    Ok(dest)
}
