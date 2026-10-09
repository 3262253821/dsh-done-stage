// 回归护栏: 浏览器半边 lib/client.js (设置页「弹窗角标通知」)
//
// 2026-09-30 真踩过的坑: module.exports.inject 里写成了 npm 包名而不是 cordis 服务名,
//   cordis 于是永远 pending ("waiting for services: @deepseek-ai/dsh-client-ui-slots"),
//   整个 web boot 以 "1 entry did not activate" 结束 -> DSH 桌面端直接起不来。
// 所以这里把四条底线钉死:
//   1) 工厂无论如何都不能抛 (宿主不隔离 loader-entry 工厂, 抛一个错 = 整个 shell 起不来);
//   2) inject 必须是 cordis 服务名, 不能是 npm 包名;
//   3) 设置页确实注册到了 settings.section, 而且真的能渲染出元素;
//   4) require("react") 拿不到时退化成 no-op 模块, 而不是抛异常。
//
// 跑法: node test/client.test.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(HERE, '..', 'lib', 'client.js')

// 本机 client 侧开放的 cordis 服务名(见 README「开发注意」)。写成包里那个 npm 名就会挂。
const CLIENT_SERVICE_KEYS = ['layout', 'locale', 'sessions', 'slots', 'theme', 'timer', 'uiWorkspace', 'workspaces']

const results = []
function check(name, ok, extra) {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '   ' + JSON.stringify(extra)))
}

// ── 假的 react: 够 client.js 组件体跑一遍就行(抓 ReferenceError / typo) ────────
// useState 的初值可以被 hookPresets 覆盖, 用来把组件渲染在"某个特定 state"下。
let hookSlot = 0
let hookPresets = []
const fakeReact = {
  createElement: (...a) => ({ __el: a }),
  useState: (init) => {
    const i = hookSlot++
    return [i < hookPresets.length ? hookPresets[i] : init, () => {}]
  },
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
  useMemo: (f) => f(),
  Fragment: 'Fragment',
  cloneElement: (el) => el,
}
function render(Component, presets) {
  hookSlot = 0
  hookPresets = presets || []
  return Component({})
}

// ── 抓取 __ModuleLoader__.load 注册的定义 ─────────────────────────────────────
let captured = null
global.window = { __ModuleLoader__: { load(def) { captured = def } } }
await import(pathToFileURL(CLIENT_PATH).href)
check('client.js 调用了 window.__ModuleLoader__.load', !!captured && typeof captured.factory === 'function')

const okRequire = (name) => {
  if (name === 'react') return fakeReact
  throw new Error('unknown module ' + name)
}

// ── 1. 正常路径 ──────────────────────────────────────────────────────────────
let mod = null
let factoryThrew = null
try { mod = captured.factory(okRequire) } catch (err) { factoryThrew = String((err && err.stack) || err) }
check('工厂正常返回、不抛异常', factoryThrew === null && !!mod, factoryThrew && factoryThrew.split('\n')[0])
check('导出了 apply / inject / name',
  !!mod && typeof mod.apply === 'function' && Array.isArray(mod.inject) && mod.name === 'dsh-done-badge',
  mod && { name: mod.name, inject: mod.inject })
check('inject 全是 cordis 服务名(没有 npm 包名)',
  !!mod && mod.inject.length > 0 && mod.inject.every((k) => CLIENT_SERVICE_KEYS.indexOf(k) >= 0), mod && mod.inject)

// ── 2. 注册设置页 ────────────────────────────────────────────────────────────
let registered = null
let applyThrew = null
try {
  mod.apply({
    slots: {
      inject(name, fn) { if (name === 'settings.section') fn() },
      register(desc, Component) { registered = { desc, Component }; return () => {} },
    },
  })
} catch (err) { applyThrew = String((err && err.stack) || err) }
check('apply 不抛异常', applyThrew === null, applyThrew && applyThrew.split('\n')[0])
check('注册了 settings.section「弹窗角标通知」',
  !!registered && registered.desc.id === 'done-badge' && registered.desc.label === '弹窗角标通知' && typeof registered.Component === 'function',
  registered && registered.desc)

// ── 3. 组件真的能渲染 ────────────────────────────────────────────────────────
let rendered = null
let renderThrew = null
try { rendered = render(registered.Component) } catch (err) { renderThrew = String((err && err.stack) || err) }
check('首帧渲染不抛异常(state 还没拉回来)', renderThrew === null, renderThrew && renderThrew.split('\n').slice(0, 3).join(' | '))
check('渲染产出了元素', !!rendered && typeof rendered === 'object', rendered && typeof rendered)

// 拉回 state 之后再渲染一次(读 status 那几条线上更容易踩 typo)
const winState = { ok: true, platform: 'win32', badge: true, notify: true, count: 2, away: true, epoch: 1, lastTs: Date.now() }
let renderedWin = null
let renderWinThrew = null
try { renderedWin = render(registered.Component, [winState]) } catch (err) { renderWinThrew = String((err && err.stack) || err) }
check('有 state 时渲染不抛异常', renderWinThrew === null, renderWinThrew && renderWinThrew.split('\n')[0])
const winTree = JSON.stringify(renderedWin)
check('Windows 上显示实时计数文案', renderWinThrew === null && winTree.indexOf('当前离开期间已完成 2 个任务') >= 0)
check('Windows 上测试通知按钮可用(不出现"仅 Windows")', winTree.indexOf('仅 Windows') < 0)

// ── 4. 非 Windows: 设置页必须收敛掉"按了也不会生效"的开关 ────────────────────
const macState = { ok: true, platform: 'darwin', badge: true, notify: false, count: 0, away: false, epoch: 0, lastTs: 0 }
let renderedMac = null
let renderMacThrew = null
try { renderedMac = render(registered.Component, [macState]) } catch (err) { renderMacThrew = String((err && err.stack) || err) }
const macTree = JSON.stringify(renderedMac)
check('非 Windows 上渲染不抛异常', renderMacThrew === null, renderMacThrew && renderMacThrew.split('\n')[0])
check('非 Windows 上出现"仅 Windows"提示', macTree.indexOf('仅 Windows') >= 0)
check('非 Windows 上说明系统通知不可用', macTree.indexOf('WinRT') >= 0)
check('非 Windows 上按钮文案标注了平台限制', macTree.indexOf('发送测试通知（仅 Windows）') >= 0)

// ── 5. 降级路径: ctx 缺 slots ────────────────────────────────────────────────
let threw = null
try { mod.apply({}) } catch (err) { threw = String((err && err.message) || err) }
check('ctx.slots 缺失时不抛异常(静默跳过设置页)', threw === null, threw)

// ── 6. 降级路径: require("react") 失败 ───────────────────────────────────────
let degraded = null
let degradedThrew = null
try { degraded = captured.factory(() => { throw new Error('missed the module table') }) } catch (err) { degradedThrew = String((err && err.message) || err) }
check('react 拿不到时工厂不抛异常', degradedThrew === null, degradedThrew)
check('react 拿不到时退化成 no-op 模块',
  !!degraded && typeof degraded.apply === 'function' && Array.isArray(degraded.inject) && degraded.inject.length === 0,
  degraded && { name: degraded.name, inject: degraded.inject })

// ── 7. 加载器 id 就是包名(宿主按它去 exports["./client"] 取模块) ──────────────
check('模块加载器 id 是包名', !!captured && captured.id === 'dsh-done-badge', captured && captured.id)

const failed = results.filter((r) => !r.ok)
console.log('\n==== client.test: ' + (results.length - failed.length) + '/' + results.length + ' passed ====')
if (failed.length) console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
process.exit(failed.length ? 1 : 0)
