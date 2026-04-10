import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'accounts',
  description: 'Manage compatible API account pool',
  argumentHint: '[list|use|pause|resume|include|exclude] [target]',
  supportsNonInteractive: false,
  load: () => import('./accounts.js'),
} satisfies Command
