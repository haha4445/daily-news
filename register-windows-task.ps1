<#
.SYNOPSIS
    注册（或卸载）"每日新闻汇总"的 Windows 计划任务。

.DESCRIPTION
    脚本内部自带中国大陆法定节假日/调休闸门，所以这里只需要"每天触发一次"：
    非工作日会被脚本自己跳过（退出码 2），调休上班日会照常生成。
    任务默认使用 node 的绝对路径，并勾选"错过触发后尽快启动"。

.EXAMPLE
    .\register-windows-task.ps1 -At 08:00
    .\register-windows-task.ps1 -At 07:30 -OutDir D:\news -TaskName NewsDigest
    .\register-windows-task.ps1 -Remove
#>
[CmdletBinding()]
param(
    [string]$TaskName = "DailyNewsDigest",
    [string]$At = "08:00",
    [string]$OutDir,
    [switch]$Remove,
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $scriptDir "news-digest.mjs"

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已删除计划任务：$TaskName" -ForegroundColor Yellow
    }
    else {
        Write-Host "计划任务不存在：$TaskName" -ForegroundColor DarkGray
    }
    return
}

if (-not (Test-Path $scriptPath)) {
    throw "找不到主脚本：$scriptPath"
}

$node = (Get-Command node -ErrorAction Stop).Source
$arguments = "`"$scriptPath`""
if ($OutDir) { $arguments += " --out `"$OutDir`"" }

$time = [datetime]::ParseExact($At, "HH:mm", $null)

$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -Daily -At $time
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "每日新闻汇总：抓取热榜与 RSS，写入 Markdown 日报；脚本内部按中国大陆法定节假日/调休判断是否运行。" `
    -Force | Out-Null

Write-Host "已注册计划任务：$TaskName" -ForegroundColor Green
Write-Host "  触发时间：每天 $At（错过则尽快补跑）"
Write-Host "  执行命令：$node $arguments"
Write-Host "  工作目录：$scriptDir"
Write-Host "  查看：Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "  立即试跑：Start-ScheduledTask -TaskName $TaskName"

if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "已触发一次运行。" -ForegroundColor Green
}
