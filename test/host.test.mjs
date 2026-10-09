// 回归护栏: 宿主半边 lib/index.js (计数 / 角标 / 通知 / 设置路由)
//
// 这个文件盯的是"能让人把插件卸了"的那几类问题:
//   1) 非 Windows 上无脑 spawn powershell.exe -> ENOENT 被吃掉 -> probeForeground 恒 false
//      -> "用户永远不在电脑前" -> 每个 turn/end 都计数。★ 核心断言: 非 Windows 下 spawn 次数必须为 0。
//   2) probeForeground 的 8 秒兜底定时器不清 -> 每完成一个任务就把事件循环多挂 8 秒。
//   3) 响应头已经发出还再调 res.writeHead -> ERR_HTTP_HEADERS_SENT 把宿主路由打崩。
//   4) 子代理会话 / 被中断的一轮 混进计数, 导致一个任务算成好几个。
//   5) "关了通知但测试按钮还能弹" —— 设置页说关了就必须真关。
//
// 安全性: 全程不碰真实环境。事件日志 / 计数文件 / 配置文件都指向 mkdtemp 出来的临时目录;
//   powershell.exe 被换成一个假的 spawn, 所以既不会真弹通知, 也不会真画任务栏角标。
//
// 跑法: node test/host.test.mjs
import { EventEmitter } from 'node:events'
import cp from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = join(HERE, '..', 'lib', 'index.js')

const results = []
function check(name, ok, extra) {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '   ' + JSON.stringify(extra)))
}

// ── 定时器审计 ────────────────────────────────────────────────────────────────
// 只关心"长定时器"(>=5s): probeForeground 8s / toast 12s / overlay 15s 三个兜底。
// 它们正常都该在被 clearTimeout 掉, 任何活到最后的都是泄漏。
const timerRegistry = new Map()
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
globalThis.setTimeout = function (fn, ms, ...rest) {
  const id = realSetTimeout(function () {
    timerRegistry.delete(id)
    if (typeof fn === 'function') fn()
  }, ms, ...rest)
  timerRegistry.set(id, ms)
  return id
}
globalThis.clearTimeout = function (id) {
  timerRegistry.delete(id)
  return realClearTimeout(id)
}
const longTimers = () => Array.from(timerRegistry.values()).filter((ms) => ms >= 5000)
// 自己等待时用真实定时器, 免得污染审计表
const settle = (ms) => new Promise((r) => realSetTimeout(r, ms === undefined ? 45 : ms))

// ── 完全隔离的运行目录 ────────────────────────────────────────────────────────
// index.js 在模块作用域就把 TEMP / DSH_HOME 读成常量, 所以必须在 import 之前设好。
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-done-badge-host-'))
process.env.TEMP = sandbox
process.env.DSH_HOME = sandbox
delete process.env.DSH_BADGE_TOAST

// ── 假 spawn: 必须在 import index.js 之前装上 ─────────────────────────────────
// ESM 从 CJS 取具名导入是在合成模块求值时快照的, import 之后再改 child_process.spawn 就没用了。
function installSpawnStub() {
  const calls = []
  const probes = []
  const real = cp.spawn
  cp.spawn = function (cmd, args, opts) {
    const a = (args || []).map(String)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    let alive = true
    child.kill = () => { alive = false; child.emit('exit', null) }
    const isProbe = a.indexOf('isforeground') !== -1
    const isWatch = a.indexOf('watch') !== -1
    const isToast = a.some((s) => s.endsWith('toast.ps1'))
    const kind = isProbe ? 'probe' : isWatch ? 'watch' : isToast ? 'toast' : 'overlay'
    calls.push({ cmd, args: a, kind, child })
    // watcher 是常驻进程: 真跑起来要等用户切回 DSH 才退出(可能几十分钟),
    // 这里绝不能让它在 setImmediate 里"立刻退出", 否则 startWatcher 的 exit 回调会把计数清零。
    if (isWatch) return child
    setImmediate(() => {
      if (!alive) return
      if (isProbe) child.stdout.emit('data', (probes.length ? probes.shift() : 'background') + ' proc=4242\n')
      child.emit('exit', 0)
    })
    return child
  }
  return {
    calls, probes, real,
    queueProbe(v) { probes.push(v) },
    stop() { cp.spawn = real },
  }
}
const sh = installSpawnStub()

