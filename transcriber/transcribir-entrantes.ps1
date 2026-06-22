# transcribir-entrantes.ps1 — Dequeue WhatsApp voice notes, transcribe locally, send text back.
#
# Architecture:
#   NUC (24/7 daemon)  --(audio-inbox/ queue)--> THIS SCRIPT on RTX 3090 PC
#   THIS SCRIPT        --(wa send --b64)-------> self-chat on WhatsApp
#
# Triggered by Windows Task Scheduler every 4 minutes.
# If the PC is off, the queue accumulates on the NUC and drains when the PC wakes.
#
# Requirements: whisper.cpp (CUDA), ffmpeg, SSH key to NUC, wa CLI on NUC.
# Sanitised: replace NUC_USER / NUC_HOST with your values, and SELF_NUMBER with yours.

param(
    [string]$WhisperDir  = "D:\whisper",
    [string]$Model       = "ggml-large-v3.bin",
    [string]$NucUser     = "YOUR_NUC_USER",
    [string]$NucHost     = "YOUR_NUC_HOST",   # e.g. 100.x.x.x (Tailscale) or nuc
    [string]$NucInboxDir = "~/recordatorio-fichada/audio-inbox",
    [string]$SelfNumber  = "YOUR_PHONE_NUMBER", # digits only, e.g. 5491199998888
    [string]$Language    = "es"
)

$WHISPER_EXE = Join-Path $WhisperDir "bin\Release\whisper-cli.exe"
$MODEL_PATH  = Join-Path $WhisperDir "models\$Model"
$LOG_FILE    = Join-Path $WhisperDir "entrantes.log"
$LOCAL_TMP   = Join-Path $WhisperDir "entrantes-tmp"

function Write-Log([string]$msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
}

New-Item -ItemType Directory -Force $LOCAL_TMP | Out-Null

# ---- 1. Download queue from NUC ----
Write-Log "Checking NUC inbox..."
$items = & ssh "${NucUser}@${NucHost}" "ls $NucInboxDir/*.json 2>/dev/null" 2>&1
if ($LASTEXITCODE -ne 0 -or -not $items) {
    Write-Log "Queue empty or SSH error. Exiting."
    exit 0
}

$jsonFiles = $items | Where-Object { $_ -match '\.json$' }
Write-Log "Found $($jsonFiles.Count) item(s) in queue."

foreach ($jsonPath in $jsonFiles) {
    $jsonPath = $jsonPath.Trim()
    $baseName = ($jsonPath -split '/')[-1] -replace '\.json$', ''
    $oggPath  = ($jsonPath -replace '\.json$', '.ogg')

    # Download both files
    $localJson = Join-Path $LOCAL_TMP "$baseName.json"
    $localOgg  = Join-Path $LOCAL_TMP "$baseName.ogg"

    & scp "${NucUser}@${NucHost}:$jsonPath" $localJson 2>&1 | Out-Null
    & scp "${NucUser}@${NucHost}:$oggPath"  $localOgg  2>&1 | Out-Null

    if (-not (Test-Path $localJson) -or -not (Test-Path $localOgg)) {
        Write-Log "WARN: could not download $baseName — skipping"
        continue
    }

    $meta = Get-Content $localJson -Encoding UTF8 | ConvertFrom-Json

    # ---- 2. Convert ogg → wav 16kHz mono for whisper.cpp ----
    $localWav = $localOgg -replace '\.ogg$', '.wav'
    & ffmpeg -y -i $localOgg -ar 16000 -ac 1 $localWav 2>&1 | Out-Null

    if (-not (Test-Path $localWav)) {
        Write-Log "ERROR: ffmpeg conversion failed for $baseName"
        continue
    }

    # ---- 3. Transcribe with whisper.cpp ----
    Write-Log "Transcribing: $baseName (from=$($meta.fromName) origin=$($meta.origin))"
    $wArgs = @("-m", $MODEL_PATH, "-f", $localWav, "-l", $Language, "-otxt", "--no-timestamps")
    & $WHISPER_EXE @wArgs 2>&1 | Out-Null

    $txtFile = $localWav + ".txt"
    $text = if (Test-Path $txtFile) {
        (Get-Content $txtFile -Encoding UTF8 -Raw).Trim()
    } else { "" }

    if (-not $text) {
        Write-Log "WARN: empty transcription for $baseName"
        $text = "[no se pudo transcribir]"
    }

    # ---- 4. Build labelled message ----
    $ts       = if ($meta.timestamp) { ([datetime]$meta.timestamp).ToLocalTime().ToString("HH:mm") } else { "" }
    $fromLine = if ($meta.origin -eq "self") {
        "Reenviado por vos"
    } elseif ($meta.isGroup) {
        "$($meta.fromName) (+$($meta.fromNumber)) en $($meta.chatName)"
    } else {
        "$($meta.fromName) (+$($meta.fromNumber))"
    }
    $accLabel = $meta.acc
    $fullMsg  = "Audio entrante [$accLabel] $ts`nDe: $fromLine`n$text"

    # ---- 5. Send to self-chat via NUC gateway (base64 to preserve UTF-8 over SSH) ----
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($fullMsg))
    Write-Log "Sending to self-chat: $($text.Substring(0, [Math]::Min(60, $text.Length)))..."
    & ssh "${NucUser}@${NucHost}" "wa send $SelfNumber --b64 $b64 -a personal" 2>&1 | Out-Null

    # ---- 6. Delete from NUC queue ----
    & ssh "${NucUser}@${NucHost}" "rm -f $jsonPath $oggPath" 2>&1 | Out-Null

    # Cleanup local temp
    foreach ($f in @($localJson, $localOgg, $localWav, $txtFile)) {
        try { if (Test-Path $f) { Remove-Item $f -Force } } catch {}
    }

    Write-Log "Done: $baseName"
}

Write-Log "Batch complete."
