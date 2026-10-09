# dsh-done-badge (+ Windows 通知)

DSH 任务完成提醒插件(ChatGPT/Codex 风格):窗口最小化/离开期间,**每完成一个顶层任务**(一整轮对话跑完)会同时:

1. 在 Windows 任务栏 DSH 图标上显示**红色数字角标**(1、2、3…实时累积)——切回主界面后角标保留 2 秒让人看清,再消失清零;
2. 在屏幕**右下角弹出 Windows 通知**(`DSH 任务完成 / 已完成 N 个任务 · 会话名`)。

通知与角标共用同一份状态机,所以两者数字永远一致(不会出现"角标 2 但弹了 3 次")。窗口内右上角 DOM 角标作为兜底。

"你现在是不是在看 DSH"由**宿主侧**判断:PowerShell 用 `GetForegroundWindow` 拿当前前台窗口,再看它的进程名是不是 DSH 自己。**不依赖页面里的 JS** —— DSH 桌面端页面里的 `blur`/`focus`/`visibilitychange` 实测根本不上报,所以判定权必须放在宿主,否则会出现"切回来了角标还赖着不走"。

## 平台

| 平台 | 任务栏角标 | 系统通知 | 窗口内 DOM 兜底角标 | 计数 |
| --- | --- | --- | --- | --- |
| Windows | ✅ `ITaskbarList3::SetOverlayIcon` | ✅ WinRT `ToastNotificationManager` | ✅ | ✅ |
| macOS / Linux | ❌ | ❌ | ✅ | ✅ |

非 Windows 上是**显式降级,不是带伤运行**:原生能力整体停用,不会去 spawn 一个注定失败的 `powershell.exe`;
系统通知的开关直接置灰并锁在关闭状态,`/dsh-badge/test` 老实返回 `notify-off`(而不是假装发出去);
计数照常累加,只是改用窗口内右上角的 DOM 红色数字角标来呈现。

## 提醒时机(重要,别搞错)

| 场景 | 会不会提醒 |
| --- | --- |
| 你正看着 DSH,任务完成 | **不提醒**(角标也不出) |
| 你切到抖音/微信/别的窗口(DSH 失焦或最小化),任务完成 | **提醒**:角标 +1 并弹通知 |
| 一个任务里跑了几十个 step / 勾掉几个 todo | **只在整轮真正结束时提醒一次**,不会逐步刷屏 |
| 一轮被中断 / 取消(没正常跑完) | **不提醒**,也不计数 |
| 同一个任务开了多个子代理 | 只算 1(子代理会话不计入) |

DSH 的事件模型是「一条用户消息 = 一个 turn = 一条 `turn/end`」:一轮对话里哪怕有几十个 `step/end`,也只在整轮结束时发一条 `turn/end`。插件**只监听 `turn/end`、从不监听 `step/end`**,所以提醒粒度天然就是「整个任务做完才提醒」,而不是「完成一个步骤就弹」。

## 特性

- 离开期间任务完成 → 任务栏角标持续显示,数量实时累积;**同时弹出一条 Windows 通知**;
- **子代理会话不计入**:一个任务启动多个子代理只 +1,也只弹一条通知;
- 切回主界面 → 角标保留 2 秒让人看清,然后消失,不再冒出;
- 串行更新队列:角标不会因 PowerShell 完成乱序而留下旧值;通知之间也串行,避免瞬间拉起一堆 PowerShell;
- **窗口定位按进程名**(`DeepSeek Harness`),不再依赖窗口标题——标题里带的是当前会话主题,每次都不一样;进程名匹配不到才退回标题关键字,多候选时取面积最大的可见顶层窗口;
- 零依赖:只使用系统自带 PowerShell(Windows PowerShell 5.1),无需安装任何运行时,也没有构建步骤。

## 安装

`lib/` 是**已经编译好并提交进仓库**的纯 ESM 产物,所以 clone 下来直接就是可用的插件,不需要 `npm run build`。

DSH 的插件是**挂在某个 profile 上**的(桌面端用 `desktop` profile),装配信息写在这个 profile 的 `package.json` 里:

```
%USERPROFILE%\.dsh\profiles\desktop\package.json
```

### 方式 A:本地克隆 + `link:`(自用 / 想改代码,推荐)

```sh
git clone https://github.com/3262253821/dsh-done-stage.git
```

