<#
  DSH Web UI 启动器 — 启动（或直接打开）DeepSeek Harness 的 Web UI（web 模式）。

  互动窗口:
    - 窗口生命周期 = 服务器生命周期: 服务器停止(无论何种原因)后窗口倒计时关闭
    - 因此 "窗口还在" 恒等于 "服务器还在跑", 关闭窗口/Ctrl+C 即停止服务器
    - 端口被其他程序占用时, 提供互动选择: 换端口启动 / 打开占用程序页面 / 退出

  残留主进程处理:
    - 端口上的 DSH 服务器若已无宿主(启动它的窗口/进程已退出), 视为残留主进程:
      启动时自动停止它并重新启动, 保证双击快捷方式 = 干净重启
    - 只处理主进程; ACP agent 等子进程不在清理范围(脱离存活属预期)

  用法:
    dsh-web.ps1                 启动 Web 服务器; 若已在运行则直接打开浏览器
    dsh-web.ps1 -Status         仅显示运行状态
    dsh-web.ps1 -Stop           停止端口上的 Web 服务器(仅主进程)
    dsh-web.ps1 -Port 63848     覆盖首选端口
    dsh-web.ps1 -NoOpen         就绪后不自动打开浏览器
#>
param(
    [switch]$Stop,
    [switch]$Status,
    [switch]$NoOpen,
    [int]$Port = 63848
)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'DSH Web UI'

# 首选监听端口(默认 63848, 可用 -Port 覆盖)
$Repo = 'G:\projects\deepseek-harness'
$Cli  = Join-Path $Repo 'apps\cli\src\bin.ts'
$Node = 'C:\Program Files\nodejs\node.exe'
$Url  = "http://localhost:$Port"
$Log  = Join-Path $env:USERPROFILE '.dsh\launcher-web.log'

function Test-DshServer([int]$P) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$P/" -UseBasicParsing -TimeoutSec 3
        return ($r.StatusCode -eq 200 -and $r.Content -match '__DSH_BOOT__')
    } catch {
        return $false
    }
}

function Test-PortBusy([int]$P) {
    try {
        $c = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        return ($null -ne $c)
    } catch {
        return $false
    }
}

function Get-ListenerPid([int]$P) {
    try {
        $c = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { return $c.OwningProcess }
    } catch { }
    return $null
}

function Test-ProcessAlive([int]$ProcId) {
    return ($null -ne (Get-Process -Id $ProcId -ErrorAction SilentlyContinue))
}

function Show-Error([string]$Msg) {
    Write-Host $Msg
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($Msg, 'DSH Web UI') | Out-Null
    } catch { }
}

function Stay-Open {
    # 窗口常驻: 不自动退出, 由用户自行关闭窗口
    while ($true) { Start-Sleep -Seconds 3600 }
}

# 服务器已死: 说明原因并倒计时关窗, 保证 "窗口在 = 服务器在" 恒成立
function Close-Window-After([string]$Reason, [int]$Seconds = 10) {
    Write-Host ""
    Write-Host $Reason
    # 死因现场: 日志最后 30 行同时打到窗口(完整日志在 $Log)
    if (Test-Path $Log) {
        Write-Host ""
        Write-Host "──── 服务器日志最后 30 行 (完整: $Log) ────"
        Get-Content $Log -Tail 30 | ForEach-Object { Write-Host "  $_" }
        Write-Host "────────────────────────────────────"
    }
    Write-Host "服务器已停止, 本窗口将在 $Seconds 秒后自动关闭。"
    for ($i = $Seconds; $i -gt 0; $i--) {
        Write-Host -NoNewline "`r剩余 $i 秒  "
        Start-Sleep -Seconds 1
    }
}

# 从 start 起向上找第一个空闲端口
function Find-FreePort([int]$start) {
    $p = $start
    while ($p -lt 65535 -and (Test-PortBusy $p)) { $p++ }
    return $p
}

# 在前台启动 DSH Web 服务器, 等待就绪后打开浏览器; 窗口常驻直到用户关闭
function Start-DshWebAndServe([int]$usePort) {
    $useUrl = "http://localhost:$usePort"
    Write-Host "正在启动 DSH Web UI (端口 $usePort) ..."
    Write-Host "服务器日志将显示在本窗口; Ctrl+C 或关闭窗口可停止服务器。"
    Write-Host ""

    # 输出经内层 powershell tee 到 $Log: 窗口照常显示, 磁盘留档; 内层与 node 同控制台,
    # 关窗/Ctrl+C 仍然连着服务器一起退出(窗口 ⟺ 服务器 不变)
    Set-Content -Path $Log -Value "=== dsh web started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') port $usePort ==="
    $openFlag = if ($NoOpen) { ' --no-open' } else { '' }
    $inner = "& '$Node' --import tsx/esm '$Cli' web --port $usePort$openFlag 2>&1 | Tee-Object -FilePath '$Log' -Append"
    $p = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner) `
        -WorkingDirectory $Repo `
        -NoNewWindow `
        -PassThru

    $deadline = (Get-Date).AddSeconds(90)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-DshServer $usePort) { $ready = $true; break }
        if ($p.HasExited) { break }
        Start-Sleep -Milliseconds 800
    }

    if ($ready) {
        Write-Host ""
        Write-Host "DSH Web UI 已就绪: $useUrl"
        if (-not $NoOpen) { Start-Process $useUrl }
        Write-Host "服务器日志将显示在本窗口; 关闭窗口或 Ctrl+C 即停止服务器。"
        $p.WaitForExit()
        Close-Window-After "服务器进程已退出。" 10
        return
    }

    $errMsg = "等待 DSH Web UI 就绪超时或服务器异常退出。"
    if ($p.HasExited) { $errMsg += "`n进程退出码: $($p.ExitCode)" }
    Write-Host $errMsg
    Show-Error $errMsg
    Close-Window-After $errMsg 15
}

