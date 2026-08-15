$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
  & $nodeCommand.Source --env-file-if-exists=.env server.mjs
  exit $LASTEXITCODE
}

$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (Test-Path -LiteralPath $bundledNode) {
  & $bundledNode --env-file-if-exists=.env server.mjs
  exit $LASTEXITCODE
}

throw 'Nie znaleziono Node.js 24+. Zainstaluj Node.js albo uruchom projekt w środowisku Codex.'
