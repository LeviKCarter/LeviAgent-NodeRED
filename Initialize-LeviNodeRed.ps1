[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SecretsDir = Join-Path $ProjectDir ".secrets"
$GoogleCredentialPath = "C:\Users\levik\AppData\Local\LeviAgent\google-service-account.json"

if (-not (Test-Path -LiteralPath $GoogleCredentialPath -PathType Leaf)) {
    throw "LeviAgent Google service-account credential is unavailable: $GoogleCredentialPath"
}

function New-Base64UrlSecret([int]$ByteCount) {
    $bytes = [byte[]]::new($ByteCount)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Set-SecretFileAcl([string]$Path) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $Path /inheritance:r /grant:r "${identity}:(F)" "SYSTEM:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not apply the required ACL to secret file: $Path"
    }
}

function Ensure-SecretFile([string]$Path, [int]$ByteCount) {
    if (Test-Path -LiteralPath $Path) {
        $existing = [IO.File]::ReadAllText($Path).Trim()
        if ($existing.Length -lt 32) {
            throw "Existing secret is too short: $Path"
        }
    } else {
        [IO.File]::WriteAllText(
            $Path,
            (New-Base64UrlSecret -ByteCount $ByteCount),
            [Text.UTF8Encoding]::new($false)
        )
    }
    Set-SecretFileAcl -Path $Path
}

New-Item -ItemType Directory -Path $SecretsDir -Force | Out-Null
Ensure-SecretFile -Path (Join-Path $SecretsDir "nodered_credential_secret") -ByteCount 48
Ensure-SecretFile -Path (Join-Path $SecretsDir "leviagent_gateway_token") -ByteCount 48

docker compose --project-directory $ProjectDir -f (Join-Path $ProjectDir "compose.yaml") up -d
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose failed to start LeviAgent Node-RED"
}

Write-Host "LeviAgent Node-RED started on http://127.0.0.1:1880 with the editor disabled."
