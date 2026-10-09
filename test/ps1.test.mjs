// 回归护栏: PowerShell 助手脚本 assets/*.ps1
//
// 2026-10-09 真踩过: 给 badge.ps1 加"退出前清角标"时, 写文件的工具把它的 UTF-8 BOM 丢了。
// Windows PowerShell 5.1 读取**没有 BOM** 的 .ps1 时用的是系统 ANSI 代码页(中文 Windows = GBK),
// 于是文件里的中文注释被按 GBK 解码 -> 字节错位 -> 整个脚本解析失败:
//   At ...\assets\badge.ps1:253 char:1
//   + }
//   + ~
//   Unexpected token '}' in expression or statement.
// 后果: 任务栏角标功能**整个失效**(宿主每次 spawn 都是一个立刻退出码 1 的进程)。
//
// 阴险之处在于 pwsh 7 和 Parser::ParseFile 都按 UTF-8 读文件, 所以它们全报"0 errors" ——
// 只有**真的用 System32 下那个 Windows PowerShell 5.1 跑一遍**才能发现。
// 而插件就是这么调用它的(index.js 里的 POWERSHELL = 'powershell.exe'), 所以这里也这么验。
//
// 跑法: node test/ps1.test.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, '..', 'assets')
const FILES = ['badge.ps1', 'toast.ps1']

const results = []
function check(name, ok, extra) {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '   ' + JSON.stringify(extra)))
}

// ── 1. BOM: 这是"中文注释 + PS 5.1"组合能正常工作的前提 ─────────────────────
for (const f of FILES) {
  const buf = readFileSync(join(ASSETS, f))
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  check(f + ' 以 UTF-8 BOM 开头(PS 5.1 才会按 UTF-8 解码)', hasBom,
    hasBom ? undefined : 'first3=' + Array.from(buf.slice(0, 3)).map((b) => b.toString(16)).join(' '))
}

// ── 2. 真的用 Windows PowerShell 5.1 解析一遍 ───────────────────────────────
if (process.platform !== 'win32') {
  console.log('SKIP  Windows PowerShell 5.1 解析检查(当前平台是 ' + process.platform + ', 这些脚本本来也不在非 Windows 上跑)')
} else {
  const PS51 = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  for (const f of FILES) {
    const path = join(ASSETS, f)
    let out = ''
    let threw = null
    try {
      out = execFileSync(PS51, [
        '-NoProfile', '-NonInteractive', '-Command',
        '$e = $null; [System.Management.Automation.Language.Parser]::ParseFile(' +
          "'" + path + "', [ref]$null, [ref]$e) | Out-Null; " +
          '$e | ForEach-Object { "L" + $_.Extent.StartLineNumber + ": " + $_.Message }; ' +
          '"ERRCOUNT=" + @($e).Count',
      ], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    } catch (err) {
      threw = String((err && err.message) || err).split('\n')[0]
    }
    const m = /ERRCOUNT=(\d+)/.exec(out || '')
    const count = m ? Number(m[1]) : -1
    check(f + ' 能被 Windows PowerShell 5.1 解析', threw === null && count === 0,
      threw === null ? { errors: count, detail: String(out || '').trim().split('\n').slice(0, 4) } : threw)
  }
}

const failed = results.filter((r) => !r.ok)
console.log('\n==== ps1.test: ' + (results.length - failed.length) + '/' + results.length + ' passed ====')
if (failed.length) console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
process.exit(failed.length ? 1 : 0)
