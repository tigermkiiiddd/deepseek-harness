<#
  DSH Web UI 启动器 — 启动（或直接打开）DeepSeek Harness 的 Web UI（web 模式）。

  互动窗口:
    - 窗口生命周期 = 服务器生命周期: 服务器停止(无论何种原因)后窗口倒计时关闭
    - 因此 "窗口还在" 恒等于 "服务器还在跑", 关闭窗口/Ctrl+C 即停止服务器
    - 双击 = 干净重启: 先清掉固定端口上旧的 DSH Web UI 主进程, 再原地重新启动
    - 端口被非 DSH 程序占用时: 报告冲突并中止(不自动换端口), 需要换端口请用 -Port 显式指定

  残留主进程处理:
    - 只清 DSH 自己的主进程(bin.ts web); ACP agent 等子进程不在清理范围(脱离存活属预期)

  用法:
    dsh-web.ps1                 固定端口上干净重启 Web 服务器(清旧起新)
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

# 服务端开了浏览器会话鉴权: 裸 / 返回 401, 有效 token 才会 303。
# 启动器把 node 打印的 token URL(带 ?token=) tee 到 $Log, 再探一次 303 确认端口真在听。
# 注意: 内层 shell 是 Windows PowerShell 5.1, Tee-Object 默认以 UTF-16 写日志, 而日志头是 Set-Content
# 按系统码页写的单字节文本——同一文件混了两种编码。按单一编码整读会丢 token(曾把健康服务器误判成
# "就绪超时", 窗口倒计时关闭时连带杀掉服务器)。故 Get-LatestToken 分别按 UTF-16 / 默认码页取日志头部
# 行再匹配, 两种落盘形态都覆盖; token 行紧跟日志头, 前 200 行足够。
function Get-LatestToken {
    if (-not (Test-Path $Log)) { return $null }
    foreach ($enc in @('Unicode', 'Default')) {
        $token = $null
        foreach ($line in (Get-Content $Log -TotalCount 200 -Encoding $enc -ErrorAction SilentlyContinue)) {
            if ($line -match 'token=([A-Za-z0-9_-]+)') { $token = $Matches[1] }
        }
        if ($token) { return $token }
    }
    return $null
}

function Test-DshAuthProbe([int]$P, [string]$Token) {
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$P/?token=$Token")
        $req.AllowAutoRedirect = $false
        $req.KeepAlive = $false
        $req.Timeout = 3000
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return ($code -eq 303)
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            return ([int]$_.Exception.Response.StatusCode -eq 303)
        }
        return $false
    } catch {
        return $false
    }
}

