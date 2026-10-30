param([Parameter(Mandatory=$true)][long]$Handle)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$window = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Handle)
$elements = $window.FindAll([Windows.Automation.TreeScope]::Subtree, [Windows.Automation.Condition]::TrueCondition)
$names = @($elements | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Select-Object -First 100)
ConvertTo-Json -InputObject $names -Compress
