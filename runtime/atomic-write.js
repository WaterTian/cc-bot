// cc-bot 原子写入 helper —— 单一调用入口，让 runtime/ 不再有裸 fs.writeFileSync。
//
// 流程：同目录 `.tmp-<base>-<uuid>` → write → fsync → rename → 失败 cleanup。
// POSIX rename 同目录原子保证，避免 crash/断电留半截 JSON 让 readJSON catch 静默
// 返默认值（调度状态丢失无告警 / 流式卡 state 半截致 mode 探测错乱 等真实风险）。
//
// API：
//   atomicWriteSync(filePath, content) —— content 是 string，调用方自己 stringify。
//   各调用点 stringify 风格不一（紧凑 / pretty / 带尾 \n），helper 不强加格式。
//
// 失败语义：rename 抛出时已经 cleanup 了 tmp，调用方拿到 throw 即可（runtime/ 各处
// 写入都包在 try 或 catch 兜底里，原子写失败 = 视同写入失败处理）。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function atomicWriteSync(filePath, content) {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const tmpPath = path.join(dir, `.tmp-${base}-${crypto.randomUUID()}`)

  fs.mkdirSync(dir, { recursive: true })

  let fd
  try {
    fd = fs.openSync(tmpPath, 'w')
    fs.writeSync(fd, content)
    fs.fsyncSync(fd)
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmpPath) } catch {}
    throw e
  }
  try { fs.closeSync(fd) } catch {}

  try {
    fs.renameSync(tmpPath, filePath)
  } catch (e) {
    try { fs.unlinkSync(tmpPath) } catch {}
    throw e
  }
}

module.exports = { atomicWriteSync }