// ── 假的 cordis ctx / req / res ───────────────────────────────────────────────
function makeCtx() {
  const routes = new Map()
  const handlers = new Map()
  const taps = []
  let cleanup = null
  return {
    routes, handlers, taps,
    getCleanup: () => cleanup,
    ctx: {
      on(type, fn) { handlers.set(type, fn); return () => handlers.delete(type) },
      effect(fn) { cleanup = fn() }, // index.js 是 ctx.effect(() => () => {...})
      webServer: {
        register(def) { routes.set(def.path, def.handler); return () => routes.delete(def.path) },
        tapIndex(fn) { taps.push(fn); return () => {} },
      },
    },
  }
}

function call(routes, path, opts) {
  const o = opts || {}
  const handler = routes.get(path)
  if (!handler) return Promise.resolve({ status: 0, body: 'no-route:' + path })
  return new Promise((resolve) => {
    let settled = false
    const done = (r) => { if (!settled) { settled = true; resolve(r) } }
    const req = new EventEmitter()
    req.method = o.method || 'GET'
    const res = {
      status: 0, body: '', headersSent: false, writableEnded: false,
      writeHead(code) { this.status = code; this.headersSent = true; return this },
      end(s) { this.body = s === undefined ? '' : String(s); this.writableEnded = true; done(this) },
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => done({ status: -1, body: String((err && err.message) || err) }))
    if (o.body !== undefined) setImmediate(() => { req.emit('data', o.body); req.emit('end') })
  })
}
const json = (r) => { try { return JSON.parse(r.body) } catch (err) { return { parseError: r.body } } }
const turnEnd = (handlers, session, event) => handlers.get('session/event')(session, event)

// ════════════════════════════════════════════════════════════════════════════
// A. Windows 行为
// ════════════════════════════════════════════════════════════════════════════
const A = makeCtx()
let applyThrew = null
try {
  const index = await import(pathToFileURL(INDEX_PATH).href)
  index.apply(A.ctx, {})
} catch (err) { applyThrew = String((err && err.stack) || err) }
check('apply 不抛异常', applyThrew === null, applyThrew && applyThrew.split('\n')[0])

const boot = json(await call(A.routes, '/dsh-badge/config'))
check('boot: GET /dsh-badge/config 正常', boot.ok === true && boot.badge === true, boot)
check('boot: 路由全部注册到位',
  ['/dsh-badge/count.json', '/dsh-badge/config', '/dsh-badge/test', '/dsh-badge/away', '/dsh-badge/back', '/dsh-badge/badge.js']
    .every((p) => A.routes.has(p)), Array.from(A.routes.keys()))