if ($Stop) {
    $pid0 = Get-ListenerPid $Port
    if ($pid0) {
        # 只停主进程, 不树杀: ACP agent 等子进程按约定保留
        & taskkill /PID $pid0 /F | Out-Null
        Write-Host "已停止 Web 服务器主进程 (PID $pid0, 端口 $Port); ACP agent 子进程未清理。"
    } else {
        Write-Host "端口 $Port 上没有正在运行的 Web 服务器"
    }
    exit 0
}

if ($Status) {
    if (Test-DshServer $Port) {
        Write-Host "DSH Web UI 正在运行: $Url (PID $(Get-ListenerPid $Port))"
    } else {
        Write-Host "DSH Web UI 未运行 (端口 $Port)"
    }
    if (Test-Path $Log) {
        Write-Host ""
        Write-Host "──── $Log 最后 10 行 ────"
        Get-Content $Log -Tail 10 | ForEach-Object { Write-Host "  $_" }
    }
    exit 0
}

# —— 残留主进程清扫 ——
# 关窗后未死/旧版分离启动的主服务器会占着端口和 task-board 账本锁,
# 导致新实例无法启动(报 "ledger is already owned by process ...")。
# 只清主进程(bin.ts web): 父进程已退出视为残留; ACP agent 等子进程不动。
function Get-DshMainServers {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine -match 'bin\.ts\s+web\s'
    }
}

function Get-StaleDshMainServers {
    @(Get-DshMainServers) | Where-Object { -not (Test-ProcessAlive ([int]$_.ParentProcessId)) }
}

$staleMains = @(Get-StaleDshMainServers)
foreach ($s in $staleMains) {
    Write-Host ("发现残留主进程 PID {0} (启动它的窗口已退出), 正在停止 (ACP agent 子进程不动) ..." -f $s.ProcessId)
    & taskkill /PID $s.ProcessId /F | Out-Null
}
if ($staleMains.Count -gt 0) {
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and @(Get-StaleDshMainServers).Count -gt 0) {
        Start-Sleep -Milliseconds 300
    }
    Start-Sleep -Seconds 1
}

# —— 首选端口已有 DSH 服务器: 打开浏览器, 窗口常驻刷新状态 ——
if (Test-DshServer $Port) {
    Write-Host ""
    Write-Host "DSH Web UI 已在运行: $Url (PID $(Get-ListenerPid $Port))"
    Start-Process $Url
    Write-Host "浏览器已打开。本窗口常驻显示状态, 关闭窗口即退出。"
    Write-Host ""
    while ($true) {
        if (Test-DshServer $Port) {
            Write-Host ("[{0}] 运行中 (PID {1})" -f (Get-Date -Format 'HH:mm:ss'), (Get-ListenerPid $Port))
        } else {
            Write-Host ("[{0}] 服务器已停止" -f (Get-Date -Format 'HH:mm:ss'))
        }
        Start-Sleep -Seconds 10
    }
}

# —— 兜底: 服务器曾被默认端口(3080)手动启动过 ——
if (Test-DshServer 3080) {
    Write-Host ""
    Write-Host "DSH Web UI 已在运行: http://localhost:3080"
    Start-Process 'http://localhost:3080'
    Write-Host "浏览器已打开。本窗口常驻显示状态, 关闭窗口即退出。"
    Write-Host ""
    while ($true) {
        if (Test-DshServer 3080) {
            Write-Host ("[{0}] 运行中 (PID {1})" -f (Get-Date -Format 'HH:mm:ss'), (Get-ListenerPid 3080))
        } else {
            Write-Host ("[{0}] 服务器已停止" -f (Get-Date -Format 'HH:mm:ss'))
        }
        Start-Sleep -Seconds 10
    }
}

if (-not (Test-Path $Cli)) { Show-Error "找不到 CLI: $Cli"; exit 1 }
if (-not (Test-Path $Node)) { Show-Error "找不到 node: $Node"; exit 1 }

# —— 端口被其他程序占用: 互动选择 ——
if (Test-PortBusy $Port) {
    $busyPid = Get-ListenerPid $Port
    Write-Host ""
    Write-Host "端口 $Port 已被其他程序占用 (PID $busyPid), 不是 DSH Web UI。"
    Write-Host ""
    Write-Host "请选择:"
    Write-Host "  [1] 换一个空闲端口启动 DSH Web UI"
    Write-Host "  [2] 直接打开 http://localhost:$Port (可能是占用它的程序)"
    Write-Host "  [3] 退出"
    $choice = Read-Host "请输入 1/2/3"
    switch ($choice.Trim()) {
        '2' {
            Write-Host "已打开 $Url (该端口不属于 DSH)。"
            Start-Process $Url
            Stay-Open
        }
        '3' { Write-Host "已退出。"; exit 0 }
        default {
            $free = Find-FreePort $Port
            Write-Host ""
            Write-Host "建议使用空闲端口 $free 启动 DSH Web UI。"
            $input = Read-Host "直接回车确认, 或输入其他端口"
            if ($input.Trim() -ne '') {
                $num = 0
                if ([int]::TryParse($input.Trim(), [ref]$num) -and $num -ge 1 -and $num -le 65535) {
                    $free = $num
                } else {
                    Write-Host "无效端口, 使用建议端口 $free"
                    Start-Sleep -Seconds 2
                }
            }
            Start-DshWebAndServe $free
            exit 0
        }
    }
}

# —— 正常路径: 用首选端口启动 ——
Start-DshWebAndServe $Port
exit 0
