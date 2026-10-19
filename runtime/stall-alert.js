#!/usr/bin/env node
// cc-bot 主会话假死告警 —— emit 群消息后主会话长时间没动静时，主动告知群里 + 终端（v0.1.50+，issue #4）
//
// 现有告警全是被动的：doctor 要人手动跑、events.log 要人去翻。假死时恰恰没人会去跑 / 翻 ——
// 群里只看到「bot 不说话」，终端只看到一片静默。poll.js 是独立进程，主会话卡死它还活着，
// 是唯一能开口的组件（与 quota-alert 同理）。
//
// 判定只用 poll.js 本地已有的信号，零额外 API 调用（issue #23 配额口径）：
//   pending   — poll.js 刚 emit 过 NEW_MSG，等主会话接手（进程内记 pendingSince / pendingMsgId）
//   consumed  — 以下任一出现在 pendingSince 之后，即视为主会话已接手，pending 清零：
//               ① hud-stdin.json mtime 推进（statusline 在主会话每次输出后重绘 = 活着且在跑）
//               ② agents.json mtime 推进（dispatch register / complete / sweep，派单了）
//               ③ 群里出现 bot 自己发的新消息（polling / 校对 tick 顺带看到；push 收不到自己的）
//   stalled   — pending 持续 ≥ stall_mins 且无 consumed 信号，且主会话不在 mainBusy
//               （终端用户占着主会话时占位文案已经说明情况，不算假死）
//
// 为什么 HUD 缺失时整个不判：没有 statusline 心跳就分不清「卡死」和「闷头跑长任务」，宁可不报
// （setup 默认装 statusline shim，doctor §5 查；缺失只在 events.log 提示一次）。
//
// 误报面：主会话正为上一条群消息跑长工具调用（期间 HUD 不重绘）时又来一条 → stall_mins 后报一次。
// 这对群里是真实信息（消息 N 分钟没人理），文案用「似乎卡住了」不下死判；同一次卡住每 30min 最多再提醒一次。
//
// 发送失败不记账：下一 tick 重判重发（与 quota-alert 同策略）。进程内状态不落盘：poll.js 重启 = 重新开始。
//
// 默认 heartbeat.stall_mins=0 关闭（与 dispatch.max_turn_time_mins 同约定）；建议 10~15。

const fs = require('fs')
const path = require('path')

const REMIND_MS = 30 * 60 * 1000          // 同一次卡住的再提醒间隔
const HUD_FILE = 'hud-stdin.json'
const AGENTS_FILE = 'agents.json'

const DEFAULT_LOCALE_BY_IM = { lark: 'zh-CN', slack: 'en-US' }

const NONE = Object.freeze({ action: 'none' })

function resolveConfig(profile) {
  const hb = (profile && profile.heartbeat) || {}
  const mins = Number(hb.stall_mins)
  const stallMs = Number.isFinite(mins) && mins > 0 ? Math.round(mins * 60 * 1000) : 0
  return {
    enabled: stallMs > 0,
    stallMs,
    remindMs: REMIND_MS,
    notifyRecovered: hb.notify_recovered !== false,
  }
}

function resolveLocale(profile) {
  const im = (profile && profile.im) || {}
  return im.locale || DEFAULT_LOCALE_BY_IM[im.type] || 'zh-CN'
}

function fmtMins(ms) {
  const m = ms / 60000
  if (m < 1) return (Math.round(m * 10) / 10).toString()
  return String(Math.round(m))
}

const TEXT = {
  'zh-CN': {
    alert: ({ pendingMs, hudAgeMs, again }) => again
      ? `⚠️ 主会话仍无响应：群消息已等了 ${fmtMins(pendingMs)} 分钟（会话心跳 ${fmtMins(hudAgeMs)} 分钟无更新）。请到终端看一眼，或跑 /cc-bot:doctor。`
      : `⚠️ 主会话似乎卡住了：${fmtMins(pendingMs)} 分钟前收到的群消息还没被处理（会话心跳 ${fmtMins(hudAgeMs)} 分钟无更新）。请到终端看一眼会话状态，或跑 /cc-bot:doctor。`,
    recover: ({ silentMs }) => `✅ 主会话已恢复响应（刚才约 ${fmtMins(silentMs)} 分钟没动静）`,
  },
  'en-US': {
    alert: ({ pendingMs, hudAgeMs, again }) => again
      ? `⚠️ Main session still unresponsive: a group message has been waiting ${fmtMins(pendingMs)} min (session heartbeat idle ${fmtMins(hudAgeMs)} min). Check the terminal or run /cc-bot:doctor.`
      : `⚠️ Main session looks stuck: a group message from ${fmtMins(pendingMs)} min ago has not been picked up (session heartbeat idle ${fmtMins(hudAgeMs)} min). Check the terminal session or run /cc-bot:doctor.`,
    recover: ({ silentMs }) => `✅ Main session is responding again (was silent for ~${fmtMins(silentMs)} min)`,
  },
}

