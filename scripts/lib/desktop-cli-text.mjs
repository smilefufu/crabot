// Existing CLI wrapper bytes only; no environment, filesystem or lifecycle action.
export const windowsCommand = '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "CRABOT_CLI_ROOT=%~dp0.crabot-desktop-core"\r\n"%CRABOT_CLI_ROOT%\\.product-runtime\\node\\node.exe" "%CRABOT_CLI_ROOT%\\cli.mjs" %*\r\nexit /b %errorlevel%\r\n'
export const windowsPairedCommand = '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%~dp0.crabot-desktop-core\\bin\\crabot.exe" %*\r\nexit /b %errorlevel%\r\n'