if (process.platform === 'win32') {
  check('Windows: 通知默认打开(toast 模式 away)', boot.notify === true && boot.platform === 'win32', boot)

  // ── A1. 用户不在 DSH 前面 -> 计数 +1, 并且真的起了 watcher + 通知 ──
  const topSession = { id: 'sess-a', header: { title: '写一个插件', cwd: 'E:\\work\\demo' } }
  const t1 = sh.calls.length
  sh.queueProbe('background')
  turnEnd(A.handlers, topSession, { type: 'turn/end', reason: { kind: 'completed' } })
  await settle()
  const c1 = json(await call(A.routes, '/dsh-badge/count.json'))
  check('离开(前台不是 DSH)时 turn/end 计数 +1', c1.count === 1 && c1.away === true, c1)
  const kinds1 = sh.calls.slice(t1).map((c) => c.kind)
  check('计数同时起了常驻 watcher 与通知', kinds1.indexOf('watch') >= 0 && kinds1.indexOf('toast') >= 0, kinds1)

  // ── A2. 用户就坐在 DSH 前面 -> 不计数、不起 watcher ──
  const t2 = sh.calls.length
  sh.queueProbe('foreground')
  turnEnd(A.handlers, topSession, { type: 'turn/end', reason: { kind: 'completed' } })
  await settle()
  const c2 = json(await call(A.routes, '/dsh-badge/count.json'))
  check('用户就在 DSH 前面时不计数', c2.count === 1 && c2.away === false, c2)
  check('前景命中时只探测、不起 watcher/通知', sh.calls.slice(t2).map((c) => c.kind).join(',') === 'probe', sh.calls.slice(t2).map((c) => c.kind))

  // ── A3. 子代理会话不算 ──
  const t3 = sh.calls.length
  turnEnd(A.handlers, { id: 'child-1', header: { parentSession: 'sess-a', title: '子代理' } }, { type: 'turn/end', reason: { kind: 'completed' } })
  await settle()
  const c3 = json(await call(A.routes, '/dsh-badge/count.json'))
  check('子代理会话不计入(一个任务多子代理只算 1)',
    c3.count === 1 && sh.calls.length === t3, { count: c3.count, newSpawns: sh.calls.length - t3 })

  // ── A4. 被中断的一轮不算 ──
  const t4 = sh.calls.length
  turnEnd(A.handlers, topSession, { type: 'turn/end', reason: { kind: 'aborted' } })
  await settle()
  const c4 = json(await call(A.routes, '/dsh-badge/count.json'))
  check('被中断的一轮不计入也不提醒', c4.count === 1 && sh.calls.length === t4, { count: c4.count, newSpawns: sh.calls.length - t4 })

  // ── A5. 非 turn/end 的事件一律忽略 ──
  const t5 = sh.calls.length
  turnEnd(A.handlers, topSession, { type: 'turn/start' })
  turnEnd(A.handlers, topSession, { type: 'step/end' })
  await settle()
  check('只认 turn/end(step/start 不打扰)', sh.calls.length === t5, sh.calls.slice(t5).map((c) => c.kind))
} else {
  console.log('SKIP  Windows 专属断言(当前平台是 ' + process.platform + ')')
}

// ── A6. "关闭就是关闭" ──
const t6 = sh.calls.length
const testOn = json(await call(A.routes, '/dsh-badge/test'))
await settle()
check('通知开着时测试通知能发', testOn.ok === true && sh.calls.slice(t6).some((c) => c.kind === 'toast'), testOn)

const offCfg = json(await call(A.routes, '/dsh-badge/config', { method: 'POST', body: JSON.stringify({ notify: false }) }))
const t7 = sh.calls.length
const testOff = json(await call(A.routes, '/dsh-badge/test'))
await settle()
check('关掉通知后测试按钮被拒(关闭就是关闭)', offCfg.notify === false && testOff.ok === false && testOff.error === 'notify-off', testOff)
check('被拒时不 spawn 任何通知进程', sh.calls.length === t7, sh.calls.slice(t7).map((c) => c.kind))

// ── A7. 设置立刻落盘 ──
let saved = null
try { saved = JSON.parse(readFileSync(join(sandbox, 'dsh-done-badge.json'), 'utf8')) } catch (err) {}
check('设置改动立刻写盘(无需重启)', !!saved && saved.notify === false, saved)

// ── A8. 非法请求体不会 500 ──
const badBody = json(await call(A.routes, '/dsh-badge/config', { method: 'POST', body: '{ not json' }))
check('非法 JSON 回 invalid-json 而不是抛错', badBody.ok === false && badBody.error === 'invalid-json', badBody)

// ── A9. 响应头已发出时不再二次 writeHead (ERR_HTTP_HEADERS_SENT 回归) ──
let doubleThrow = null
const sentRes = {
  status: 0, headersSent: true, writableEnded: false,
  writeHead() { throw new Error('writeHead called after headers already sent') },
  end() { throw new Error('end called after headers already sent') },
}
try { await A.routes.get('/dsh-badge/count.json')(new EventEmitter(), sentRes) } catch (err) { doubleThrow = String((err && err.message) || err) }
check('响应头已发出时静默放弃(不再二次 writeHead)', doubleThrow === null, doubleThrow)

// ── A10. 客户端脚本注入 ──
const page = '<html><body><div id="app"></div></body></html>'
const injected = A.taps.length ? A.taps[0](page) : page
check('tapIndex 在 </body> 前注入客户端脚本',
  injected.indexOf('<script defer src="/dsh-badge/badge.js"></script></body>') >= 0, injected)
