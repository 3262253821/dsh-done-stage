# dsh-done-badge taskbar overlay helper (Windows)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File badge.ps1 set <N>
#        powershell -NoProfile -ExecutionPolicy Bypass -File badge.ps1 clear
#
# 窗口定位: 优先按"拥有窗口的进程名"匹配(标题里带的是会话主题, 每次都不一样, 不能依赖),
#           进程名匹配不到再退回按标题关键字匹配。多候选时取面积最大的可见顶层窗口。
# 可用环境变量覆盖匹配词(逗号分隔):
#   DSH_BADGE_WINDOW_PROC   进程名关键字, 默认 "DeepSeek Harness,DeepSeekHarness,deepseek-harness"
#   DSH_BADGE_WINDOW_TITLE  标题关键字,   默认 "DeepSeek Harness,Deepseek Harness"
param(
  [string]$Action = 'clear',
  [int]$Count = 0,
  [string]$CountFile = ''
)

Add-Type -AssemblyName System.Drawing

$procMatch = if ($env:DSH_BADGE_WINDOW_PROC) { $env:DSH_BADGE_WINDOW_PROC } else { 'DeepSeek Harness,DeepSeekHarness,deepseek-harness' }
$titleMatch = if ($env:DSH_BADGE_WINDOW_TITLE) { $env:DSH_BADGE_WINDOW_TITLE } else { 'DeepSeek Harness,Deepseek Harness' }

$sharp = @'
using System;
using System.Runtime.InteropServices;

public delegate bool WinEnumProc(IntPtr hWnd, IntPtr lParam);

