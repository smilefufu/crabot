param([string]$Root, [string]$Child, [string]$File, [string]$ExplicitFile)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
$sidType = [System.Security.Principal.SecurityIdentifier]
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Role([string]$sid) {
  if ($sid -eq $current) { return 'current' }
  if ($sid -eq 'S-1-5-18') { return 'system' }
  if ($sid -eq 'S-1-5-32-544') { return 'administrators' }
  return 'other'
}
$paths = @($Root, $Child, $File, $ExplicitFile)
$labels = @('root', 'child', 'ordinary-file', 'explicit-file')
for ($i = 0; $i -lt $paths.Count; $i++) {
  $acl = Get-Acl -LiteralPath $paths[$i]
  $rules = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object {
    @{ principal = (Role $_.IdentityReference.Value); kind = $_.AccessControlType.ToString();
      rights = [int]$_.FileSystemRights; inherited = $_.IsInherited;
      inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }
  })
  @{ object = $labels[$i]; owner = (Role $acl.GetOwner($sidType).Value);
    protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Depth 5 -Compress
}
