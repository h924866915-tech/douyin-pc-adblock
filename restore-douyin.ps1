# ============================================================================
# 抖音 PC 客户端 —— 一键还原（撤销去广告与更新屏蔽，版本自适应）
#
# 用法：右键「使用 PowerShell 运行」，或在管理员 PowerShell 中执行本文件
# 可选参数：-DouyinRoot "D:\Apps\douyin"   -NoRestart
# ============================================================================
[CmdletBinding()]
param(
    [string]$DouyinRoot = 'C:\Program Files (x86)\ByteDance\douyin',
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $PSCommandPath
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) {
    Write-Host '需要管理员权限，正在提权（请在 UAC 窗口点「是」）…'
    Start-Process 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"" -Verb RunAs
    return
}

function Get-VersionDir {
    param([string]$Root)
    if (-not (Test-Path $Root)) { throw "找不到抖音安装目录：$Root" }
    $lc = Join-Path $Root 'launcher_config.json'
    if (Test-Path $lc) {
        try {
            $j = Get-Content $lc -Raw | ConvertFrom-Json
            if ($j.cur_path) {
                $p = Join-Path $Root $j.cur_path
                if (Test-Path (Join-Path $p 'resources\app.asar')) { return $p }
            }
        } catch {}
    }
    $cands = @()
    foreach ($d in Get-ChildItem $Root -Directory -ErrorAction SilentlyContinue) {
        if ($d.Name -match '^\d+\.\d+\.\d+' -and (Test-Path (Join-Path $d.FullName 'resources\app.asar'))) {
            $cands += [pscustomobject]@{ Path = $d.FullName; Ver = [version]($d.Name -replace '[^0-9\.].*$', '') }
        }
    }
    if ($cands.Count -gt 0) { return ($cands | Sort-Object Ver -Descending | Select -First 1).Path }
    throw "在 $Root 下找不到版本目录"
}

$App       = Get-VersionDir -Root $DouyinRoot
$Version   = Split-Path $App -Leaf
$Unpacked  = Join-Path $App 'resources\app.asar.unpacked'
$Preload   = Join-Path $Unpacked 'preload.js'
$BakPre    = Join-Path $Unpacked 'preload.js.dshbak'
$BackupDir = Join-Path $Here 'backup'

Write-Host "客户端：$App（$Version）"

Write-Host ''
Write-Host '[1/5] 还原 preload.js 并移除注入模块'
if (Test-Path $BakPre) {
    Copy-Item $BakPre $Preload -Force
    Write-Host '      preload.js 已还原为原始文件'
} else {
    Write-Host '      未找到 preload.js.dshbak（可能是新版覆盖过），跳过'
}
Remove-Item (Join-Path $Unpacked 'douyin-ads.js') -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '[2/5] 还原更新配置'
# app-update.yml 恢复为官方地址（不依赖旧备份，升级后同样适用）
$officialYml = @"
provider: generic
channel: latest
url: https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/douyin-pc-client/releases/
updaterCacheDirName: douyin-updater
"@
[IO.File]::WriteAllText((Join-Path $App 'resources\app-update.yml'), $officialYml, $Utf8)
Write-Host '      app-update.yml: 已恢复官方更新地址'

$lcJson = '{"app_name":"douyin","cur_path":"' + $Version + '","mid_path":"","need_update":false,"new_path":"","installer_path":""}'
[IO.File]::WriteAllText((Join-Path $DouyinRoot 'launcher_config.json'), $lcJson, $Utf8)
Write-Host '      launcher_config.json: 已复位'

$md5Bak = Join-Path $BackupDir 'md5.json.orig'
if ((Test-Path $md5Bak) -and (Test-Path (Join-Path $App 'md5.json'))) {
    Copy-Item $md5Bak (Join-Path $App 'md5.json') -Force
    Write-Host '      md5.json: 已恢复原始清单'
}

Write-Host ''
Write-Host '[3/5] 清理 hosts'
$hosts = 'C:\Windows\System32\drivers\etc\hosts'
$h = [IO.File]::ReadAllText($hosts)
$h2 = [regex]::Replace($h, '(?s)\r?\n# ---- douyin-update-block START ----.*?# ---- douyin-update-block END ----\r?\n', "`r`n")
if ($h2 -ne $h) { [IO.File]::WriteAllText($hosts, $h2); Write-Host '      已移除阻断条目' } else { Write-Host '      无阻断条目' }
ipconfig /flushdns | Out-Null

Write-Host ''
Write-Host '[4/5] 移除防火墙规则'
Get-NetFirewallRule -DisplayName 'Douyin-UpdateBlock-*' -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-NetFirewallRule -Name $_.Name -ErrorAction SilentlyContinue
    Write-Host "      已移除 $($_.DisplayName)"
}

Write-Host ''
try {
    Enable-ScheduledTask -TaskPath '\DouyinUser\DouyinGuard\' -TaskName 'LaunchDouyinGuard' -ErrorAction Stop | Out-Null
    Write-Host '[5/5] LaunchDouyinGuard 已启用'
} catch {
    Write-Host "[5/5] LaunchDouyinGuard: $($_.Exception.Message)"
}

if (-not $NoRestart) {
    foreach ($n in 'douyin_guard', 'douyin_tray', 'douyin_widget', 'douyin') {
        Get-Process $n -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }
    }
    Start-Sleep -Seconds 5
    $exe = Join-Path $DouyinRoot 'douyin.exe'
    if (Test-Path $exe) { Start-Process $exe }
    Write-Host '客户端已重启。'
} else {
    Write-Host '已跳过重启（-NoRestart）。'
}
Write-Host '还原完成。'
