// dsh-done-badge  (任务栏角标 + Windows 通知)
// 状态机(Codex 语义, 宿主驱动):
//   - "用户现在是不是在看 DSH" 由宿主侧判断: 调 badge.ps1 isforeground, 用 GetForegroundWindow
//     拿到前台窗口再看它的进程名。**不依赖页面里的 JS** —— 2026-09-30 实测事件日志里
//     0 条客户端来源的 away/back, 桌面端 window blur/focus 根本不上报, 所以判定权收到宿主。
//   - 顶层会话 turn/end(真正完成) 时: 用户不在 DSH 前面 -> 计数+1, 任务栏角标 + Windows 通知;
//     用户就在 DSH 前面 -> 不计数、不画角标(除非 toast=always)。
//   - 角标由常驻的 `badge.ps1 watch` 进程维护: 画出数字后每 ~700ms 看一次前台窗口, 用户切回 DSH
//     后保留 2 秒再清掉并退出; 期间宿主只需把新计数写进计数文件(%TEMP%\dsh-done-badge-count.txt)。
//   - 子代理会话(header.parentSession)不计入, 一个任务多个子代理只算 1
// 提醒粒度(重要): 一条用户消息 = 一个 turn(内部可能有几十个 step, 也可能对应 todo 里的多个步骤),
//   DSH 只在整轮真正结束时发一条 turn/end —— 所以这里是"整个任务做完才提醒", 不会按步骤刷屏。
//   被中断/取消的一轮(reason.kind 异常)不计数也不提醒。
// 通知开关: config.toast 或环境变量 DSH_BADGE_TOAST
//   away(默认) = 只有离开窗口(失焦/切屏/最小化)时才弹; always = 每次都弹; off = 关闭通知(仍保留角标)
// 日志: %TEMP%\dsh-done-badge-events.log (自动轮转, 单文件上限 1MB)
// 通知脚本日志: %TEMP%\dsh-done-badge-toast.log

// 注意: 这里必须用**默认导入**取整个模块对象, 不要写成 `import { spawn } from 'node:child_process'`。
// ESM 从 CJS 内置模块取具名导入时, 绑定是在生成那个合成模块的命名空间时"快照"下来的常量 ——
// 之后再替换 `child_process.spawn`(测试里的假 spawn / 故障注入)对它毫无影响, 而经默认导入
// 拿到的就是 module.exports 本体, `cp.spawn(...)` 是调用时才取属性, 所以可被替换。
// 实测证据(Node 22): named import 仍看到原函数, default import 看到被替换后的函数。
import cp from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 所有原生能力(任务栏角标 / 系统通知 / 前台窗口探测)都由 Windows 上的 PowerShell helper 实现。
// 非 Windows 平台上这些 helper 根本跑不起来: 早期版本仍会去 spawn 一个必然失败的 powershell.exe,
// 于是 `ENOENT` 被吃掉、probeForeground 恒返回 false -> "每个 turn/end 都当成用户离开了" -> 计数疯长,
// 而角标和通知又都画不出来。这里显式降级: 原生角标与系统通知整体停用,
// 只保留窗口内的 DOM 兜底角标(它只依赖宿主路由, 跨平台可用)。
const IS_WINDOWS = process.platform === 'win32'
const POWERSHELL = 'powershell.exe'

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const HELPER_PATH = join(ASSETS_DIR, 'badge.ps1')
const TOAST_PATH = join(ASSETS_DIR, 'toast.ps1')
const EVENT_LOG = join(process.env.TEMP || '/tmp', 'dsh-done-badge-events.log')
const COUNT_FILE = join(process.env.TEMP || '/tmp', 'dsh-done-badge-count.txt')
// 设置页「弹窗角标通知」的选择存这里: $DSH_HOME/dsh-done-badge.json
const CONFIG_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-done-badge.json')
const BACK_GRACE_MS = 2000
const LOG_MAX_BYTES = 1024 * 1024
const PROBE_TIMEOUT_MS = 8000

