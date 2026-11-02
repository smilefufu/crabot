export function validateCheck(name, value) {
  if ((value.code ?? 0) !== 0) throw new Error('Local process exited unsuccessfully')
  const output = value.output ?? value.stdout ?? ''
  if (name.includes('synthetic_credentials')) {
    if (!output.includes('SYNTHETIC_HANDOFF_OK')) throw new Error('Process exited without the synthetic credential handoff')
  } else if (name === 'powershell_basic_execution') {
    if (!output.includes('POWERSHELL_EXECUTED')) throw new Error('PowerShell returned without executing the control command')
  } else if (name.endsWith('_config')) {
    const config = JSON.parse(output)
    if (!config.hooks?.['get-manifest'] || !config.hooks?.start) throw new Error('Missing required hooks in configuration output')
  } else {
    const manifest = JSON.parse(output)
    if (manifest.display_information?.name !== 'slack-on-win') throw new Error('Unexpected local manifest')
  }
}
