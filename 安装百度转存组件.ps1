$ErrorActionPreference = 'Stop'

$componentRoot = Join-Path $env:LOCALAPPDATA 'ManjuPublishStudio\components'
$archivePath = Join-Path $componentRoot 'bdpan-3.8.7-windows-amd64.zip'
$binaryPath = Join-Path $componentRoot 'bdpan\bdpan.exe'
$sourceUrl = 'https://issuecdn.baidupcs.com/issue/netdisk/ai-bdpan/win/3.8.7/bdpan-3.8.7-windows-amd64.zip'
$archiveHash = '32fd71f84df51376655794b22a1a009cdbe73bf33db41c7d193e900dee27ab5d'
$binaryHash = '90113ddd0efaa167137a3d97d7a7bca22a288fab7feac7ea9ecee00ec779a3f7'

function Get-Sha256([string] $filePath) {
  $bytes = [System.IO.File]::ReadAllBytes($filePath)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($algorithm.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}

New-Item -ItemType Directory -Path $componentRoot -Force | Out-Null
Write-Host '正在从百度官方地址下载转存组件…'
Invoke-WebRequest -Uri $sourceUrl -OutFile $archivePath -UseBasicParsing
if ((Get-Sha256 $archivePath) -ne $archiveHash) { throw '下载文件校验失败，已停止安装。' }
Expand-Archive -LiteralPath $archivePath -DestinationPath $componentRoot -Force
if (!(Test-Path -LiteralPath $binaryPath) -or (Get-Sha256 $binaryPath) -ne $binaryHash) {
  throw '转存组件校验失败，已停止安装。'
}
Remove-Item -LiteralPath $archivePath -Force
Write-Host '百度转存组件已安装。刷新漫剧发布工作台页面即可授权登录。'
