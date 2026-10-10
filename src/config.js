import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// DC_CONFIG overrides the location (handy for testing).
export function configPath(env = process.env, platform = process.platform) {
  if (env.DC_CONFIG) return env.DC_CONFIG;
  if (platform === 'win32') {
    return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'dc', 'config.json');
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dc', 'config.json');
}

// Missing file -> {}. Unreadable or invalid JSON -> throws.
export function readConfig(path = configPath()) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`could not read ${path}: ${e.message}`);
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (e) {
    throw new Error(`invalid JSON in ${path}: ${e.message}`);
  }
}

export function writeConfig(data, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

// Precedence: dc config > $VISUAL > $EDITOR > platform default.
export function resolveEditor(config, env = process.env, platform = process.platform) {
  if (typeof config.editor === 'string' && config.editor.trim()) {
    return { editor: config.editor.trim(), source: 'config' };
  }
  if (env.VISUAL) return { editor: env.VISUAL, source: '$VISUAL' };
  if (env.EDITOR) return { editor: env.EDITOR, source: '$EDITOR' };
  return { editor: platform === 'win32' ? 'notepad' : 'nano', source: 'default' };
}

// First word of an editor command, honouring a leading quoted path.
export function editorBinary(command) {
  const m = /^\s*(?:"([^"]+)"|(\S+))/.exec(command);
  return m ? (m[1] ?? m[2]) : '';
}
