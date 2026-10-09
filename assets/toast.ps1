# dsh-done-badge Windows toast helper
#
# 用法(必须用 Windows PowerShell 5.1 的 powershell.exe, PowerShell 7 没有 WinRT 投影):
#   powershell -NoProfile -ExecutionPolicy Bypass -File toast.ps1 -Title "..." -Body "..." [-Tag xxx]
#   powershell -NoProfile -ExecutionPolicy Bypass -File toast.ps1 -Register     # 只注册 AppId, 不弹通知
#
# 实现: 把自定义 AppUserModelID 注册到 HKCU\Software\Classes\AppUserModelId,
#       再用 WinRT ToastNotificationManager 弹出右下角通知(不依赖任何第三方模块)。
# 失败时回退到 PowerShell 自带的 AppId, 保证通知仍能出现。
# 日志: %TEMP%\dsh-done-badge-toast.log (超 1MB 轮转)

param(
  [string]$Title = 'DSH 任务完成',
  [string]$Body = '',
  [string]$AppId = 'DeepSeek.Harness.Desktop',
  [string]$DisplayName = 'DeepSeek Harness',
  [string]$IconPath = '',
  [string]$Tag = '',
  [switch]$Register
)

$ErrorActionPreference = 'Stop'

$logPath = Join-Path $env:TEMP 'dsh-done-badge-toast.log'
$debug = $env:DSH_BADGE_DEBUG -eq '1'

function Write-Log([string]$line) {
  try {
    if (Test-Path -LiteralPath $logPath) {
      if ((Get-Item -LiteralPath $logPath).Length -gt 1MB) { Remove-Item -LiteralPath $logPath -Force }
    }
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch {}
}

function Escape-Xml([string]$value) {
  if ([string]::IsNullOrEmpty($value)) { return '' }
  return $value.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}

function Register-AppIdentity([string]$id, [string]$name, [string]$icon) {
  $key = "HKCU:\Software\Classes\AppUserModelId\$id"
  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name 'DisplayName' -Value $name -ErrorAction SilentlyContinue
  New-ItemProperty -Path $key -Name 'ShowInSettings' -Value 1 -PropertyType DWord -Force | Out-Null
  if ($icon -and (Test-Path -LiteralPath $icon)) {
    Set-ItemProperty -Path $key -Name 'IconUri' -Value $icon -ErrorAction SilentlyContinue
  }
}

try { Register-AppIdentity $AppId $DisplayName $IconPath }
catch { Write-Log "$(Get-Date -Format o) register failed: $($_.Exception.Message)" }

if ($Register) { exit 0 }

function Build-Xml([string]$t, [string]$b) {
  return @"
<toast activationType="foreground" launch="">
  <visual>
    <binding template="ToastGeneric">
      <text>$(Escape-Xml $t)</text>
      <text>$(Escape-Xml $b)</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Default" />
</toast>
"@
}

function Show-Toast([string]$id) {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml((Build-Xml $Title $Body))
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  if ($Tag) {
    try { $toast.Tag = $Tag; $toast.Group = 'dsh-done-badge' } catch {}
  }
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($toast)
}

try {
  Show-Toast $AppId
  if ($debug) { Write-Log "$(Get-Date -Format o) ok appid=$AppId title=$Title body=$Body" }
  exit 0
} catch {
  Write-Log "$(Get-Date -Format o) primary failed appid=${AppId}: $($_.Exception.Message)"
}

# 回退: PowerShell 自带 AppId, 兼容未注册成功的机器
try {
  $fallbackId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  Show-Toast $fallbackId
  Write-Log "$(Get-Date -Format o) ok(fallback) title=$Title"
  exit 0
} catch {
  Write-Log "$(Get-Date -Format o) fallback failed: $($_.Exception.Message)"
  exit 1
}