function logLine(entry) {
  try {
    // 简单轮转: 超 1MB 时重置, 避免无限增长
    try {
      if (statSync(EVENT_LOG).size > LOG_MAX_BYTES) writeFileSync(EVENT_LOG, '')
    } catch (err) {}
    appendFileSync(EVENT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch (err) {}
}

const name = 'done-badge'
const inject = ['webServer']

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// 统一的 JSON 回包。三处防御都必须有, 否则一个边角错误就能把宿主路由打崩:
//   1) 已经回过包的响应再 writeHead 会抛 ERR_HTTP_HEADERS_SENT;
//   2) 客户端提前断开时 write/end 会抛 ERR_STREAM_WRITE_AFTER_END;
//   3) 路由 handler 是异步的, 抛出去没人接。
function sendJson(res, status, payload) {
  try {
    if (!res || res.writableEnded || res.headersSent) return
    res.writeHead(status, JSON_HEADERS)
    res.end(JSON.stringify(payload))
  } catch (err) {}
}

// 子代理会话识别: 子代理会话的 header 带有 parentSession(父会话 ID), 顶层会话没有
function isSubsession(session) {
  const h = session && session.header
  return !!(h && h.parentSession)
}
function rootOf(session) {
  const h = session && session.header
  return h && h.parentSession ? String(h.parentSession) : ''
}

// 通知/计数的"真正结束"门槛。
// 真实 session 日志证据(本机 2026-09-29): 一条用户消息 = 一个 turn, 内部有 N 个 step。
//   turn 1: step 1..7   -> 只有一条 turn/end {"reason":{"kind":"completed"}}
//   turn 2: step 1..40  -> 也只有一条 turn/end
// 所以只监听 turn/end 本身就已经是"整个任务做完才提醒", 绝不会按 step 或 todo 步骤刷屏。
// 这里再排掉被中断/取消的那一轮, 保证只有"真正结束"才提醒。
const ABORT_REASONS = new Set(['aborted', 'abort', 'cancelled', 'canceled', 'cancel', 'interrupted', 'stopped', 'stop'])
function turnReasonKind(event) {
  const r = (event && event.reason) || (event && event.data && event.data.reason)
  return r && r.kind ? String(r.kind) : ''
}
function isCompletedTurn(event) {
  const kind = turnReasonKind(event)
  if (!kind) return true // 拿不到原因时按"完成"处理: 宁可多提醒一次, 也不能漏
  return !ABORT_REASONS.has(kind.toLowerCase())
}

const CLIENT_JS = `(function () {
  var POLL_MS = 1200
  var badge = null

  function ensureBadge() {
    if (badge) return badge
    var el = document.createElement('div')
    el.id = 'dsh-done-badge'
    el.style.cssText = [
      'position:fixed', 'top:14px', 'right:14px', 'z-index:2147483000',
      'min-width:26px', 'height:26px', 'padding:0 8px', 'border-radius:13px',
      'background:#e0433f', 'color:#fff',
      'font:700 14px/26px -apple-system,BlinkMacSystemFont,"Segoe UI",PingFang SC,Microsoft YaHei,sans-serif',
      'text-align:center', 'box-shadow:0 2px 10px rgba(0,0,0,.4)', 'cursor:pointer',
      'display:none', 'user-select:none', '-webkit-user-select:none'
    ].join(';')
    el.title = '离开期间完成的任务数'
    el.addEventListener('click', function () { hideBadge(); post('/dsh-badge/back') })
    document.body.appendChild(el)
    badge = el
    return badge
  }

  function post(url) {
    try { fetch(url, { method: 'POST' }).catch(function () {}) } catch (err) {}
  }

  function showBadge(count) {
    var el = ensureBadge()
    el.textContent = String(count)
    el.style.display = 'block'
  }

  function hideBadge() {
    if (badge) badge.style.display = 'none'
  }

  // 失焦判定已经搬到宿主侧(GetForegroundWindow 查前台窗口)。桌面端页面里的
  // blur/focus/visibilitychange 实测根本不上报, 所以这里不再向服务端同步焦点,
  // 免得两套判断互相打架。本脚本只剩两件事: 点击角标=清空; 轮询服务端状态画兜底角标。
  setInterval(function () {
    fetch('/dsh-badge/count.json').then(function (r) { return r.json() }).then(function (j) {
      if (!j || !j.ok) return
      if (j.badge && j.count > 0 && j.away) { showBadge(j.count) } else { hideBadge() }
    }).catch(function () {})
  }, POLL_MS)
})()
`

// 原生角标更新串行化: 后一个请求必须在前一个完成后执行
let overlayChain = Promise.resolve()
function scheduleOverlay(count) {
  if (!IS_WINDOWS) return // 非 Windows 没有任务栏角标, 直接跳过(不要 spawn 注定失败的 powershell)
  overlayChain = overlayChain.then(() => new Promise((resolve) => {
    let done = false
    let timeoutTimer = null
    const fin = () => {
      if (!done) {
        done = true
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
        resolve()
      }
    }
    try {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH]
      if (count > 0) args.push('set', String(count))
      else args.push('clear')
      const child = cp.spawn(POWERSHELL, args, { stdio: 'ignore', windowsHide: true })
      child.on('exit', fin)
      child.on('error', fin)
    } catch (err) { fin() }
    timeoutTimer = setTimeout(fin, 15000) // 兜底: 防止队列卡死(子进程正常退出时会被取消)
  })).catch(() => {})
}

// ── 宿主侧"用户在看谁"判定 ────────────────────────────────────────────────
// 调 badge.ps1 isforeground: GetForegroundWindow + 进程名, 看前台窗口是不是 DSH 自己。
// 为什么不用页面里的 blur/focus: 桌面端那套事件实测一条都没上报(日志里 0 条客户端 away/back)。
function writeCountFile(n) {
  try { writeFileSync(COUNT_FILE, String(n)) } catch (err) {}
}

function probeForeground() {
  // 非 Windows: 没有 GetForegroundWindow 可用, 无从判断"用户在看谁"。
  // 按"离开"处理(count 照常累加), 让窗口内 DOM 兜底角标仍然有意义 —— 这正是 README 承诺的
  // 降级行为。关键是绝不 spawn 一个注定 ENOENT 的 powershell.exe。
  if (!IS_WINDOWS) return Promise.resolve(false)
  return new Promise((resolve) => {
    let out = ''
    let done = false
    let timer = null
    const fin = (v) => {
      if (done) return
      done = true
      // 必须清掉兜底定时器, 否则每来一次 turn/end 就把事件循环多挂 8 秒。
      if (timer) { clearTimeout(timer); timer = null }
      resolve(v)
    }
    try {
      const child = cp.spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH, 'isforeground'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      child.stdout.on('data', (d) => { out += String(d) })
      child.on('exit', () => fin(/^foreground/m.test(out)))
      child.on('error', (err) => {
        logLine({ kind: 'probe-error', error: String((err && err.message) || err) })
        fin(false)
      })
    } catch (err) {
      logLine({ kind: 'probe-error', error: String((err && err.message) || err) })
      fin(false)
    }
    timer = setTimeout(() => fin(false), PROBE_TIMEOUT_MS)
  })
}

// Windows 通知(右下角气泡): 与角标链路相互独立, 但通知之间也串行, 避免一次完成多个任务时
// 瞬间 spawn 一堆 PowerShell。注意 toast.ps1 必须由 Windows PowerShell 5.1 的 powershell.exe 执行。
let toastChain = Promise.resolve()
let toastPending = 0
const TOAST_MAX_PENDING = 6
// 由 apply() 设成 () => settings.notify。发之前和真正 spawn 之前各查一次,
// 这样"关掉通知"能连排队中的那条一起掐掉 —— 关闭就是关闭。
let toastGate = null
function scheduleToast(title, body) {
  // 非 Windows: WinRT ToastNotificationManager 不存在, toast.ps1 也跑不了。记一条审计就返回,
  // 不要在这里反复 spawn 失败的进程。
  if (!IS_WINDOWS) {
    logLine({ kind: 'toast-skip', reason: 'unsupported-platform', platform: process.platform, title: title })
    return
  }
  if (toastGate && !toastGate()) {
    logLine({ kind: 'toast-skip', reason: 'notify-off', title: title })
    return
  }
  if (toastPending >= TOAST_MAX_PENDING) {
    logLine({ kind: 'toast-drop', reason: 'queue-full', pending: toastPending, title: title })
    return
  }
  toastPending++
  toastChain = toastChain.then(() => new Promise((resolve) => {
    let done = false
    let timeoutTimer = null
    const fin = () => {
      if (!done) {
        done = true
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
        resolve()
      }
    }
    // 排队期间开关被关掉 -> 这一条也别弹了
    if (toastGate && !toastGate()) {
      logLine({ kind: 'toast-skip', reason: 'notify-off-while-queued', title: title })
      fin()
      return
    }
    try {
      const args = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TOAST_PATH,
        '-Title', String(title || ''), '-Body', String(body || ''),
      ]
      const child = cp.spawn(POWERSHELL, args, { stdio: 'ignore', windowsHide: true })
      child.on('exit', (code) => { logLine({ kind: 'toast', code, title: title, body: body }); fin() })
      child.on('error', (err) => { logLine({ kind: 'toast-error', error: String((err && err.message) || err) }); fin() })
    } catch (err) {
      logLine({ kind: 'toast-error', error: String((err && err.message) || err) })
      fin()
    }
    timeoutTimer = setTimeout(fin, 12000)
  })).catch(() => {}).then(() => { toastPending-- })
}

