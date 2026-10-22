import { join } from 'node:path'

export interface SkillRoots {
  claude: string
  codex: string
  agents: string
}

export function skillRoots(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): SkillRoots {
  return {
    claude: env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'),
    codex: env.CODEX_HOME?.trim() || join(home, '.codex'),
    agents: join(home, '.agents'),
  }
}
