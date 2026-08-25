[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TokenPath = Join-Path $ProjectDir ".secrets\leviagent_gateway_token"
if (-not (Test-Path -LiteralPath $TokenPath)) {
    throw "Gateway token is not initialized. Run Initialize-LeviNodeRed.ps1 first."
}

$token = [IO.File]::ReadAllText($TokenPath).Trim()
$headers = @{ Authorization = "Bearer $token" }
$response = Invoke-RestMethod -Uri "http://127.0.0.1:1880/leviagent/v1/health" -Headers $headers -Method Get
$response | ConvertTo-Json -Depth 5

