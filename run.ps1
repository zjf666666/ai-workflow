[CmdletBinding()]
param(
    [ValidateSet('start','plan','approve','resume')]
    [string]$Command = 'start',
    [string]$Project,
    [string]$Requirement,
    [string]$RequirementText,
    [ValidateSet('feature','bugfix')]
    [string]$Kind,
    [string]$Model,
    [string]$Resume,
    [string]$Approve,
    [string]$Workflow
)

$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot 'runtime\src\cli.ts'
$arguments = @($cli, $Command)

function Get-PiConfiguredModels {
    $piConfigDir = if ($env:PI_CODING_AGENT_DIR) {
        $env:PI_CODING_AGENT_DIR
    } else {
        Join-Path $env:USERPROFILE '.pi\agent'
    }
    $modelsPath = Join-Path $piConfigDir 'models.json'
    if (-not (Test-Path -LiteralPath $modelsPath -PathType Leaf)) { return @() }

    try {
        $config = Get-Content -LiteralPath $modelsPath -Raw | ConvertFrom-Json
        $models = @()
        foreach ($providerProperty in $config.providers.PSObject.Properties) {
            foreach ($model in @($providerProperty.Value.models)) {
                if ($model.id) { $models += "$($providerProperty.Name)/$($model.id)" }
            }
        }
        return @($models)
    } catch {
        throw "Unable to read Pi models configuration: $modelsPath. $($_.Exception.Message)"
    }
}
if ($Command -eq 'approve') {
    if (-not $Approve) { throw 'approve requires -Approve <run-directory>.' }
    $arguments += @('--run', (Resolve-Path -LiteralPath $Approve).Path)
    if ($Workflow) { $arguments += @('--node', $Workflow) }
} elseif ($Command -eq 'resume') {
    if (-not $Resume) { throw 'resume requires -Resume <run-directory>.' }
    $arguments += @('--run', (Resolve-Path -LiteralPath $Resume).Path)
} elseif ($Command -eq 'plan') {
    if ($Project) { $arguments += @('--project', (Resolve-Path -LiteralPath $Project).Path) }
    if ($Kind) { $arguments += @('--kind', $Kind) }
    if ($Workflow) { $arguments += @('--workflow', (Resolve-Path -LiteralPath $Workflow).Path) }
} else {
    if (-not $Project -or (-not $Requirement -and -not $RequirementText)) { throw 'Provide -Project and either -RequirementText or -Requirement.' }
    $arguments += @('--project', (Resolve-Path -LiteralPath $Project).Path)
    # Keep this source ASCII-only: Windows PowerShell 5 may parse UTF-8 without a BOM
    # using the active ANSI code page.
    $featureLabel = -join [char[]](0x9700, 0x6C42)
    $kindPrompt = -join [char[]](0x8BF7, 0x8F93, 0x5165, 0x7C7B, 0x522B, 0xFF08, 0x9700, 0x6C42, 0x2F, 0x62, 0x75, 0x67, 0xFF09)
    $invalidKindMessage = -join [char[]](0x8BF7, 0x8F93, 0x5165, 0x201C, 0x9700, 0x6C42, 0x201D, 0x6216, 0x201C, 0x62, 0x75, 0x67, 0x201D, 0x3002)
    while (-not $Kind) {
        $selection = (Read-Host $kindPrompt).Trim().ToLowerInvariant()
        switch ($selection) {
            $featureLabel { $Kind = 'feature' }
            'feature' { $Kind = 'feature' }
            'bug' { $Kind = 'bugfix' }
            'bugfix' { $Kind = 'bugfix' }
            default { Write-Host $invalidKindMessage -ForegroundColor Yellow }
        }
    }
    $arguments += @('--kind', $Kind)
    if ($RequirementText) { $arguments += @('--requirement-text', $RequirementText) } else { $arguments += @('--requirement', (Resolve-Path -LiteralPath $Requirement).Path) }
    $modelPrompt = -join [char[]](0x8BF7, 0x8F93, 0x5165, 0x6A21, 0x578B, 0x7F16, 0x53F7)
    while (-not $Model) {
        $piModels = @(Get-PiConfiguredModels)
        if ($piModels.Count -eq 0) { throw 'No Pi models are configured. Add models to Pi models.json or provide -Model <provider/model>.' }
        Write-Host 'Available Pi models:'
        for ($index = 0; $index -lt $piModels.Count; $index++) {
            Write-Host "  $($index + 1). $($piModels[$index])"
        }
        $selectedModelNumber = 0
        $modelSelection = Read-Host $modelPrompt
        if ([int]::TryParse($modelSelection, [ref]$selectedModelNumber) -and $selectedModelNumber -ge 1 -and $selectedModelNumber -le $piModels.Count) {
            $Model = $piModels[$selectedModelNumber - 1]
        } else {
            Write-Host 'Enter one of the listed model numbers.' -ForegroundColor Yellow
        }
    }
    if ($Model) { $arguments += @('--model', $Model) }
    if ($Workflow) { $arguments += @('--workflow', (Resolve-Path -LiteralPath $Workflow).Path) }
}
Write-Host 'Starting engineering workflow...'
& node @arguments
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) { Write-Error "Workflow failed with exit code $exitCode. Inspect the newest run directory under $PSScriptRoot\runs."; exit $exitCode }
# The node exit code does not reflect the run status (REWORK_REQUIRED exits 0).
# Read the real status that the runtime appends to run-status.txt on every change.
if ($Command -ne 'plan') {
    $runsDir = Join-Path $PSScriptRoot 'runs'
    $statusLine = $null
    $runDirPath = $null
    if (Test-Path -LiteralPath $runsDir) {
        $newest = Get-ChildItem -LiteralPath $runsDir -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        $runDirPath = $newest.FullName
        $statusFile = Join-Path $runDirPath 'run-status.txt'
        if (Test-Path -LiteralPath $statusFile) { $statusLine = (Get-Content -LiteralPath $statusFile -Tail 1).Trim() }
    }
    if ($statusLine -match '^SUCCEEDED') {
        Write-Host 'Workflow completed successfully.'
    } elseif ($statusLine -match '^REWORK_REQUIRED') {
        Write-Warning "Workflow run needs rework (status: REWORK_REQUIRED). Resume the design session with: .\run.ps1 -Command resume -Resume '$runDirPath'"
    } elseif ($statusLine) {
        Write-Warning "Workflow run status: $statusLine. Run directory: $runDirPath"
    }
}
exit $exitCode
