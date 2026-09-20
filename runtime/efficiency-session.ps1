param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('exploration_start', 'pause', 'resume', 'search', 'codegraph', 'exploration_finish', 'monthly')]
    [string]$Action,
    [string]$Repo,
    [string]$TaskId,
    [string]$Client,
    [string]$Model,
    [string]$Ide,
    [string]$Query,
    [string]$Path = '.',
    [ValidateRange(0, [int]::MaxValue)][int]$MaxCount = 0,
    [string]$StorageRoot
)

$ErrorActionPreference = 'Stop'
if (-not $StorageRoot) {
    $StorageRoot = if ($env:AI_PRODUCTIVITY_EFFICIENCY_ROOT) { $env:AI_PRODUCTIVITY_EFFICIENCY_ROOT } else { Join-Path $env:LOCALAPPDATA 'ai-productivity\efficiency-observability' }
}

function Get-Sha256([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-RepoContext([string]$Path) {
    $root = (& git -C $Path rev-parse --show-toplevel 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $root) { throw "Not a Git repository: $Path" }
    [pscustomobject]@{ root=$root; name=(Split-Path $root -Leaf); branch=(& git -C $root branch --show-current).Trim(); head=(& git -C $root rev-parse HEAD).Trim(); id=(Get-Sha256 $root.ToLowerInvariant()).Substring(0,16) }
}
function Get-RepositoryDirectory($Context) { Join-Path $StorageRoot "repositories\$($Context.id)" }
function Get-ActiveDirectory($Context) { Join-Path (Get-RepositoryDirectory $Context) 'active' }
function Get-ActivePath($Context, [string]$Id) { Join-Path (Get-ActiveDirectory $Context) "$Id.json" }
function Get-EventPath($Context) { Join-Path (Get-RepositoryDirectory $Context) 'events.jsonl' }
function Get-Ide() {
    if($Ide){return $Ide}
    if($env:AI_PRODUCTIVITY_IDE){return $env:AI_PRODUCTIVITY_IDE}
    if($env:VSCODE_PID -or $env:TERM_PROGRAM -eq 'vscode'){return 'vscode'}
    if($env:JETBRAINS_IDE -or $env:IDEA_INITIAL_DIRECTORY){return 'jetbrains'}
    if($env:WT_SESSION){return 'windows-terminal'}
    return 'unknown'
}
function Read-Profile($Context) {
    $cohort='workflow'
    $resolvedModel=if($Model){$Model}elseif($env:AI_PRODUCTIVITY_MODEL){$env:AI_PRODUCTIVITY_MODEL}else{'unknown'}
    $resolvedClient=if($Client){$Client}elseif($env:AI_PRODUCTIVITY_CLIENT){$env:AI_PRODUCTIVITY_CLIENT}else{'unknown'}
    [pscustomobject]@{cohort=$cohort;client=$resolvedClient;model=$resolvedModel;ide=(Get-Ide)}
}
function Write-Event($Context, $Profile, [string]$Id, [string]$Type, [hashtable]$Fields=@{}) {
    $event=[ordered]@{schema_version=1;occurred_at=(Get-Date).ToString('o');repository_id=$Context.id;repository_name=$Context.name;cohort=$Profile.cohort;client=$Profile.client;model=$Profile.model;ide=$Profile.ide;task_id=$Id;event=$Type}
    foreach($key in $Fields.Keys){$event[$key]=$Fields[$key]}
    $eventPath=Get-EventPath $Context; New-Item -ItemType Directory -Path (Split-Path $eventPath -Parent) -Force|Out-Null
    $mutex=New-Object System.Threading.Mutex($false,"Local\ai-productivity-efficiency-$($Context.id)")
    try {
        if(-not $mutex.WaitOne(5000)){throw "Timed out waiting to append telemetry for $($Context.name)."}
        $written=$false
        for($attempt=1;$attempt -le 5 -and -not $written;$attempt++){
            try { Add-Content -LiteralPath $eventPath -Value ($event|ConvertTo-Json -Compress) -Encoding UTF8; $written=$true }
            catch { if($attempt -eq 5){throw}; Start-Sleep -Milliseconds (50*$attempt) }
        }
    } finally { if($mutex){try{$mutex.ReleaseMutex()}catch{};$mutex.Dispose()} }
    [pscustomobject]$event
}
function Resolve-Task($Context, [string]$Id) {
    $activeDirectory=Get-ActiveDirectory $Context
    if ($Id) {
        $path=Get-ActivePath $Context $Id
        if(-not(Test-Path -LiteralPath $path)){throw "No active exploration exists for task_id $Id."}
        return [pscustomobject]@{id=$Id;path=$path;task=(Get-Content -LiteralPath $path -Raw|ConvertFrom-Json)}
    }
    $active=@(Get-ChildItem -LiteralPath $activeDirectory -File -Filter '*.json' -ErrorAction SilentlyContinue)
    if($active.Count -eq 0){throw "No active exploration exists for $($Context.name)."}
    if($active.Count -gt 1){throw "Multiple active explorations exist for $($Context.name). Pass -TaskId using the value returned by exploration_start."}
    $path=$active[0].FullName;$task=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
    [pscustomobject]@{id=$task.task_id;path=$path;task=$task}
}

if($Action -ne 'monthly' -and -not $Repo){$Repo=(Get-Location).Path}
switch($Action){
    'exploration_start' {
        $c=Get-RepoContext $Repo;$p=Read-Profile $c;$id=[guid]::NewGuid().ToString('N');$active=Get-ActivePath $c $id
        New-Item -ItemType Directory -Path (Get-ActiveDirectory $c) -Force|Out-Null
        [ordered]@{task_id=$id;started_at=(Get-Date).ToString('o');paused_at=$null;paused_seconds=0;branch=$c.branch;base_commit=$c.head}|ConvertTo-Json|Set-Content -LiteralPath $active -Encoding UTF8
        Write-Event $c $p $id 'exploration_start' @{branch=$c.branch;base_commit=$c.head}|ConvertTo-Json -Compress
    }
    'pause' {
        $c=Get-RepoContext $Repo;$p=Read-Profile $c;$active=Resolve-Task $c $TaskId;$task=$active.task
        if($task.paused_at){Write-Event $c $p $active.id 'exploration_pause_duplicate'|ConvertTo-Json -Compress;break}
        $task.paused_at=(Get-Date).ToString('o');$task|ConvertTo-Json|Set-Content -LiteralPath $active.path -Encoding UTF8
        Write-Event $c $p $active.id 'exploration_pause'|ConvertTo-Json -Compress
    }
    'resume' {
        $c=Get-RepoContext $Repo;$p=Read-Profile $c;$active=Resolve-Task $c $TaskId;$task=$active.task
        if(-not $task.paused_at){Write-Event $c $p $active.id 'exploration_resume_duplicate'|ConvertTo-Json -Compress;break}
        $wait=[math]::Round(((Get-Date)-[datetime]$task.paused_at).TotalSeconds,3);$task.paused_seconds=[double]$task.paused_seconds+$wait;$task.paused_at=$null;$task|ConvertTo-Json|Set-Content -LiteralPath $active.path -Encoding UTF8
        Write-Event $c $p $active.id 'exploration_resume' @{wait_seconds=$wait}|ConvertTo-Json -Compress
    }
    'search' {
        if(-not $Query){throw 'search requires -Query.'}
        $c=Get-RepoContext $Repo;$p=Read-Profile $c;$active=Resolve-Task $c $TaskId;$watch=[Diagnostics.Stopwatch]::StartNew();$result='error';$exitCode=-1
        $rgArgs=@('-n','--glob','!nul');if($MaxCount -gt 0){$rgArgs+=@('--max-count',$MaxCount)};$rgArgs+=@('--',$Query,$Path)
        Push-Location $c.root
        try { & rg @rgArgs;$exitCode=$LASTEXITCODE;if($exitCode -gt 1){throw "rg exited with code $exitCode."};$result=if($exitCode -eq 0){'match'}else{'no_match'} }
        finally { Pop-Location;$watch.Stop();Write-Event $c $p $active.id 'search_command' @{engine='rg';duration_ms=$watch.ElapsedMilliseconds;result=$result;exit_code=$exitCode;query_hash=(Get-Sha256 $Query)}|Out-Null }
    }
    'codegraph' {
        if(-not $Query){throw 'codegraph requires -Query.'}
        $c=Get-RepoContext $Repo;$p=Read-Profile $c;$active=Resolve-Task $c $TaskId;$watch=[Diagnostics.Stopwatch]::StartNew();$result='error';$exitCode=-1
        $codegraphRoot=Join-Path $c.root $Path
        if(-not(Test-Path -LiteralPath (Join-Path $codegraphRoot '.codegraph'))){throw "No .codegraph directory found at: $codegraphRoot"}
        Push-Location $codegraphRoot
        try { & codegraph.cmd explore $Query;$exitCode=$LASTEXITCODE;if($exitCode -ne 0){throw "CodeGraph exited with code $exitCode."};$result='ok' }
        finally { Pop-Location;$watch.Stop();Write-Event $c $p $active.id 'codegraph_query' @{duration_ms=$watch.ElapsedMilliseconds;result=$result;exit_code=$exitCode}|Out-Null }
    }
    'exploration_finish' {
        $c=Get-RepoContext $Repo;$p=Read-Profile $c;$active=Resolve-Task $c $TaskId;$task=$active.task
        $wall=[math]::Round(((Get-Date)-[datetime]$task.started_at).TotalSeconds,3);$wait=[double]$task.paused_seconds;if($task.paused_at){$wait+=[math]::Round(((Get-Date)-[datetime]$task.paused_at).TotalSeconds,3)};$activeSeconds=[math]::Max(0,[math]::Round($wall-$wait,3));$previousEap=$ErrorActionPreference;$ErrorActionPreference='Continue';try{$files=@(& git -C $c.root diff --name-only $task.base_commit 2>$null)}finally{$ErrorActionPreference=$previousEap}
        Write-Event $c $p $active.id 'exploration_finish' @{wall_duration_seconds=$wall;active_duration_seconds=$activeSeconds;user_wait_seconds=$wait;changed_file_count=$files.Count;branch=$c.branch}|ConvertTo-Json -Compress;Remove-Item -LiteralPath $active.path -Force
    }
    'monthly' {
        $events=@(Get-ChildItem -LiteralPath $StorageRoot -Recurse -File -Filter events.jsonl -ErrorAction SilentlyContinue|ForEach-Object{Get-Content -LiteralPath $_.FullName|ForEach-Object{$_|ConvertFrom-Json}});$month=(Get-Date -Day 1).Date;$events=@($events|Where-Object{[datetime]$_.occurred_at -ge $month})
        $cohorts=@($events|Group-Object cohort,client,model,ide|ForEach-Object{$items=@($_.Group);$first=$items[0];$finished=@($items|Where-Object event -eq 'exploration_finish');$finishedIds=@($finished.task_id|Where-Object{$_}|Select-Object -Unique);$completed=@($items|Where-Object{$finishedIds -contains $_.task_id});$searches=@($completed|Where-Object event -eq 'search_command');$graphs=@($completed|Where-Object event -eq 'codegraph_query');[ordered]@{cohort=if($first.cohort){$first.cohort}else{'unknown'};client=if($first.client){$first.client}else{'unknown'};model=if($first.model){$first.model}else{'unknown'};ide=if($first.ide){$first.ide}else{'unknown'};event_count=$items.Count;exploration_count=$finishedIds.Count;median_exploration_active_seconds=if($finished.Count){($finished.active_duration_seconds|Sort-Object)[[int][math]::Floor(($finished.Count-1)/2)]}else{$null};median_exploration_wall_seconds=if($finished.Count){($finished.wall_duration_seconds|Sort-Object)[[int][math]::Floor(($finished.Count-1)/2)]}else{$null};search_command_count=$searches.Count;search_duration_ms=[long](($searches|Measure-Object duration_ms -Sum).Sum);repeated_search_count=[int](($searches|Group-Object query_hash|Where-Object Count -gt 1|ForEach-Object{$_.Count-1}|Measure-Object -Sum).Sum);codegraph_query_count=$graphs.Count;codegraph_duration_ms=[long](($graphs|Measure-Object duration_ms -Sum).Sum)}})
        [ordered]@{schema_version=1;month_start=$month.ToString('yyyy-MM-dd');cohorts=$cohorts}|ConvertTo-Json -Depth 5
    }
}
