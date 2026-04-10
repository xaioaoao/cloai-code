import { homedir } from 'os'
import { join } from 'path'

export function getAcodeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.acode')
}

export function getAcodeGlobalConfigFile(): string {
  return join(getAcodeConfigDir(), '.claude.json')
}
