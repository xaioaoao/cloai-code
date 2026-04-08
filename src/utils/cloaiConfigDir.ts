import { homedir } from 'os'
import { join } from 'path'

export function getCloaiConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cloai')
}

export function getCloaiGlobalConfigFile(): string {
  return join(getCloaiConfigDir(), '.claude.json')
}