然后编辑上面那个 profile 的 `package.json`,改**两处**:

```jsonc
{
  "dependencies": {
    // ① 路径换成你克隆到的位置, 用正斜杠, 路径里不要有空格
    "dsh-done-badge": "link:E:/path/to/dsh-done-stage"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ② 在数组里加一项(放在哪个位置都行)
        "dsh-done-badge"
      ]
    }
  }
}
```

再在该 profile 目录跑一次依赖安装(该目录是 pnpm 工程,有 `pnpm-lock.yaml`;DSH 自带一份 pnpm,也可以用你自己系统里的):

```sh
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm install
```

最后**重启 DSH 桌面应用**。插件在启动时随 profile 的 bundle 列表层叠加载,不重启不生效。

### 方式 B:直接从 GitHub 装(不想 clone)

把方式 A 的第 ① 步换成:

```jsonc
"dsh-done-badge": "github:3262253821/dsh-done-stage"
```

其余完全相同。缺点是没有本地源码可改。

### 方式 C:如果你的 DSH 构建里带 `dsh` 命令

```sh
dsh plugin --profile desktop add link:/path/to/dsh-done-stage
```

> ⚠️ **改 profile 的 `package.json` 之前先备份。** 如果插件把客户端的 `inject` 写错(见下面「开发注意」),
> DSH 会起不来并弹一个「禁用第三方插件、备份 profile patch 并重启」的崩溃框 —— 那个操作会把
> `dsh.profile.bundles` 清到只剩基础包,需要你手工把插件列表补回去。本插件已经用回归测试把这条钉死了。

## 设置界面「弹窗角标通知」

插件在**设置左导航**里加了一页 **弹窗角标通知**(和其它插件页并列),点进去是两个开关:

| 开关 | 作用 |
| --- | --- |
| **任务栏角标** | 是否在任务栏 DSH 图标上显示红色数字角标 |
| **Windows 通知** | 是否弹右下角系统通知气泡(非 Windows 上不可用,置灰) |

两个开关**立即生效**,不需要重启 DSH:关掉角标,任务栏上已经画着的数字会**当场消失**;重新打开且当前还有未清的计数,角标会**当场补画回来**。选择写在 `$DSH_HOME/dsh-done-badge.json`,重启后仍是上次的选择。页面上还有一个 **发送测试通知** 按钮,用来立刻验证通知能不能弹出来 —— 但 **Windows 通知**开关关着时这个按钮是禁用的,宿主路由也会直接拒绝(`{"ok":false,"error":"notify-off"}`),排队中的通知同样被掐掉:**关闭就是关闭,测试按钮也不例外**。

实现:客户端半边 `lib/client.js` 注册 `settings.section`(设置面板的"每功能一页"席位),页面轮询/写入宿主路由 `GET|POST /dsh-badge/config`;宿主改完立刻改内存状态并落盘,所以"点开就是开、点关就是关"。

## 通知开关(启动默认值)

**日常用设置页**那两个开关就够了(见上)。下面这套是给"还没重启 DSH / 想用配置文件定默认值"准备的:`cordis.patch.yml` 里的 `config.toast`,或环境变量 `DSH_BADGE_TOAST`(config 优先)。它决定的是**首次启动的默认值**,设置页一旦写过 `$DSH_HOME/dsh-done-badge.json`,就以那个文件为准。

| 值 | 行为 |
| --- | --- |
| `away`(默认) | 只有离开窗口期间完成任务才弹通知 |
| `always` | 每次任务完成都弹(即使你正看着 DSH) |
| `off` / `false` / `0` | 关闭通知,**角标仍然工作** |

## 诊断

任务栏角标或通知没出现时,查看:

```
%TEMP%\dsh-done-badge-helper.log    # 角标助手调用记录(含窗口句柄/匹配方式/失败原因)
%TEMP%\dsh-done-badge-toast.log     # 通知助手调用记录(成功仅在 DSH_BADGE_DEBUG=1 时写)
%TEMP%\dsh-done-badge-events.log    # 事件链日志(away/epoch/sid/isSub/count*/toast 模式,自动轮转 1MB)
```

排查提示:

