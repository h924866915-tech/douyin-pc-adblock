# ============================================================================
# 抖音 PC 客户端 去广告 + 屏蔽自动更新 —— 一键部署（版本自适应，可重复执行）
#
# 用法（任选其一）：
#   1) 右键本文件 →「使用 PowerShell 运行」，按提示点 UAC 的「是」
#   2) 管理员 PowerShell：
#      powershell -ExecutionPolicy Bypass -File "<本文件路径>"
#
# 可选参数：
#   -DouyinRoot "D:\Apps\douyin"   客户端安装根目录（默认自动探测）
#   -NoRestart                     部署后不重启客户端
#
# 客户端升级 / 重装后 preload.js 会被覆盖，本脚本会自动重新注入，
# 并且自动识别新版版本号目录（如 8.9.0），无需修改脚本。
# ============================================================================
[CmdletBinding()]
param(
    [string]$DouyinRoot = 'C:\Program Files (x86)\ByteDance\douyin',
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $PSCommandPath
$Utf8 = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------- 0. 提权
function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) {
    Write-Host '需要管理员权限，正在提权（请在弹出的 UAC 窗口点「是」）…'
    $argLine = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($DouyinRoot -ne 'C:\Program Files (x86)\ByteDance\douyin') { $argLine += @('-DouyinRoot', "`"$DouyinRoot`"") }
    if ($NoRestart) { $argLine += '-NoRestart' }
    Start-Process 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList $argLine -Verb RunAs
    return
}

# ------------------------------------------------------- 1. 定位版本目录
function Get-VersionDir {
    param([string]$Root)
    if (-not (Test-Path $Root)) { throw "找不到抖音安装目录：$Root" }

    # 1) 首选启动器配置里的 cur_path
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
    # 2) 回退：扫描形如 x.y.z 的目录，取版本号最高者
    $cands = @()
    foreach ($d in Get-ChildItem $Root -Directory -ErrorAction SilentlyContinue) {
        if ($d.Name -match '^\d+\.\d+\.\d+') {
            if (Test-Path (Join-Path $d.FullName 'resources\app.asar')) {
                $cands += [pscustomobject]@{ Path = $d.FullName; Ver = [version]($d.Name -replace '[^0-9\.].*$', '') }
            }
        }
    }
    if ($cands.Count -gt 0) { return ($cands | Sort-Object Ver -Descending | Select -First 1).Path }
    throw "在 $Root 下找不到有效的版本目录（含 resources\app.asar）"
}

$App      = Get-VersionDir -Root $DouyinRoot
$Version  = Split-Path $App -Leaf
$Unpacked = Join-Path $App 'resources\app.asar.unpacked'
$Preload  = Join-Path $Unpacked 'preload.js'
$BakPre   = Join-Path $Unpacked 'preload.js.dshbak'
$BackupDir = Join-Path $Here 'backup'

Write-Host ''
Write-Host '============================================'
Write-Host " 客户端目录 : $App"
Write-Host " 版本       : $Version"
Write-Host '============================================'

if (-not (Test-Path $Preload)) { throw "找不到 preload.js：$Preload" }

# ------------------------------------------------------------ 2. 备份
Write-Host ''
Write-Host '[1/6] 备份原始文件'
New-Item -ItemType Directory -Force $BackupDir | Out-Null
if (-not (Test-Path $BakPre)) {
    Copy-Item $Preload $BakPre -Force
    Write-Host '      preload.js -> preload.js.dshbak'
} else {
    Write-Host '      备份已存在，保持首次的原始版本'
}
foreach ($pair in @(
    @{ src = (Join-Path $DouyinRoot 'launcher_config.json'); dst = 'launcher_config.json.orig' },
    @{ src = (Join-Path $App 'resources\app-update.yml');     dst = 'app-update.yml.orig' },
    @{ src = (Join-Path $App 'md5.json');                    dst = 'md5.json.orig' }
)) {
    $d = Join-Path $BackupDir $pair.dst
    if (-not (Test-Path $d) -and (Test-Path $pair.src)) { Copy-Item $pair.src $d -Force }
}
Write-Host '      配置备份完成'

# ----------------------------------------------------- 3. 部署模块
Write-Host ''
Write-Host '[2/6] 部署去广告模块'
$ModSrc = Join-Path $Here 'inject\douyin-ads.js'
if (-not (Test-Path $ModSrc)) { throw "缺少补丁文件：$ModSrc" }
Copy-Item $ModSrc (Join-Path $Unpacked 'douyin-ads.js') -Force
Write-Host "      douyin-ads.js -> $Unpacked"

# ------------------------------------------------------- 4. 注入
Write-Host ''
Write-Host '[3/6] 注入 preload.js'
$base = [IO.File]::ReadAllText($BakPre, $Utf8)
$marker = '/* hs_preload_bootstrap */'
$idx = $base.IndexOf($marker)
if ($idx -ge 0) { $base = $base.Substring(0, $idx) }
$append = [IO.File]::ReadAllText((Join-Path $Here 'inject\preload-append.js'), $Utf8)
$out = $base + "`r`n" + $marker + "`r`n" + $append
[IO.File]::WriteAllText($Preload, $out, $Utf8)

# 校验：注入段必须完整落盘（长度 + 首尾特征），失败自动回滚
$verify = [IO.File]::ReadAllText($Preload, $Utf8)
if ($verify.Length -ne $out.Length -or $verify.IndexOf('hs_preload_bootstrap') -lt 0 -or
    $verify.IndexOf("fn(require, __dirname, module, module.exports);") -lt 0) {
    Copy-Item $BakPre $Preload -Force
    throw 'preload.js 写入校验失败（内容不完整），已自动回滚'
}
Write-Host '      写入校验通过'

# 可选：node --check 语法检查（用 try/catch 兜住原生命令的 stderr，避免中断脚本）
$node = 'C:\Program Files\nodejs\node.exe'
if (Test-Path $node) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & $node --check $Preload 2>&1
        $rc = $LASTEXITCODE
    } catch {
        $rc = 0
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if ($rc -ne 0) {
        Copy-Item $BakPre $Preload -Force
        throw "preload.js 语法校验失败（node exit=$rc），已自动回滚"
    }
    Write-Host '      node --check 语法校验通过'
} else {
    Write-Host '      未安装 node，跳过语法校验'
}
Write-Host "      preload.js = $((Get-Item $Preload).Length) 字节"

# ------------------------------------------- 5. 屏蔽自动更新（四重）
Write-Host ''
Write-Host '[4/6] 屏蔽自动更新'

$lcJson = '{"app_name":"douyin","cur_path":"' + $Version + '","mid_path":"","need_update":false,"new_path":"","installer_path":""}'
[IO.File]::WriteAllText((Join-Path $DouyinRoot 'launcher_config.json'), $lcJson, $Utf8)
Write-Host '      launcher_config.json: need_update=false'

$yml = @"
provider: generic
channel: latest
url: https://127.0.0.1:9/douyin-update-disabled/
updaterCacheDirName: douyin-updater
"@
[IO.File]::WriteAllText((Join-Path $App 'resources\app-update.yml'), $yml, $Utf8)
Write-Host '      app-update.yml: 更新源已指向不可达地址'

$hosts = 'C:\Windows\System32\drivers\etc\hosts'
$hTxt = [IO.File]::ReadAllText($hosts)
if ($hTxt -notmatch 'douyin-update-block START') {
    $hTxt += "`r`n# ---- douyin-update-block START ----`r`n0.0.0.0 lf-douyin-pc-web.douyinstatic.com`r`n0.0.0.0 douyin-pc-web.douyinstatic.com`r`n# ---- douyin-update-block END ----`r`n"
    [IO.File]::WriteAllText($hosts, $hTxt)
    Write-Host '      hosts: 已添加更新 CDN 阻断'
} else {
    Write-Host '      hosts: 阻断已存在'
}
ipconfig /flushdns | Out-Null

# 防火墙：先清掉旧的（含指向旧版本目录的），再按当前版本重建
Get-NetFirewallRule -DisplayName 'Douyin-UpdateBlock-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-NetFirewallRule -Name $_.Name -ErrorAction SilentlyContinue }
$fwTargets = @(
    (Join-Path $App 'app_shell_updater.exe'),
    (Join-Path $App 'installer_downloader.exe'),
    (Join-Path $App 'resources\app.asar.unpacked\node_modules\@byted\electron-update-driver\exe\bin\x64\update-driver.exe'),
    (Join-Path $App 'resources\app.asar.unpacked\node_modules\@byted\electron-update-driver\exe\bin\x64\UpdateDriverDaemon.exe'),
    (Join-Path $App 'resources\app.asar.unpacked\node_modules\@byted\electron-update-driver\exe\bin\x64\UpdateDriverDaemonX64.exe')
)
$i = 0; $added = 0
foreach ($t in $fwTargets) {
    $i++
    if (Test-Path $t) {
        New-NetFirewallRule -DisplayName "Douyin-UpdateBlock-$i" -Direction Outbound -Program $t `
            -Action Block -Profile Any -Enabled True | Out-Null
        $added++
    }
}
Write-Host "      防火墙: 已阻断 $added 个更新相关进程出站"

try {
    Disable-ScheduledTask -TaskPath '\DouyinUser\DouyinGuard\' -TaskName 'LaunchDouyinGuard' -ErrorAction Stop | Out-Null
    Write-Host '      LaunchDouyinGuard: 已禁用（防还原）'
} catch {
    Write-Host "      LaunchDouyinGuard: $($_.Exception.Message)"
}

# ------------------------------------------------- 6. 同步 md5 清单
Write-Host ''
Write-Host '[5/6] 同步 md5.json 校验值'
$md5Path = Join-Path $App 'md5.json'
if (Test-Path $md5Path) {
    try {
        $j = [IO.File]::ReadAllText($md5Path, $Utf8) | ConvertFrom-Json
        $keys = @('resources\app.asar.unpacked\preload.js', 'resources\app-update.yml', 'launcher_config.json')
        foreach ($k in $keys) {
            $fp = Join-Path $App $k
            if (Test-Path $fp) { $j.files.$k = (Get-FileHash $fp -Algorithm MD5).Hash.ToLower() }
        }
        [IO.File]::WriteAllText($md5Path, ($j | ConvertTo-Json -Depth 6 -Compress), $Utf8)
        Write-Host '      md5.json 已与实际文件一致'
    } catch {
        Write-Host "      跳过（不影响使用）：$($_.Exception.Message)"
    }
} else {
    Write-Host '      本版本无 md5.json，跳过'
}

# --------------------------------------------------------- 7. 重启
Write-Host ''
if ($NoRestart) {
    Write-Host '[6/6] 已跳过重启（-NoRestart），下次启动客户端生效'
} else {
    Write-Host '[6/6] 重启客户端'
    foreach ($n in 'douyin_guard', 'douyin_tray', 'douyin_widget', 'douyin') {
        Get-Process $n -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }
    }
    Start-Sleep -Seconds 5
    $exe = Join-Path $DouyinRoot 'douyin.exe'
    if (Test-Path $exe) {
        Start-Process $exe
        Start-Sleep -Seconds 6
        Write-Host '      已重启'
    } else {
        Write-Host "      找不到启动器：$exe，请手动启动客户端"
    }
}

Write-Host ''
Write-Host '============================================'
Write-Host ' 部署完成，客户端已按新配置运行'
Write-Host ' 还原：同目录 restore-douyin.ps1'
Write-Host '============================================'
