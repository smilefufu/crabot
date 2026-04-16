import { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult } from '../output.js'
import { parseKeyValuePairs } from './_utils.js'

export function registerConfigCommands(parent: Command): void {
  const config = parent
    .command('config')
    .description('Manage global configuration')

  config
    .command('show')
    .description('Show global model config and proxy config')
    .action(async () => {
      const { client, json } = createClient(parent)
      const [modelConfig, proxyConfig] = await Promise.all([
        client.get<unknown>('/api/model-config/global'),
        client.get<unknown>('/api/proxy-config'),
      ])
      printResult({ model_config: modelConfig, proxy_config: proxyConfig }, json)
    })

  config
    .command('set <pairs...>')
    .description('Set global model config values (key=value)')
    .action(async (pairs: string[]) => {
      const { client, json } = createClient(parent)

      const body = parseKeyValuePairs(pairs)
      const data = await client.patch<unknown>('/api/model-config/global', body)
      printResult(data, json)
    })

  const proxy = config
    .command('proxy')
    .description('Manage proxy configuration')

  proxy
    .command('show')
    .description('Show proxy config')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>('/api/proxy-config')
      printResult(data, json)
    })

  proxy
    .command('set <pair>')
    .description('Set a proxy config value (key=value)')
    .action(async (pair: string) => {
      const { client, json } = createClient(parent)

      const body = parseKeyValuePairs([pair])
      const data = await client.patch<unknown>('/api/proxy-config', body)
      printResult(data, json)
    })
}
