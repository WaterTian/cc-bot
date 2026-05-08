#!/usr/bin/env node
// cc-bot 图片尺寸检测 — 防止 >2000px 图片进入 Claude 会话历史触发 API 多图维度硬限制
// （`An image in the conversation exceeds the dimension limit for many-image requests (2000px).`），
// 该错误会让整轮 tool 调用全死、bot 沉默、永久阻塞会话。
//
// 用法：
//   node check-image-size.js <abs-path>
//
// stdout 单行输出 + exit code：
//   OK <w>x<h> <format>            (0)  长边 ≤ 2000px，可安全 Read
//   TOO_LARGE <w>x<h> <format>     (1)  长边 > 2000px，禁止 Read（会污染会话）
//   UNKNOWN_FORMAT <reason>        (2)  非 PNG/JPEG/GIF（如 WebP/HEIC/AVIF），由调用方决定是否谨慎 Read
//   ERROR <reason>                 (3)  路径不存在、文件不可读等
//
// 内置 PNG / JPEG / GIF header 解析，零依赖（保 cc-bot zero-runtime-dep 承诺）。

const fs = require('fs')

const MAX_LONG_EDGE = 2000

function readImageSize(filePath) {
  let buf
  try {
    const fd = fs.openSync(filePath, 'r')
    const stat = fs.fstatSync(fd)
    const len = Math.min(stat.size, 65536)
    buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, 0)
    fs.closeSync(fd)
  } catch (err) {
    return { error: err.message }
  }
  if (buf.length < 16) return { unknown: 'file too short' }

  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR chunk（width/height @ offset 16/20，big-endian uint32）
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    if (buf.length < 24) return { unknown: 'png header truncated' }
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      format: 'png',
    }
  }

  // GIF: 'GIF87a' / 'GIF89a' + width/height @ offset 6/8（little-endian uint16）
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    if (buf.length < 10) return { unknown: 'gif header truncated' }
    return {
      width: buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
      format: 'gif',
    }
  }

  // JPEG: FF D8 ... 扫 SOF0/1/2/3/5-7/9-11/13-15（跳 DHT=C4 / JPG=C8 / DAC=CC）
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue }
      // 跳 fill bytes（连续 0xFF padding）
      while (i + 1 < buf.length && buf[i + 1] === 0xFF) i++
      const marker = buf[i + 1]
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        // SOF segment: marker(2) + length(2) + precision(1) + height(2 BE) + width(2 BE)
        if (i + 9 >= buf.length) return { unknown: 'jpeg sof truncated' }
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
          format: 'jpeg',
        }
      }
      if (i + 4 > buf.length) return { unknown: 'jpeg malformed' }
      const segLen = buf.readUInt16BE(i + 2)
      if (segLen < 2) return { unknown: 'jpeg malformed' }
      i += 2 + segLen
    }
    return { unknown: 'jpeg sof not found in first 64KB' }
  }

  // 其他格式（WebP / HEIC / AVIF / BMP / TIFF 等）
  return { unknown: 'unsupported format (not png/jpeg/gif)' }
}

const arg = process.argv[2]
if (!arg) {
  process.stdout.write('ERROR missing-path-argument\n')
  process.exit(3)
}

const result = readImageSize(arg)
if (result.error) {
  process.stdout.write(`ERROR ${result.error}\n`)
  process.exit(3)
}
if (result.unknown) {
  process.stdout.write(`UNKNOWN_FORMAT ${result.unknown}\n`)
  process.exit(2)
}

const longEdge = Math.max(result.width, result.height)
if (longEdge > MAX_LONG_EDGE) {
  process.stdout.write(`TOO_LARGE ${result.width}x${result.height} ${result.format}\n`)
  process.exit(1)
}
process.stdout.write(`OK ${result.width}x${result.height} ${result.format}\n`)
process.exit(0)