function Test-DshServer([int]$P) {
    # 最强信号: token 探 303(端口在听且 token 有效)
    $token = Get-LatestToken
    if ($token -and (Test-DshAuthProbe $P $token)) { return $true }
    # token 不可用(日志尚未写出/读不到)或 token 探测失败: 退回裸 / 状态码
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$P/" -UseBasicParsing -TimeoutSec 3
        # 200 + boot 标记 = 未开鉴权的旧配置, 就绪
        return ($r.StatusCode -eq 200 -and $r.Content -match '__DSH_BOOT__')
    } catch [System.Net.WebException] {
        # 401 = 端口在听且浏览器会话鉴权开启: 服务器已就绪(鉴权下裸 / 恒 401)
        if ($_.Exception.Response) { return ([int]$_.Exception.Response.StatusCode -eq 401) }
        return $false
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

function Get-ListenerCommand([int]$ProcId) {
    try {
        return (Get-CimInstance Win32_Process -Filter "ProcessId = $ProcId" -ErrorAction SilentlyContinue).CommandLine
    } catch {
        return $null
    }
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

# 在前台启动 DSH Web 服务器, 等待就绪后打开浏览器; 窗口常驻直到用户关闭
function Start-DshWebAndServe([int]$usePort) {
    $useUrl = "http://localhost:$usePort"
    Write-Host "正在启动 DSH Web UI (端口 $usePort) ..."
    Write-Host "服务器日志将显示在本窗口; Ctrl+C 或关闭窗口可停止服务器。"
    Write-Host ""

    # 输出经内层 powershell tee 到 $Log: 窗口照常显示, 磁盘留档; 内层与 node 同控制台,
    # 关窗/Ctrl+C 仍然连着服务器一起退出(窗口 ⟺ 服务器 不变)
    # EAP=Continue 必须显式带回内层: 本脚本顶部是 Stop, 而 node 2>&1|Tee 会把 stderr
    # (如 ACP SDK 的 "Error handling notification" 噪音) 在 Stop 下转成 NativeCommandError
    # 终止错误 → 第一条 stderr 就杀掉内层 shell 和服务器(曾表现为"跑一段时间才死")。
    Set-Content -Path $Log -Value "=== dsh web started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') port $usePort ==="
    $openFlag = if ($NoOpen) { ' --no-open' } else { '' }
    $inner = "`$ErrorActionPreference='Continue'; & '$Node' --import tsx/esm '$Cli' web --port $usePort$openFlag 2>&1 | Tee-Object -FilePath '$Log' -Append"
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
        if (-not $NoOpen) {
            # 鉴权开启时裸 URL 会 401, 必须带 token 打开(CLI 自身也会开 token URL, 至多多一个同页标签)
            $openTok = Get-LatestToken
            if ($openTok) { Start-Process "$useUrl/?token=$openTok" } else { Start-Process $useUrl }
        }
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
        & taskkill /PID $pid0 /F 2>$null | Out-Null
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

# —— 清理: 干掉 DSH 自己的旧 Web UI 主进程, 保证双击 = 干净重启 ——
# 只清 DSH 主进程(bin.ts web); ACP agent 等子进程不动。
function Get-DshMainServers {
    try {
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -and $_.CommandLine -match 'bin\.ts\s+web\s'
        }
    } catch { }
}

# 父窗口已退出的孤立主进程
function Get-StaleDshMainServers {
    @(Get-DshMainServers) | Where-Object { -not (Test-ProcessAlive ([int]$_.ParentProcessId)) }
}

# 1) 固定端口上的 DSH 服务器: 无论它启动的窗口是否还在, 都视为待替换的旧实例, 先清掉
$listenerPid = Get-ListenerPid $Port
if ($listenerPid) {
    $cmd = Get-ListenerCommand $listenerPid
    if ($cmd -and $cmd -match 'bin\.ts\s+web\s') {
        Write-Host ""
        Write-Host ("端口 {0} 上发现旧 DSH Web UI (PID {1}), 正在清理并重启 ..." -f $Port, $listenerPid)
        & taskkill /PID $listenerPid /F 2>$null | Out-Null
        $deadline = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $deadline -and (Test-PortBusy $Port)) { Start-Sleep -Milliseconds 300 }
    }
}

# 2) 顺手清掉孤立主进程(父窗口已退出), 避免 task-board 账本锁残留
$staleMains = @(Get-StaleDshMainServers)
foreach ($s in $staleMains) {
    if ($s.ProcessId -ne $listenerPid) {
        Write-Host ("发现残留主进程 PID {0} (启动它的窗口已退出), 正在清理 ..." -f $s.ProcessId)
        & taskkill /PID $s.ProcessId /F 2>$null | Out-Null
    }
}
if ($staleMains.Count -gt 0) {
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and @(Get-StaleDshMainServers).Count -gt 0) { Start-Sleep -Milliseconds 300 }
    Start-Sleep -Seconds 1
}

# —— 端口被非 DSH 程序占用: 报告冲突并中止, 不自动换端口 ——
if (Test-PortBusy $Port) {
    $busyPid = Get-ListenerPid $Port
    $busyCmd = Get-ListenerCommand $busyPid
    Write-Host ""
    Write-Host ("端口 {0} 已被其他程序占用 (PID {1}), 不是 DSH Web UI:" -f $Port, $busyPid)
    Write-Host ("  {0}" -f $busyCmd)
    Write-Host "请释放该端口后重试, 或用 -Port 显式指定其他端口。"
    Show-Error ("端口 {0} 已被其他程序占用 (PID {1}), 不是 DSH Web UI。请释放该端口, 或用 -Port 指定其他端口。" -f $Port, $busyPid)
    exit 1
}

if (-not (Test-Path $Cli)) { Show-Error "找不到 CLI: $Cli"; exit 1 }
if (-not (Test-Path $Node)) { Show-Error "找不到 node: $Node"; exit 1 }

# —— 正常路径: 固定端口上干净重启 ——
Start-DshWebAndServe $Port
exit 0