check('tapIndex 幂等(已注入就不再插)', A.taps.length > 0 && A.taps[0](injected) === injected)

const jsRes = await call(A.routes, '/dsh-badge/badge.js')
check('badge.js 路由返回客户端脚本', jsRes.status === 200 && jsRes.body.indexOf("el.id = 'dsh-done-badge'") >= 0 && jsRes.body.indexOf('function ()') >= 0)

// ── A11. 定时器不泄漏 ──
await settle()
check('没有残留的长定时器(8s/12s/15s 兜底都被清掉)', longTimers().length === 0, longTimers())

// ── A12. 卸载清理 ──
let cleanupThrew = null
try { A.getCleanup()() } catch (err) { cleanupThrew = String((err && err.message) || err) }
check('卸载清理不抛异常', cleanupThrew === null, cleanupThrew)
check('卸载后路由全部注销(热重载不留残骸)', A.routes.size === 0, A.routes.size)

// ════════════════════════════════════════════════════════════════════════════
// B. 非 Windows 降级: 一个 powershell 都不许 spawn
// ════════════════════════════════════════════════════════════════════════════
const macSandbox = mkdtempSync(join(tmpdir(), 'dsh-done-badge-mac-'))
process.env.TEMP = macSandbox
process.env.DSH_HOME = macSandbox
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

const B = makeCtx()
let macThrew = null
try {
  // 加查询串绕过 ESM 模块缓存, 让 index.js 在 IS_WINDOWS=false 下重新求值一次
  const macIndex = await import(pathToFileURL(INDEX_PATH).href + '?platform=darwin')
  macIndex.apply(B.ctx, {})
} catch (err) { macThrew = String((err && err.stack) || err) }
check('非 Windows: apply 不抛异常', macThrew === null, macThrew && macThrew.split('\n')[0])

const spawnsBefore = sh.calls.length
const mBoot = json(await call(B.routes, '/dsh-badge/config'))
check('非 Windows: config 报 platform=darwin', mBoot.platform === 'darwin', mBoot)
check('非 Windows: 系统通知默认关闭(不给永远不生效的开关)', mBoot.notify === false, mBoot)

const mPost = json(await call(B.routes, '/dsh-badge/config', { method: 'POST', body: JSON.stringify({ notify: true }) }))
check('非 Windows: 不允许把系统通知打开', mPost.notify === false, mPost)

const mTest = json(await call(B.routes, '/dsh-badge/test'))
check('非 Windows: 测试通知被拒(notify-off)', mTest.ok === false && mTest.error === 'notify-off', mTest)

sh.queueProbe('background') // 队列里放着也没人消费 -> 证明 probe 根本没 spawn
turnEnd(B.handlers, { id: 'mac-1', header: { title: 'mac 上的任务' } }, { type: 'turn/end', reason: { kind: 'completed' } })
await settle()
const mCount = json(await call(B.routes, '/dsh-badge/count.json'))
check('非 Windows: 计数仍然工作(窗口内 DOM 兜底角标)', mCount.count === 1 && mCount.away === true, mCount)

let mBack = null
try { mBack = json(await call(B.routes, '/dsh-badge/back')) } catch (err) { mBack = { error: String(err.message) } }
check('非 Windows: /dsh-badge/back 正常', mBack.ok === true && mBack.count === 0, mBack)

await settle()
const leaked = sh.calls.slice(spawnsBefore).map((c) => c.kind)
check('★ 非 Windows: 全程 0 次 powershell spawn', leaked.length === 0, leaked)
check('非 Windows: 没有残留的长定时器', longTimers().length === 0, longTimers())

// 审计日志必须留下平台证据
let audit = ''
try { audit = readFileSync(join(macSandbox, 'dsh-done-badge-events.log'), 'utf8') } catch (err) {}
check('非 Windows: 审计日志写明 native=false', audit.indexOf('"native":false') >= 0)

sh.stop()

const failed = results.filter((r) => !r.ok)
console.log('\n==== host.test: ' + (results.length - failed.length) + '/' + results.length + ' passed ====')
if (failed.length) console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
process.exit(failed.length ? 1 : 0)
