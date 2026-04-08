import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'import-codex',
  description: 'Import OpenAI Codex CLI credentials and models',
  supportsNonInteractive: false,
  load: () => import('./import-codex.js'),
} satisfies Command