public static class TaskbarBadge {
  [ComImport, Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ITaskbarList3 {
    void HrInit();
    void AddTab(IntPtr hwnd);
    void DeleteTab(IntPtr hwnd);
    void ActivateTab(IntPtr hwnd);
    void SetActiveAlt(IntPtr hwnd);
    void MarkFullscreenWindow(IntPtr hwnd, bool fFullscreen);
    void SetProgressValue(IntPtr hwnd, ulong ullCompleted, ulong ullTotal);
    void SetProgressState(IntPtr hwnd, int tbpFlags);
    void RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
    void UnregisterTab(IntPtr hwndTab);
    void SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
    void SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, int dwReserved);
    void ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
    void ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
    void ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
    void SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, string pszDescription);
    void SetThumbnailTooltip(IntPtr hwnd, string pszTip);
    void SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
  }

  [ComImport]
  [Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
  [ClassInterface(ClassInterfaceType.None)]
  class TaskbarList { }

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }

  const uint GW_OWNER = 4;

  [DllImport("user32.dll")] static extern bool EnumWindows(WinEnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  // 进程名关键字(强匹配) / 标题关键字(弱匹配)
  public static string[] ProcKeys = new string[0];
  public static string[] TitleKeys = new string[0];
  public static string MatchInfo = "";

  static System.Collections.Generic.Dictionary<uint, string> pidCache = new System.Collections.Generic.Dictionary<uint, string>();
  static IntPtr bestProc = IntPtr.Zero; static long bestProcArea = -1; static string bestProcName = "";
  static IntPtr bestTitle = IntPtr.Zero; static long bestTitleArea = -1; static string bestTitleName = "";

  static bool ContainsAny(string s, string[] keys) {
    if (string.IsNullOrEmpty(s) || keys == null) return false;
    for (int i = 0; i < keys.Length; i++) {
      string k = keys[i].Trim();
      if (k.Length == 0) continue;
      if (s.IndexOf(k, StringComparison.OrdinalIgnoreCase) >= 0) return true;
    }
    return false;
  }

  static string ProcNameOf(uint pid) {
    string cached;
    if (pidCache.TryGetValue(pid, out cached)) return cached;
    string name = "";
    try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { name = ""; }
    pidCache[pid] = name;
    return name;
  }

  static bool EnumCb(IntPtr hWnd, IntPtr lParam) {
    if (!IsWindowVisible(hWnd)) return true;
    if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true;   // 跳过对话框/工具窗口

    var sb = new System.Text.StringBuilder(512);
    GetWindowText(hWnd, sb, 512);
    string title = sb.ToString();

    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    string proc = ProcNameOf(pid);

    RECT r;
    long area = 0;
    if (GetWindowRect(hWnd, out r)) area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);

    if (ContainsAny(proc, ProcKeys)) {
      if (area > bestProcArea) { bestProcArea = area; bestProc = hWnd; bestProcName = proc; }
    } else if (ContainsAny(title, TitleKeys)) {
      if (area > bestTitleArea) { bestTitleArea = area; bestTitle = hWnd; bestTitleName = title; }
    }
    return true;
  }

  static IntPtr FindMainWindow() {
    bestProc = IntPtr.Zero; bestProcArea = -1;
    bestTitle = IntPtr.Zero; bestTitleArea = -1;
    pidCache.Clear();
    EnumWindows(new WinEnumProc(EnumCb), IntPtr.Zero);
    if (bestProc != IntPtr.Zero) {
      MatchInfo = "byProc proc=" + bestProcName;
      return bestProc;
    }
    if (bestTitle != IntPtr.Zero) {
      MatchInfo = "byTitle title=" + bestTitleName;
      return bestTitle;
    }
    MatchInfo = "no-window";
    return IntPtr.Zero;
  }

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

  // 当前前台窗口是不是 DSH 自己 -> 判断"用户此刻到底在不在看 DSH"(不依赖页面里的 JS)
  public static string IsForeground() {
    pidCache.Clear();
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero) return "background";
    uint pid;
    GetWindowThreadProcessId(fg, out pid);
    string proc = ProcNameOf(pid);
    if (ContainsAny(proc, ProcKeys)) return "foreground proc=" + proc;
    var sb = new System.Text.StringBuilder(512);
    GetWindowText(fg, sb, 512);
    string title = sb.ToString();
    if (ContainsAny(title, TitleKeys)) return "foreground title=" + title;
    return "background proc=" + proc;
  }

  public static IntPtr CreateNumberIcon(int count) {
    var bmp = new System.Drawing.Bitmap(32, 32);
    using (var g = System.Drawing.Graphics.FromImage(bmp)) {
      g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
      g.Clear(System.Drawing.Color.Transparent);
      using (var brush = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(224, 42, 47)))
        g.FillEllipse(brush, 1, 1, 30, 30);
      string text = count > 99 ? "99+" : count.ToString();
      using (var f = new System.Drawing.Font("Segoe UI", count >= 10 ? 13f : 15f, System.Drawing.FontStyle.Bold, System.Drawing.GraphicsUnit.Point))
      using (var sf = new System.Drawing.StringFormat { Alignment = System.Drawing.StringAlignment.Center, LineAlignment = System.Drawing.StringAlignment.Center }) {
        var sz = g.MeasureString(text, f);
        g.DrawString(text, f, System.Drawing.Brushes.White, new System.Drawing.RectangleF(0, (32 - sz.Height) / 2 + 1, 32, sz.Height), sf);
      }
    }
    return bmp.GetHicon();
  }

  public static string Set(int count) {
    IntPtr hwnd = FindMainWindow();
    if (hwnd == IntPtr.Zero) return "no-window";
    var list = (ITaskbarList3)(object)new TaskbarList();
    list.HrInit();
    if (count > 0) {
      IntPtr icon = CreateNumberIcon(count);
      list.SetOverlayIcon(hwnd, icon, count + " tasks finished");
    } else {
      list.SetOverlayIcon(hwnd, IntPtr.Zero, "");
    }
    return "ok hwnd=" + hwnd + " " + MatchInfo;
  }
}
'@

Add-Type -TypeDefinition $sharp -ReferencedAssemblies System.Drawing.dll
[TaskbarBadge]::ProcKeys = $procMatch -split ','
[TaskbarBadge]::TitleKeys = $titleMatch -split ','

