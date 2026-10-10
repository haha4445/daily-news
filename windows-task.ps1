<#
.SYNOPSIS
    「每日新闻汇总」Windows 计划任务开关脚本：安装 / 卸载 / 启用 / 停用 / 查看 / 试跑 / 看日志。

.DESCRIPTION
    这是**脱离 DeepSeek Harness 会话**独立运行日报的方式：由 Windows 自己按点拉起 node 脚本，
    不经过任何模型，因此**不消耗 token**，也不需要 DSH 应用处于打开状态。

    脚本内部自带中国大陆法定节假日 / 调休闸门，所以计划任务只需要"每天触发"：
    非工作日会被脚本自己跳过（退出码 2），调休上班日（例如周六补班）照常生成。
    默认挂三个触发点 10:00 / 13:00 / 17:00，可用 -At 自定义（可写多个）。

    代价：产物只是本地 Markdown 文件（digest\news-latest.md），**不会把摘要推到聊天窗口**。
    想要"到点在对话里看到摘要"，那是 DSH 定时任务的活（见 README 第 6 节）。

    注意：本脚本需要访问 Windows 任务计划程序服务。**在 DSH 沙箱里运行会失败**
    （拒绝访问 / 系统找不到指定的路径）——请在普通 PowerShell 窗口里运行。

.PARAMETER Action
    Status    查看是否安装、启用状态、触发时间、上次结果、下次运行时间。**默认动作**。
    Install   安装 / 更新计划任务（可重复执行，等于"保存当前设置"）。
    Remove    删除计划任务。
    Enable    启用（配置保留，恢复触发）。
    Disable   停用（配置保留，暂停触发；比删除更适合"临时不想跑"）。
    Run       立刻跑一次（带日志，和计划任务内部的执行方式完全一致）。
    Log       查看最近一次运行日志的结尾。

.PARAMETER At
    触发时间，24 小时制 HH:mm，可写多个：-At 08:00,12:00,18:00。默认 10:00,13:00,17:00。

.PARAMETER OutDir
    日报输出目录（绝对路径）。不写则用脚本同目录下的 digest\。

.PARAMETER ExtraArgs
    追加给 node 的额外参数，整段作为一个字符串，例如 -ExtraArgs '--max 60'。
    会被写进计划任务，所以适合放长期生效的开关（如 --max 60 --json）。

.PARAMETER Force
    给 node 加 --force：忽略节假日闸门，休息日也生成。一般只配合 -Action Run 临时用。

.PARAMETER RunNow
    装完之后立刻试跑一次。

.EXAMPLE
    .\windows-task.ps1                                    # 看状态（默认）
    .\windows-task.ps1 -Action Install                    # 按 10:00/13:00/17:00 安装
    .\windows-task.ps1 -Action Install -At 08:00,20:00    # 换时间点（重复执行即覆盖）
    .\windows-task.ps1 -Action Install -OutDir D:\news    # 换输出目录
    .\windows-task.ps1 -Action Disable                    # 临时停用，保留配置
    .\windows-task.ps1 -Action Enable                     # 恢复
    .\windows-task.ps1 -Action Run                        # 现在手动跑一次（不消耗 token）
    .\windows-task.ps1 -Action Log                        # 看最近日志
    .\windows-task.ps1 -Action Remove                     # 彻底卸载
