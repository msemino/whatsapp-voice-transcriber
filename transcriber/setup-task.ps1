# setup-task.ps1 — Register Windows Task Scheduler job to run transcribir-entrantes.ps1 every 4 minutes.
# Run once as Administrator.

param(
    [string]$ScriptPath = "$PSScriptRoot\transcribir-entrantes.ps1",
    [string]$TaskName   = "TranscribirAudiosEntrantes",
    [int]   $IntervalMinutes = 4
)

$action  = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""

$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -Once -At (Get-Date)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force
Write-Host "Task '$TaskName' registered — runs every $IntervalMinutes minutes."