// 通知正文里的任务标识: 优先会话标题, 其次工作目录名
function sessionLabel(session) {
  const h = (session && session.header) || {}
  let label = h.title || h.name || ''
  if (!label && h.cwd) {
    const parts = String(h.cwd).split(/[\\/]+/).filter(Boolean)
    label = parts.length ? parts[parts.length - 1] : ''
  }
  if (!label && session && session.id) label = String(session.id).slice(-8)
  return String(label).slice(0, 60)
}

// 通知开关: config.toast > 环境变量 DSH_BADGE_TOAST > 默认 away
function resolveToastMode(config) {
  const raw = String((config && config.toast) || process.env.DSH_BADGE_TOAST || 'away').trim().toLowerCase()
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no' || raw === 'none') return 'off'
  if (raw === 'always' || raw === 'all' || raw === '1' || raw === 'on' || raw === 'yes' || raw === 'true') return 'always'
  return 'away'
}

// ── 设置页「弹窗角标通知」的两个开关 ────────────────────────────────────────
// badge  = 是否在任务栏 DSH 图标上显示红色数字角标(离开期间完成的任务数)
// notify = 是否弹 Windows 右下角通知
// 存盘: $DSH_HOME/dsh-done-badge.json；改完立即写盘 + 立即改内存状态, 所以设置页
// 上"点开就是开、点关就是关", 不需要重启 DSH。
function defaultSettings(config) {
  // 系统通知只有 Windows 有: 非 Windows 直接默认关闭, 免得设置页给出一个永远不会生效的开关。
  return { badge: true, notify: IS_WINDOWS && resolveToastMode(config) !== 'off' }
}
function loadSettings(config) {
  const out = defaultSettings(config)
  try {
    const j = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    if (j && typeof j === 'object') {
      if (typeof j.badge === 'boolean') out.badge = j.badge
      if (typeof j.notify === 'boolean') out.notify = j.notify
    }
  } catch (err) {} // 文件不存在/损坏都退回默认值
  // 即使配置文件里写着 notify:true(比如从 Windows 拷过来的), 非 Windows 也一律压成 false,
  // 这样 /dsh-badge/test 会老老实实回 notify-off, 而不是假装发出去。
  if (!IS_WINDOWS) out.notify = false
  return out
}
function saveSettings(s) {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify({ badge: !!s.badge, notify: !!s.notify }, null, 2))
  } catch (err) {
    logLine({ kind: 'settings-save-error', error: String((err && err.message) || err) })
  }
}