#>
[CmdletBinding()]
param(
    [ValidateSet("Status", "Install", "Remove", "Enable", "Disable", "Run", "Log")]
    [string]$Action = "Status",

    [string]$TaskName = "DailyNewsDigest",

    [string[]]$At = @("10:00", "13:00", "17:00"),

    [string]$OutDir,

    [string]$Config,

    [string]$ExtraArgs,

    [switch]$Force,

    [switch]$RunNow,

    # 兼容旧版 register-windows-task.ps1 的用法
    [switch]$Remove,

    [int]$Tail = 40
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $scriptDir "news-digest.mjs"
$logDir = Join-Path $scriptDir "logs"
$selfPath = $MyInvocation.MyCommand.Path

if ($Remove) { $Action = "Remove" }

# ---------------------------------------------------------------- 小工具
function Get-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "PATH 里找不到 node。请先安装 Node.js 18+，或把 node 加进 PATH 后重试。" }
    $exe = $cmd.Source
    # 计划任务不读你的 PATH，所以必须把绝对路径写进去；顺带挡掉 .cmd/.bat 壳脚本（-Execute 跑不了）
    if (-not (Test-Path -LiteralPath $exe)) { throw "node 路径不存在：$exe" }
    if ($exe -notmatch '\.exe$') { throw "node 解析到了 $exe（不是 .exe）。请把真正的 node.exe 加进 PATH 后重试，否则计划任务无法直接运行它。" }
    return $exe
}

function Get-HostPath {
    # 计划任务用它在无人值守时跑本脚本的 Run 分支（负责落日志、回传真实退出码）
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($pwsh) { return $pwsh.Source }
    $ps = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($ps) { return $ps.Source }
    throw "找不到 PowerShell 宿主（pwsh / powershell.exe）。"
}

function Format-ResultCode {
    param([int]$Code)
    switch ($Code) {
        0 { "0 · 成功" }
        1 { "1 · 脚本报错（看日志）" }
        2 { "2 · 休息日跳过" }
        3 { "3 · 无新增内容" }
        267009 { "267009 · 正在运行" }
        267011 { "267011 · 尚未运行过" }
        default { "$Code" }
    }
}

