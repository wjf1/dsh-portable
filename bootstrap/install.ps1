<#
  dsh-portable — install a .dshpkg on Windows without opening DSH.

  Usage:
    .\install.ps1 preview D:\backup\desktop.dshpkg
    .\install.ps1 install  D:\backup\desktop.dshpkg --yes

  Everything after the script name is forwarded to bootstrap.mjs, so
  --home / --profile / --mode / --yes / --keep all work here too.
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-Node {
    if ($env:DSH_NODE -and (Test-Path -LiteralPath $env:DSH_NODE)) { return $env:DSH_NODE }
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

$node = Find-Node
if (-not $node) {
    Write-Error 'Node.js 22 or newer was not found. Install Node.js, or set DSH_NODE to the node.exe shipped with DSH.'
    exit 1
}

$entry = Join-Path $here 'bootstrap.mjs'
if (-not (Test-Path -LiteralPath $entry)) {
    Write-Error "bootstrap.mjs is missing next to this script ($entry)."
    exit 1
}

& $node $entry @Arguments
exit $LASTEXITCODE