- **先自检焦点判定**:`powershell -File assets\badge.ps1 isforeground` → 打印 `foreground proc=...`(人正看着 DSH)或 `background proc=...`(不在看)。如果你的 DSH 进程名不一样,用 `DSH_BADGE_WINDOW_PROC` 覆盖;
- 计数文件 `%TEMP%\dsh-done-badge-count.txt`:常驻角标进程每 700ms 读它,写 0 就会清角标并退出(手动清角标:把 0 写进去,或 `POST /dsh-badge/back`);
- `-> no-window`:没找到 DSH 窗口。可用 `DSH_BADGE_WINDOW_PROC`(进程名关键字,逗号分隔)覆盖匹配词,默认 `DeepSeek Harness,DeepSeekHarness,deepseek-harness`;
- 通知被系统静默:检查 **设置 → 系统 → 通知** 是否关闭,以及是否开了**专注助手/勿扰模式**;
- 通知里的应用名显示为 `DeepSeek Harness`:来自注册表 `HKCU\Software\Classes\AppUserModelId\DeepSeek.Harness.Desktop`。

## how it works

- **宿主侧焦点判定**:`turn/end` 时调 `assets/badge.ps1 isforeground` —— `GetForegroundWindow` 拿前台窗口,再看它的进程名是不是 DSH 自己(`DSH_BADGE_WINDOW_PROC` 可覆盖匹配词,默认 `DeepSeek Harness,DeepSeekHarness,deepseek-harness`)。是 → 人正看着,不计数也不提醒;不是 → 才算"离开";
- **服务端状态机**:监听 `session/event` 的 `turn/end`,先过「真正结束」门槛(`reason.kind` 命中 `aborted`/`cancelled`/`interrupted`/`stopped` 等的一轮直接忽略;拿不到 kind 时按完成处理,宁可多报不漏),再**只统计顶层会话**(`header.parentSession` 存在即子代理,跳过);判定为离开时:计数 +1 → 把新计数写进 `%TEMP%\dsh-done-badge-count.txt`,首次还要拉起常驻的 `badge.ps1 watch` 进程 → 同时经**独立串行队列**调用 `assets/toast.ps1` 弹通知;
- **角标维护走一个常驻进程**:`badge.ps1 watch` 画好数字后每 ~700ms 看一次前台窗口,并从计数文件读最新数字(所以离开期间又完成一个任务,数字自己会变成 2、3…),一旦发现用户切回 DSH,保留 2 秒后清掉角标并退出 —— **清除由它自己负责,不依赖页面回报**,所以不会再出现"回到 DSH 角标赖着不走";一个"离开时段"只起一个 PowerShell,不是每次完成都 spawn。**离开循环的每条路径(用户切回 / 计数归零 / 6 小时超时 / 内部异常)都会先把角标清成 0 再退出**,不会把数字永久留在任务栏上;
- **客户端**:只保留窗口内右上角 DOM 兜底角标(读 `/dsh-badge/count.json`,服务端说离开、且角标开关开着、且有计数时才显示),不再上报 `blur`/`focus`(桌面端不可靠,双头上报会互相打架);
- **窗口定位**:`EnumWindows` + `GetWindowThreadProcessId` 按进程名匹配(仅取可见、无 owner 的顶层窗口,多候选取面积最大);
- **通知**:注册自定义 AppUserModelID 到 `HKCU\Software\Classes\AppUserModelId`,再用 WinRT ToastGeneric 模板弹出;失败自动回退到 PowerShell 自带 AppId;
- **兜底**:窗口内右上角 DOM 红色数字角标(1.2s 轮询),浏览器版 / macOS 同样可用。

## 开发注意(两处踩过的坑,改客户端半边前必读)

1. **`inject` 有两套,别写混**:
   - `package.json` 的 `dsh.client.inject` 写的是 **npm 包名**(模块级提示),例如 `["@deepseek-ai/dsh-client-ui-slots"]`;
   - `lib/client.js` 里 `module.exports.inject` 必须写 **cordis 服务名**,本机只有这 8 个:`layout` / `locale` / `sessions` / `slots` / `theme` / `timer` / `uiWorkspace` / `workspaces`(本插件用 `["slots"]`)。
   - 若把服务名位置误写成包名,cordis 会永远停在 `pending (waiting for services: @deepseek-ai/dsh-client-ui-slots)` → `web boot: 1 entry did not activate` → **DSH 直接起不来**(报"应用无法启动或已意外停止")。此时点崩溃框的「禁用第三方插件、备份 profile patch 并重启」会把 `profiles/desktop/package.json` 的 `dsh.profile.bundles` 清到只剩 base + web-app,**需要手工把 bundle 列表补回去**。