function Get-MyTask {
    # 全量枚举而不是按名字查：这样才能区分"服务不可访问"和"任务没安装"
    try { $all = Get-ScheduledTask -ErrorAction Stop }
    catch {
        throw ("无法访问 Windows 任务计划程序服务：{0}`n  请在**普通 PowerShell 窗口**里运行本脚本（DSH 沙箱 / 受限策略下会被拒绝）。" -f $_.Exception.Message)
    }
    return ($all | Where-Object { $_.TaskName -eq $TaskName -and $_.TaskPath -eq '\' } | Select-Object -First 1)
}

function Invoke-Digest {
    param([string]$OutDirArg, [string]$ConfigArg, [string]$ExtraArgsArg, [switch]$ForceArg)

    $node = Get-NodePath
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $logFile = Join-Path $logDir ("digest-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

    $nodeArgs = @($scriptPath)
    if ($OutDirArg) { $nodeArgs += @("--out", $OutDirArg) }
    if ($ConfigArg) { $nodeArgs += @("--config", $ConfigArg) }
    if ($ExtraArgsArg) { $nodeArgs += @($ExtraArgsArg -split '\s+' | Where-Object { $_ }) }
    if ($ForceArg) { $nodeArgs += "--force" }

    # node 输出 UTF-8；默认控制台编码可能把中文写成乱码，这里固定住
    try {
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    }
    catch { }

    Add-Content -LiteralPath $logFile -Encoding utf8 -Value @(
        "",
        ("===== {0} 开始 =====" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")),
        ("命令：{0} {1}" -f $node, ($nodeArgs -join " "))
    )

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    # 计划任务环境下 stdout 无人接收，所以逐行落盘；Write-Host 不占管道，
    # 函数返回值才不会被 node 的输出污染（-Action Run 还要回传真实退出码）。
    $ErrorActionPreference = "Continue"
    & $node @nodeArgs 2>&1 | ForEach-Object {
        $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { "! " + $_.ToString() } else { [string]$_ }
        Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
        Write-Host $line
    }
    $code = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    $sw.Stop()

    Add-Content -LiteralPath $logFile -Encoding utf8 -Value @(
        ("===== 结束：退出码 {0}，耗时 {1} 秒 =====" -f (Format-ResultCode $code), [int]$sw.Elapsed.TotalSeconds)
    )
    return @{ Code = $code; Log = $logFile }
}

function Get-NewestLog {
    if (-not (Test-Path $logDir)) { return $null }
    return (Get-ChildItem -LiteralPath $logDir -Filter "digest-*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}

# ---------------------------------------------------------------- Run
if ($Action -eq "Run") {
    if (-not (Test-Path $scriptPath)) { throw "找不到主脚本：$scriptPath" }
    $r = Invoke-Digest -OutDirArg $OutDir -ConfigArg $Config -ExtraArgsArg $ExtraArgs -ForceArg:$Force
    Write-Host ("日志：{0}" -f $r.Log) -ForegroundColor DarkGray
    exit $r.Code
}

# ---------------------------------------------------------------- Log
if ($Action -eq "Log") {
    $newest = Get-NewestLog
    if (-not $newest) { Write-Host "还没有任何日志（$logDir）。" -ForegroundColor DarkGray; return }
    Write-Host ("日志文件：{0}（最后修改 {1}）" -f $newest.FullName, $newest.LastWriteTime) -ForegroundColor Cyan
    Get-Content -LiteralPath $newest.FullName -Tail $Tail -Encoding utf8
    return
}

# ---------------------------------------------------------------- Status
if ($Action -eq "Status") {
    try { $task = Get-MyTask }
    catch { Write-Host $_.Exception.Message -ForegroundColor Red; return }

    if (-not $task) {
        Write-Host ("未安装计划任务「{0}」。" -f $TaskName) -ForegroundColor Yellow
        Write-Host "  安装：.\windows-task.ps1 -Action Install" -ForegroundColor DarkGray
        return
    }

    $info = $task | Get-ScheduledTaskInfo
    $times = @($task.Triggers | ForEach-Object {
            if ($_.StartBoundary) { ([datetime]$_.StartBoundary).ToString("HH:mm") } else { "?" }
        }) -join " / "

    Write-Host ("计划任务「{0}」：{1}" -f $TaskName, $task.State) -ForegroundColor Green
    Write-Host ("  触发时间：每天 {0}" -f $times)
    Write-Host ("  上次运行：{0} → {1}" -f $info.LastRunTime, (Format-ResultCode $info.LastTaskResult))
    Write-Host ("  下次运行：{0}" -f $info.NextRunTime)
    Write-Host ("  执行命令：{0}" -f (($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join "; "))
    Write-Host ("  工作目录：{0}" -f ($task.Actions | Select-Object -First 1).WorkingDirectory)
    Write-Host "  最近日志：.\windows-task.ps1 -Action Log" -ForegroundColor DarkGray
    Write-Host "  临时停用：.\windows-task.ps1 -Action Disable   /   卸载：-Action Remove" -ForegroundColor DarkGray
    return
}

# ---------------------------------------------------------------- Enable / Disable / Remove
if ($Action -in "Enable", "Disable", "Remove") {
    try { $task = Get-MyTask }
    catch { Write-Host $_.Exception.Message -ForegroundColor Red; return }

    if (-not $task) {
        Write-Host ("计划任务不存在：{0}" -f $TaskName) -ForegroundColor Yellow
        return
    }

    switch ($Action) {
        "Enable" {
            Enable-ScheduledTask -TaskName $TaskName | Out-Null
            Write-Host ("已启用：{0}（到点会正常触发）" -f $TaskName) -ForegroundColor Green
        }
        "Disable" {
            Disable-ScheduledTask -TaskName $TaskName | Out-Null
            Write-Host ("已停用：{0}（配置保留，-Action Enable 可恢复）" -f $TaskName) -ForegroundColor Yellow
        }
        "Remove" {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host ("已删除计划任务：{0}" -f $TaskName) -ForegroundColor Yellow
        }
    }
    return
}

# ---------------------------------------------------------------- Install
if (-not (Test-Path $scriptPath)) { throw "找不到主脚本：$scriptPath" }

$node = Get-NodePath
$hostPath = Get-HostPath

if ($OutDir -and -not [System.IO.Path]::IsPathRooted($OutDir)) {
    throw "输出目录要写绝对路径（计划任务的工作目录和你当前所在目录不一定一样）：$OutDir"
}

# 校验并整理时间点
$times = @()
foreach ($t in $At) {
    foreach ($piece in ($t -split ",")) {
        $p = $piece.Trim()
        if (-not $p) { continue }
        try { [void][datetime]::ParseExact($p, "HH:mm", $null) }
        catch { throw ("时间格式不对：'{0}'，应该写成 HH:mm，例如 -At 08:00,20:00" -f $p) }
        if ($times -notcontains $p) { $times += $p }
    }
}
if ($times.Count -eq 0) { throw "-At 至少要给一个时间点。" }
$times = @($times | Sort-Object)

# 计划任务的动作 = 用 PowerShell 跑本脚本的 Run 分支（这样才有日志与真实退出码）
$actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"{0}`" -Action Run" -f $selfPath
if ($OutDir) { $actionArgs += " -OutDir `"$OutDir`"" }
if ($Config) { $actionArgs += " -Config `"$Config`"" }
if ($ExtraArgs) { $actionArgs += " -ExtraArgs `"$ExtraArgs`"" }

try {
    $trigger = @($times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($_, "HH:mm", $null)) })
    # 注意：不能把返回值赋给 $action —— 它会撞上本脚本 [ValidateSet] 修饰的 $Action 参数
    $taskAction = New-ScheduledTaskAction -Execute $hostPath -Argument $actionArgs -WorkingDirectory $scriptDir
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $taskAction `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description "每日新闻汇总：抓取热榜与 RSS，写入 Markdown 日报（不消耗模型 token）。脚本内部按中国大陆法定节假日/调休判断是否运行，休息日退出码 2。" `
        -Force | Out-Null
}
catch {
    Write-Host ("安装失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host "  · 如果提示'拒绝访问'：请在**普通 PowerShell 窗口**里以当前用户重试（本脚本通常不需要管理员）。" -ForegroundColor DarkGray
    Write-Host "  · 如果在 DSH 沙箱里运行：沙箱禁止访问任务计划程序，请换到普通 PowerShell。" -ForegroundColor DarkGray
    exit 1
}

Write-Host ("已安装计划任务：{0}" -f $TaskName) -ForegroundColor Green
Write-Host ("  触发时间：每天 {0}（错过则尽快补跑）" -f ($times -join " / "))
Write-Host ("  执行：{0} -Action Run" -f $hostPath)
Write-Host ("  工作目录：{0}" -f $scriptDir)
$outLabel = if ($OutDir) { $OutDir } else { Join-Path $scriptDir "digest" }
Write-Host ("  输出：{0}" -f $outLabel)
Write-Host "  查看状态：.\windows-task.ps1            （默认就是 Status）"
Write-Host "  现在试跑：.\windows-task.ps1 -Action Run" -ForegroundColor DarkGray
Write-Host "  临时停用：.\windows-task.ps1 -Action Disable" -ForegroundColor DarkGray
Write-Host "  彻底卸载：.\windows-task.ps1 -Action Remove" -ForegroundColor DarkGray
Write-Host ""
Write-Host "提示：默认只在用户登录时运行（无需管理员）。若要锁屏/未登录也跑，需管理员指定 S4U —— 见 README 第 7 节。" -ForegroundColor DarkGray

if ($RunNow) {
    Write-Host ""
    Write-Host "立刻试跑一次……" -ForegroundColor Cyan
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    $t2 = Get-ScheduledTask -TaskName $TaskName
    $i2 = $t2 | Get-ScheduledTaskInfo
    Write-Host ("当前状态：{0}，上次结果：{1}" -f $t2.State, (Format-ResultCode $i2.LastTaskResult))
}