function apply(ctx, config) {
  const toastMode = resolveToastMode(config)
  const settings = loadSettings(config) // 设置页可改, 改了立刻生效
  toastGate = () => !!settings.notify // 通知链路的实时闸门(设置页关掉就立刻掐)
  let away = false
  let awayEpoch = 0
  let count = 0
  let lastTs = 0
  let shapeLogged = false
  let backClearTimer = null
  let watcher = null
  const disposers = []

  logLine({
    kind: 'boot', platform: process.platform, native: IS_WINDOWS,
    toastMode: toastMode, badge: settings.badge, notify: settings.notify,
    toastScript: TOAST_PATH, helper: HELPER_PATH, countFile: COUNT_FILE, configFile: CONFIG_FILE,
  })

  // 常驻守望进程: 一个"离开时段"只起一个 PowerShell。它自己画角标、自己看前台窗口、
  // 用户切回 DSH 后自己保留 2 秒再清掉并退出。期间又有任务完成, 宿主只更新计数文件即可。
  function startWatcher(n) {
    writeCountFile(n)
    // 非 Windows: 没有任务栏角标可画, 只维护计数文件(DOM 兜底角标靠它), 不 spawn。
    if (!IS_WINDOWS) return
    if (watcher) return
    try {
      const child = cp.spawn(POWERSHELL, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH,
        'watch', '-Count', String(n), '-CountFile', COUNT_FILE,
      ], { stdio: 'ignore', windowsHide: true })
      watcher = child
      child.on('exit', (code) => {
        if (watcher !== child) return
        watcher = null
        count = 0
        away = false
        lastTs = 0
        writeCountFile(0)
        logLine({ kind: 'watch-exit', code })
      })
      child.on('error', (err) => {
        if (watcher === child) watcher = null
        logLine({ kind: 'watch-error', error: String((err && err.message) || err) })
      })
    } catch (err) {
      watcher = null
      logLine({ kind: 'watch-error', error: String((err && err.message) || err) })
    }
  }

  disposers.push(ctx.on('session/event', (session, event) => {
    const type = event && event.type
    if (type !== 'turn/end') return
    const sid = session && session.id ? String(session.id) : 'default'
    // 首次事件: 记录会话对象与 header 的字段形状(验证识别逻辑的数据依据)
    if (!shapeLogged) {
      shapeLogged = true
      const h = session && session.header ? session.header : null
      logLine({
        kind: 'shape',
        sid,
        sessionKeys: Object.keys(session || {}),
        headerKeys: h ? Object.keys(h) : [],
        parentSession: h ? h.parentSession : undefined,
        eventKeys: Object.keys(event || {}),
        eventSample: JSON.stringify(event || {}).slice(0, 400),
      })
    }
    const isSub = isSubsession(session)
    const rootSid = rootOf(session)
    const reasonKind = turnReasonKind(event)
    const completed = isCompletedTurn(event)
    const before = count

    // 子代理会话 / 被中断的一轮: 不算数也不提醒(角标与通知共用这一个门槛, 保证数字一致)
    if (isSub || !completed) {
      logLine({
        kind: 'turn/end', reason: reasonKind, completed, away, epoch: awayEpoch, sid, rootSid, isSub,
        countBefore: before, countAfter: count, toast: toastMode,
        skipped: isSub ? 'subsession' : 'not-completed',
      })
      return
    }

    // 关键判定: 用户此刻是不是就坐在 DSH 前面? 由宿主问系统前台窗口(不靠页面 JS)
    probeForeground().then((foreground) => {
      away = !foreground
      if (foreground) {
        // 人就在 DSH 前面看着, 不累计、不画角标; 只有显式 always 才仍然弹通知
        if (settings.notify && toastMode === 'always') {
          const labelFg = sessionLabel(session)
          scheduleToast('DSH 任务完成', '已完成' + (labelFg ? ' · ' + labelFg : ''))
        }
      } else {
        count++
        lastTs = Date.now()
        // 角标开关关掉时: 计数照走(通知文案里的数字仍然对), 但不画角标
        if (settings.badge) startWatcher(count) // 常驻 watcher 负责画角标, 并在用户切回后清除
        if (settings.notify) {
          const label = sessionLabel(session)
          scheduleToast('DSH 任务完成', '已完成 ' + count + ' 个任务' + (label ? ' · ' + label : ''))
        }
      }
      logLine({
        kind: 'turn/end', reason: reasonKind, completed, foreground, away, epoch: awayEpoch, sid, rootSid,
        isSub, countBefore: before, countAfter: count, toast: settings.notify, badge: settings.badge,
      })
    })
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-badge/count.json',
    handler: async (req, res) => {
      sendJson(res, 200, { ok: true, away, epoch: awayEpoch, count, lastTs, badge: settings.badge, notify: settings.notify })
    },
  }))

  // 设置页「弹窗角标通知」的读写口: GET 读当前开关, POST {badge?,notify?} 改开关。
  // 改完立刻落内存 + 落盘, 并顺手把角标状态补成新开关该有的样子 —— 这就是"点开就是开"。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-badge/config',
    handler: async (req, res) => {
      const method = String((req && req.method) || 'GET').toUpperCase()
      const reply = (payload) => sendJson(res, 200, payload)
      const snapshot = () => ({
        ok: true, platform: process.platform, badge: settings.badge, notify: settings.notify,
        away, epoch: awayEpoch, count, lastTs,
      })
      if (method !== 'POST') return reply(snapshot())

      let body = ''
      const finish = () => {
        let patch = null
        try { patch = JSON.parse(body || '{}') } catch (err) { patch = null }
        if (!patch || typeof patch !== 'object') return reply({ ok: false, error: 'invalid-json' })
        const before = { badge: settings.badge, notify: settings.notify }
        if (typeof patch.badge === 'boolean') settings.badge = patch.badge
        // 非 Windows 上不允许把系统通知打开(没有 WinRT 可用), 统一压回 false。
        if (typeof patch.notify === 'boolean') settings.notify = IS_WINDOWS ? patch.notify : false
        saveSettings(settings)
        // 角标被关掉: 已经画在任务栏上的数字要立刻消失(计数保留, 通知文案仍用得上)
        if (!settings.badge && before.badge) {
          writeCountFile(0)
          scheduleOverlay(0)
        }
        // 角标被重新打开且当前有未清的计数: 立刻补画回去
        if (settings.badge && !before.badge && count > 0 && away) startWatcher(count)
        logLine({
          kind: 'settings', badge: settings.badge, notify: settings.notify,
          changedBadge: before.badge !== settings.badge, changedNotify: before.notify !== settings.notify,
        })
        reply(snapshot())
      }
      try {
        // 极端情况: 请求体在我们挂上监听器之前就已经读完了, 这时 'end' 永远不会再来,
        // 路由会一直挂到客户端超时。补一个"已经结束就直接收尾"的短路。
        if (req.readableEnded) { finish(); return }
        req.on('data', (chunk) => {
          if (body.length < 4096) body += String(chunk)
        })
        req.on('end', finish)
        req.on('error', () => reply({ ok: false, error: 'request-error' }))
      } catch (err) {
        reply({ ok: false, error: String((err && err.message) || err).slice(0, 200) })
      }
    },
  }))

  // 设置页的"发送测试通知": 不用等到真的有任务完成, 立刻验证通知能不能弹出来
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-badge/test',
    handler: async (req, res) => {
      const reply = (payload) => sendJson(res, 200, payload)
      // "关闭就是关闭": 通知开关关着时, 测试按钮也不许绕过设置弹气泡。
      if (!settings.notify) {
        logLine({ kind: 'toast-test-blocked', notify: false })
        return reply({ ok: false, error: 'notify-off', notify: false })
      }
      scheduleToast('DSH 任务完成', '这是一条测试通知 · 来自「弹窗角标通知」设置页')
      logLine({ kind: 'toast-test', notify: true })
      reply({ ok: true, notify: true })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-badge/away',
    handler: async (req, res) => {
      // 手动/测试钩子(真实运行时"是否离开"由前台窗口探测决定): 开一个新的离开时段
      if (backClearTimer) {
        clearTimeout(backClearTimer)
        backClearTimer = null
      }
      away = true
      awayEpoch++
      count = 0
      lastTs = 0
      writeCountFile(0)
      logLine({ kind: 'away-manual', epoch: awayEpoch })
      sendJson(res, 200, { ok: true, away, epoch: awayEpoch, count })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-badge/back',
    handler: async (req, res) => {
      // 手动/测试钩子(页面里点角标也走这里): 计数归零 -> watcher 自己清角标并退出
      away = false
      count = 0
      lastTs = 0
      writeCountFile(0)
      clearTimeout(backClearTimer)
      backClearTimer = setTimeout(() => scheduleOverlay(0), BACK_GRACE_MS)
      logLine({ kind: 'back', epoch: awayEpoch })
      sendJson(res, 200, { ok: true, away, epoch: awayEpoch, count })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-badge/badge.js',
    handler: (req, res) => {
      try {
        if (res.writableEnded || res.headersSent) return
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(CLIENT_JS)
      } catch (err) {}
    },
  }))

  // 把客户端脚本注入页面
  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf('/dsh-badge/badge.js') !== -1) return html
    const tag = '<script defer src="/dsh-badge/badge.js"></script>'
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  ctx.effect(() => () => {
    // 卸载/热重载时: 取消残留定时器, 停掉守望进程, 清除原生角标, 再注销注册项
    if (backClearTimer) {
      clearTimeout(backClearTimer)
      backClearTimer = null
    }
    try { writeCountFile(0) } catch (err) {}
    try { if (watcher) watcher.kill() } catch (err) {}
    watcher = null
    try { scheduleOverlay(0) } catch (err) {}
    for (const d of disposers) {
      try { d() } catch (err) {}
    }
  })
}

export { name, inject, apply }