2. **宿主不隔离 loader-entry 工厂**:客户端工厂里抛一个异常就会拖垮整个 web shell。所以 `require("react")` 要包 try/catch(拿不到就返回 `inject: []` 的 no-op 模块),`apply(ctx)` 也要先查 `ctx.slots.inject` 是否存在。
3. **宿主半边引 PowerShell 必须用默认导入**:写 `import cp from 'node:child_process'` 然后 `cp.spawn(...)`,**不要**写 `import { spawn } from 'node:child_process'`。ESM 从 CJS 内置模块取具名导入时,绑定是生成命名空间那一刻的**快照**,之后替换 `child_process.spawn`(测试里的假 spawn / 故障注入)对它完全无效;默认导入拿到的是 `module.exports` 本体,调用时才取属性,所以可被替换。这一条是实测出来的:第一次写具名导入时,回归测试里的假 spawn 根本没生效,真的拉起了 PowerShell。
4. **`assets/*.ps1` 必须存成 `UTF-8 with BOM`**:Windows PowerShell 5.1 读取**没有 BOM** 的 `.ps1` 时按系统 ANSI 代码页解码(中文 Windows 是 GBK),文件里的中文注释会被错误解码,字节错位后**整个脚本解析失败**(`Unexpected token '}' in expression or statement`),任务栏角标直接不工作。最坑的是 `pwsh` 7 和 `Parser::ParseFile` 都按 UTF-8 读,只会告诉你"0 errors" —— 只有真的用 `System32\WindowsPowerShell\v1.0\powershell.exe` 跑一遍才能发现,`test/ps1.test.mjs` 干的就是这件事。**用编辑器改完 `.ps1` 后记得确认 BOM 还在。**

## 测试

仓库自带一套**完全密闭**的回归测试,不需要装任何东西(只用 Node 内置能力), **不会真的弹通知、不会画任务栏角标、不会碰你的真实配置** —— 事件日志 / 计数文件 / 配置文件全部指向 `mkdtemp` 出来的临时目录,`powershell.exe` 被替换成假进程。

```sh
npm test          # = node test/client.test.mjs && node test/host.test.mjs && node test/ps1.test.mjs
```

| 文件 | 盯住的问题 |
| --- | --- |
| `test/client.test.mjs` | 客户端半边:工厂不抛异常、`inject` 必须是 cordis 服务名而不是 npm 包名、设置页确实注册到 `settings.section` 且能渲染、`react` 缺失时退化成 no-op、非 Windows 时页面上出现「仅 Windows」提示 |
| `test/host.test.mjs` | 宿主半边:离开才计数 / 在前台不计数 / 子代理与被中断的一轮不计数、`turn/end` 之外的 step 事件不打扰、"关闭就是关闭"(关了通知连测试按钮都拒绝且不 spawn)、设置立刻落盘、非法 JSON 不 500、响应头已发出时不再二次 `writeHead`、**非 Windows 全程 0 次 powershell spawn**、8s/12s/15s 兜底定时器不泄漏、卸载清理不抛异常且路由全注销 |
| `test/ps1.test.mjs` | 两个 PowerShell 助手:必须是 UTF-8 **BOM**,且能被 **Windows PowerShell 5.1** 真的解析通过 |

这两条是刻意的设计约束,别为了"省事"改掉:测试在 **import `lib/index.js` 之前**就把 `process.env.TEMP` / `process.env.DSH_HOME` 指到临时目录,并替换 `child_process.spawn` —— 因为 `index.js` 在模块作用域就把这些读成常量,晚一步就来不及了。

## files

```
lib/index.js       # 宿主半边:事件监听 + 状态机 + 设置/角标/通知路由 + 窗口内 DOM 兜底角标
lib/client.js      # 浏览器半边:设置左导航「弹窗角标通知」页(两个开关 + 测试通知)
assets/badge.ps1   # Windows 任务栏角标助手(ITaskbarList3::SetOverlayIcon,含 isforeground/watch 两个模式)
assets/toast.ps1   # Windows 右下角通知助手(WinRT ToastNotificationManager)
cordis.patch.yml   # bundle 挂载声明 + 通知开关默认值
test/              # 密闭回归测试(npm test)
```

## License

MIT