# 日志策略: 失败必记; 成功仅在调试模式 (DSH_BADGE_DEBUG=1) 下记录; 超 1MB 轮转
$logPath = "$env:TEMP\dsh-done-badge-helper.log"
function Write-Log($line) {
  try {
    if (Test-Path $logPath) {
      if ((Get-Item $logPath).Length -gt 1MB) { Remove-Item $logPath -Force }
    }
    Add-Content -Path $logPath -Value $line -Encoding UTF8
  } catch {}
}
function Write-Result($label, $result) {
  if ($result -eq 'no-window' -or $env:DSH_BADGE_DEBUG -eq '1') {
    Write-Log "$(Get-Date -Format o) $label -> $result"
  }
}

# 只回答一个问题: 用户此刻是不是在看 DSH (宿主侧判断, 不依赖页面 JS)
if ($Action -eq 'isforeground') {
  try { Write-Output ([TaskbarBadge]::IsForeground()) } catch { Write-Output 'background' }
  exit 0
}

# 长驻守望: 画出角标 -> 轮询前台窗口 -> 用户切回 DSH (或计数归零) 后清掉角标再退出。
# 计数从 -CountFile 读, 所以后台又完成任务时宿主只要改文件即可, 不用重启本进程。
if ($Action -eq 'watch') {
  # 6 小时是防呆上限: 宿主异常退出时不要留一个永不退出的轮询进程。
  # ⚠️ 但超时退出时也必须把角标清掉 —— 早期版本这里直接 exit 0, 于是任务栏上的红数字
  #    会永久赖着不走(宿主那边已经把 watcher 置空、计数文件写成 0, 却再没有人去画 0)。
  $deadline = (Get-Date).AddHours(6)
  $last = -1
  while ((Get-Date) -lt $deadline) {
    $n = $Count
    if ($CountFile -and (Test-Path $CountFile)) {
      try {
        $t = (Get-Content $CountFile -Raw -ErrorAction Stop).Trim()
        if ($t -match '^\d+$') { $n = [int]$t }
      } catch {}
    }
    if ($n -lt 1) {
      try { [void][TaskbarBadge]::Set(0) } catch {}
      Write-Log "$(Get-Date -Format o) watch -> stop (count=0)"
      break
    }
    if ($n -ne $last) {
      try {
        $r = [TaskbarBadge]::Set($n)
        if ($r -notlike 'no-window*') { $last = $n }
        Write-Result "watch set $n" $r
      } catch {
        Write-Log "$(Get-Date -Format o) watch set $n -> $($_.Exception.Message)"
      }
      Start-Sleep -Milliseconds 800
      continue
    }
    if ([TaskbarBadge]::IsForeground() -like 'foreground*') {
      Start-Sleep -Seconds 2
      try {
        $r = [TaskbarBadge]::Set(0)
        Write-Log "$(Get-Date -Format o) watch -> clear $r (back to front)"
      } catch {}
      break
    }
    Start-Sleep -Milliseconds 700
  }
  # 收尾兜底: 不管是因为用户切回、计数归零, 还是 6 小时超时/内部异常离开循环,
  # 都无条件再清一次。Set(0) 是幂等的, 多调一次没有代价; 漏调一次角标就会永久卡在任务栏上。
  try { [void][TaskbarBadge]::Set(0) } catch { Write-Log "$(Get-Date -Format o) watch -> clear on exit failed: $($_.Exception.Message)" }
  exit 0
}

if ($Action -eq 'set' -and $Count -gt 0) {
  try {
    $result = [TaskbarBadge]::Set($Count)
    Write-Result "set $Count" $result
    if ($result -eq 'no-window') { exit 1 }
  } catch {
    Write-Log "$(Get-Date -Format o) set $Count -> $($_.Exception.Message)"
    exit 1
  }
} else {
  try {
    $result = [TaskbarBadge]::Set(0)
    Write-Result "clear" $result
    if ($result -eq 'no-window') { exit 1 }
  } catch {
    Write-Log "$(Get-Date -Format o) clear -> $($_.Exception.Message)"
    exit 1
  }
}
exit 0