function render(kind, locale, ctx) {
  const t = TEXT[locale] || TEXT['zh-CN']
  return t[kind](ctx)
}

// mtime（ms）；文件不存在返回 -1
function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs } catch { return -1 }
}

function createTracker({ runtimeDir, profile, locale, now = Date.now } = {}) {
  const cfg = resolveConfig(profile)
  const loc = locale || resolveLocale(profile)
  const hudFile = path.join(runtimeDir, HUD_FILE)
  const agentsFile = path.join(runtimeDir, AGENTS_FILE)

  const st = {
    pendingSince: 0,     // 第一条未被接手的 emit 时刻
    pendingMsgId: '',
    pendingCount: 0,
    alerted: false,      // 本次 pending 是否已报过
    lastAlertAt: 0,
    alertCount: 0,       // 本次 pending 报过几次
    recoverDue: null,    // 报过之后恢复了、但「已恢复」还没发出去（发送失败重试）
    warnedNoHud: false,
  }

  function resetPending() {
    st.pendingSince = 0
    st.pendingMsgId = ''
    st.pendingCount = 0
    st.alerted = false
    st.lastAlertAt = 0
    st.alertCount = 0
  }

  function recoverDecision() {
    const r = st.recoverDue
    return {
      action: 'recover',
      text: render('recover', loc, r),
      log: `BOT_INFO|poll.js|stall-recovered|silent=${Math.round(r.silentMs / 1000)}s|by=${r.by}|msg=${r.msgId}|alerts=${r.alerts}`,
    }
  }

  return {
    enabled: cfg.enabled,
    cfg,

    // poll.js emit NEW_MSG 后调用
    noteEmit(msgId) {
      if (!cfg.enabled) return
      const t = now()
      if (!st.pendingSince) {
        st.pendingSince = t
        st.pendingMsgId = String(msgId || '')
      }
      st.pendingCount++
    },

    // 每 tick / 定时器调用。返回决策，调用方负责发群，发成功后 commit()。
    //   mainBusy       — checkMainBusy().busy
    //   botMsgMaxTime  — 本 tick 看到的 bot 自己发的消息里最大的 createTimeMs（没有传 0）
    check({ mainBusy = false, botMsgMaxTime = 0 } = {}) {
      if (!cfg.enabled) return NONE
      if (st.recoverDue) return recoverDecision()
      if (!st.pendingSince) return NONE

      const t = now()
      const hud = mtimeMs(hudFile)
      if (hud < 0) {
        if (st.warnedNoHud) return NONE
        st.warnedNoHud = true
        return { action: 'none', log: 'BOT_WARN|poll.js|stall-alert-no-hud|hud-stdin.json 不存在（statusline shim 未装？），假死告警静默中；见 doctor §5' }
      }

      const agents = mtimeMs(agentsFile)
      const consumedBy = hud > st.pendingSince ? 'hud'
        : agents > st.pendingSince ? 'agents'
          : (botMsgMaxTime || 0) > st.pendingSince ? 'bot-msg'
            : null
      if (consumedBy) {
        const silentMs = t - st.pendingSince
        const wasAlerted = st.alerted
        const info = { silentMs, by: consumedBy, msgId: st.pendingMsgId, alerts: st.alertCount }
        resetPending()
        if (!wasAlerted) return NONE
        if (!cfg.notifyRecovered) {
          return { action: 'none', log: `BOT_INFO|poll.js|stall-recovered|silent=${Math.round(silentMs / 1000)}s|by=${consumedBy}|msg=${info.msgId}|alerts=${info.alerts}|notify_recovered=false` }
        }
        st.recoverDue = info
        return recoverDecision()
      }

      if (mainBusy) return NONE  // 终端用户占着主会话：busy 占位已说明，不算假死
      const pendingMs = t - st.pendingSince
      if (pendingMs < cfg.stallMs) return NONE
      if (st.alerted && t - st.lastAlertAt < cfg.remindMs) return NONE

      const hudAgeMs = Math.max(0, t - hud)
      const again = st.alerted
      const ctx = { pendingMs, hudAgeMs, again }
      return {
        action: 'alert',
        again,
        text: render('alert', loc, ctx),
        log: `BOT_WARN|poll.js|stall-suspected|pending=${Math.round(pendingMs / 1000)}s|hud=${Math.round(hudAgeMs / 1000)}s|msg=${st.pendingMsgId}|queued=${st.pendingCount}|nth=${st.alertCount + 1}`,
      }
    },

    // 发群成功后记账
    commit(decision) {
      if (!decision) return
      if (decision.action === 'alert') {
        st.alerted = true
        st.lastAlertAt = now()
        st.alertCount++
      } else if (decision.action === 'recover') {
        st.recoverDue = null
      }
    },

    snapshot() { return { ...st, cfg } },
  }
}

module.exports = { createTracker, resolveConfig, resolveLocale, render, REMIND_MS }
