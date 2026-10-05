<#
.SYNOPSIS
  Deploy the kiosk app from this PC to the Raspberry Pi over SSH.

.DESCRIPTION
  Uploads src/, deploy/ and the package files (never node_modules), then on the
  Pi reinstalls dependencies only if package-lock.json changed and restarts the
  running kiosk. Your config and logins on the Pi are not touched.

.EXAMPLE
  .\deploy.ps1 -Target pi@192.168.1.50 -SetupKey
  First time: remembers the Pi and copies your SSH key so you are not asked for a password again.

.EXAMPLE
  .\deploy.ps1 -Install
  First time on a fresh Pi: uploads and runs deploy/install.sh (asks for your sudo password).

.EXAMPLE
  .\deploy.ps1
  Every time after that (or: npm run deploy).
#>
param(
  [string]$Target,               # user@host, remembered in .deploy-target
  [string]$RemoteDir = 'pi-kiosk', # folder under the Pi user's home
  [switch]$SetupKey,
  [switch]$Install
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Invoke-Native([string]$What, [scriptblock]$Cmd) {
  & $Cmd
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

# ---- target -------------------------------------------------------------------
$targetFile = Join-Path $PSScriptRoot '.deploy-target'
if ($Target) {
  Set-Content -Path $targetFile -Value $Target -Encoding ascii
} elseif (Test-Path $targetFile) {
  $Target = (Get-Content $targetFile -TotalCount 1).Trim()
} else {
  throw 'No Pi configured yet. Run:  .\deploy.ps1 -Target <user>@<pi-ip-or-hostname> -SetupKey'
}
Write-Host "Deploying to $Target (~/$RemoteDir)" -ForegroundColor Cyan

# ---- one-time SSH key setup -----------------------------------------------------
if ($SetupKey) {
  $key = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
  if (-not (Test-Path "$key.pub")) {
    Write-Host 'Creating an SSH key (no passphrase)...'
    New-Item -ItemType Directory -Force (Split-Path $key) | Out-Null
    Invoke-Native 'ssh-keygen' { ssh-keygen -q -t ed25519 -f $key -N '""' }
  }
  $pub = (Get-Content "$key.pub" -TotalCount 1).Trim()
  Write-Host 'Copying your public key to the Pi (enter the Pi password one last time)...'
  Invoke-Native 'Key copy' {
    ssh $Target "mkdir -p ~/.ssh && chmod 700 ~/.ssh && (grep -qxF '$pub' ~/.ssh/authorized_keys 2>/dev/null || echo '$pub' >> ~/.ssh/authorized_keys) && chmod 600 ~/.ssh/authorized_keys"
  }
}

# ---- package ----------------------------------------------------------------------
$items = @('src', 'deploy', 'package.json', 'package-lock.json', 'README.md') | Where-Object { Test-Path $_ }
$archive = Join-Path $env:TEMP 'pi-kiosk-deploy.tgz'
if (Test-Path $archive) { Remove-Item $archive -Force }
Invoke-Native 'Packaging' { tar -czf $archive @items }
$sizeKb = [math]::Round((Get-Item $archive).Length / 1KB)
Write-Host "Packaged $($items -join ', ') ($sizeKb KB)"

# ---- upload + unpack ----------------------------------------------------------------
Invoke-Native 'Upload' { scp -q -o ConnectTimeout=10 $archive "${Target}:/tmp/pi-kiosk-deploy.tgz" }
Remove-Item $archive -Force

# Replace src/ and deploy/ wholesale so deleted files don't linger; node_modules stays.
$unpack = "set -e; mkdir -p ~/$RemoteDir; cd ~/$RemoteDir; rm -rf src deploy; " +
          "tar --warning=no-unknown-keyword -xzf /tmp/pi-kiosk-deploy.tgz; rm -f /tmp/pi-kiosk-deploy.tgz; " +
          "find deploy -name '*.sh' -exec sed -i 's/\r$//' {} +"

if ($Install) {
  Write-Host 'Running first-time install on the Pi...' -ForegroundColor Cyan
  Invoke-Native 'Install' { ssh -t $Target "$unpack; cd ~/$RemoteDir && bash deploy/install.sh" }
} else {
  Invoke-Native 'Update' { ssh $Target "$unpack; bash ~/$RemoteDir/deploy/update.sh" }
}

Write-Host 'Done.' -ForegroundColor Green
