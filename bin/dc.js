#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createInterface as createLineReader } from 'node:readline';
import {
  FLAGS, DOWN_FLAGS, ERROR_RE, translate, logsArgs, buildArgs,
} from '../src/args.js';
import { USAGE, completionScript } from '../src/help.js';
import {
  configPath, readConfig, writeConfig, resolveEditor, editorBinary,
} from '../src/config.js';

// ---------- process helpers ----------

function status(r) {
  if (r.error) {
    console.error(
      r.error.code === 'ENOENT' ? 'dc: docker not found in PATH' : `dc: ${r.error.message}`,
    );
    return 127;
  }
  return r.status ?? 130;
}

const docker = (args, opts = {}) => status(spawnSync('docker', args, { stdio: 'inherit', ...opts }));
const compose = (args) => docker(['compose', ...args]);

function capture(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
}

const lines = (s) => s.split(/\r?\n/).filter(Boolean);

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function confirm(question) {
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `));
}

function composeFile() {
  const candidates = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
  return candidates.find((f) => existsSync(f)) ?? 'docker-compose.yml';
}

function loadConfigSafe() {
  try {
    return readConfig();
  } catch (e) {
    console.error(`dc: warning: ${e.message} (ignoring config)`);
    return {};
  }
}

function editFile(file) {
  const { editor } = resolveEditor(loadConfigSafe());
  return status(spawnSync(`${editor} "${file}"`, { shell: true, stdio: 'inherit' }));
}

function onPath(binary) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [binary], { stdio: 'ignore' }).status === 0;
}

const SERVER_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'dc-server.js');
const SYSTEMD_UNIT = '/etc/systemd/system/dc-server.service';

function systemdUnit() {
  const user = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME;
  if (!user) throw new Error('Could not determine the user for the systemd service.');

  const quote = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=dc Compose Manager server
After=network.target docker.service

[Service]
Type=simple
User=${user}
ExecStart=${quote(process.execPath)} ${quote(SERVER_FILE)}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

function sudo(args) {
  const result = spawnSync('sudo', args, { stdio: 'inherit' });
  if (result.error) {
    console.error(
      result.error.code === 'ENOENT'
        ? 'dc: sudo is required for server administration but was not found in PATH'
        : `dc: ${result.error.message}`,
    );
    return 127;
  }
  return result.status ?? 1;
}

function server(args) {
  if (process.platform !== 'linux') {
    console.error('dc: server enable|disable requires Linux with systemd');
    return 1;
  }

  if (args.length !== 1 || !['enable', 'disable'].includes(args[0])) {
    console.error('Usage: dc server enable|disable');
    return 1;
  }

  if (args[0] === 'enable') {
    let temporaryUnit;
    try {
      temporaryUnit = resolve(tmpdir(), `dc-server.${process.pid}.service`);
      writeFileSync(temporaryUnit, systemdUnit(), { mode: 0o644 });
    } catch (error) {
      console.error(`dc: could not create systemd unit: ${error.message}`);
      return 1;
    }

    try {
      let code = sudo(['install', '-o', 'root', '-g', 'root', '-m', '644', temporaryUnit, SYSTEMD_UNIT]);
      if (code !== 0) return code;
      code = sudo(['systemctl', 'daemon-reload']);
      if (code !== 0) return code;
      return sudo(['systemctl', 'enable', '--now', 'dc-server.service']);
    } finally {
      try { unlinkSync(temporaryUnit); } catch {}
    }
  }

  let code = sudo(['systemctl', 'disable', '--now', 'dc-server.service']);
  if (code !== 0) return code;
  code = sudo(['rm', '-f', SYSTEMD_UNIT]);
  if (code !== 0) return code;
  return sudo(['systemctl', 'daemon-reload']);
}

// Returns a container id: the given service's, or one chosen from a picker.
async function pickContainer(service) {
  if (service) {
    return lines(capture(['compose', 'ps', '--status', 'running', '-q', service]))[0];
  }
  const ids = lines(capture(['compose', 'ps', '--status', 'running', '-q']));
  if (ids.length === 0) {
    console.error('No running containers found.');
    return undefined;
  }
  if (ids.length === 1) return ids[0];

  console.log('Select a container:');
  ids.forEach((id, i) => {
    const name = capture(['inspect', '-f', '{{.Name}}', id]).trim().replace(/^\//, '');
    console.log(`  ${i + 1}) ${name}`);
  });
  const choice = Number(await ask(`Choice [1-${ids.length}]: `));
  if (!Number.isInteger(choice) || choice < 1 || choice > ids.length) {
    console.error('Invalid selection.');
    return undefined;
  }
  return ids[choice - 1];
}

function projectIds() {
  return lines(capture(['compose', 'ps', '-q']));
}

// ---------- commands ----------

const passthrough = (sub) => (args) => compose([sub, ...args]);

const commands = {
  edit: () => editFile(composeFile()),
  env: () => editFile('.env'),

  // dc editor            -> show current editor and where it comes from
  // dc editor vim        -> set it (extra words are kept: dc editor code --wait)
  // dc editor --unset    -> clear it, falling back to $VISUAL/$EDITOR/default
  editor(args) {
    const path = configPath();

    if (args.length === 0) {
      const { editor, source } = resolveEditor(loadConfigSafe());
      console.log(`${editor}  (${source})`);
      console.log(`config: ${path}`);
      return 0;
    }

    let config;
    try {
      config = readConfig(path);
    } catch (e) {
      console.error(`dc: ${e.message}\nFix or delete the file, then try again.`);
      return 1;
    }

    if (args[0] === '--unset' || args[0] === 'unset') {
      delete config.editor;
      writeConfig(config, path);
      const { editor, source } = resolveEditor(config);
      console.log(`Editor unset. Now using: ${editor}  (${source})`);
      return 0;
    }

    const value = args.join(' ').trim();
    const binary = editorBinary(value);
    if (binary && !onPath(binary)) {
      console.error(`dc: warning: '${binary}' was not found in PATH (saving anyway)`);
    }
    config.editor = value;
    writeConfig(config, path);
    console.log(`Editor set to: ${value}`);
    return 0;
  },

  server,

  async rm() {
    const file = composeFile();
    if (!existsSync(file)) { console.error(`${file} not found.`); return 1; }
    if (!(await confirm(`Remove ${file}?`))) { console.log('Cancelled.'); return 0; }
    rmSync(file);
    return 0;
  },

  async prune() {
    if (!(await confirm('Remove ALL unused images, containers, networks (not volumes)?'))) {
      console.log('Cancelled.');
      return 0;
    }
    return docker(['system', 'prune', '-a', '-f']);
  },

  async clean() {
    if (!(await confirm('Remove stopped containers and unused Docker resources?'))) {
      console.log('Cancelled.');
      return 0;
    }
    for (const kind of ['container', 'image', 'network']) {
      const code = docker([kind, 'prune', '-f']);
      if (code !== 0) return code;
    }
    return 0;
  },

  async shell([service]) {
    const id = await pickContainer(service);
    if (!id) { if (service) console.error('Service not running.'); return 1; }
    const hasBash = spawnSync('docker', ['exec', id, 'bash', '-c', 'exit 0'], { stdio: 'ignore' }).status === 0;
    return docker(['exec', '-it', id, hasBash ? 'bash' : 'sh']);
  },

  deploy: (args) => compose(['up', '-d', ...translate(FLAGS, args)]),
  down: (args) => compose(['down', ...translate(DOWN_FLAGS, args)]),
  re: (args) => {
    if (args.length === 0) { console.error('Usage: dc re SERVICE...'); return 1; }
    return compose(['up', '-d', '--force-recreate', ...args]);
  },

  upgrade(args) {
    let code = compose(['pull', ...args]);
    if (code !== 0) return code;
    code = compose(['up', '-d', '--remove-orphans', ...args]);
    if (code !== 0) return code;
    return status(spawnSync('docker', ['image', 'prune', '-f'], { stdio: 'ignore' }));
  },

  update() {
    const code = compose(['pull']);
    return code !== 0 ? code : compose(['up', '-d', '--build']);
  },

  logs: (args) => compose(logsArgs(args)),
  build: (args) => compose(['build', ...buildArgs(args)]),

  errs(args) {
    return new Promise((resolve) => {
      const child = spawn('docker', ['compose', 'logs', '-f', '--tail', '200', ...args], {
        stdio: ['inherit', 'pipe', 'pipe'],
      });
      child.on('error', (e) => resolve(status({ error: e })));
      for (const stream of [child.stdout, child.stderr]) {
        createLineReader({ input: stream }).on('line', (l) => {
          if (ERROR_RE.test(l)) console.log(l);
        });
      }
      child.on('close', (c) => resolve(c ?? 130));
    });
  },

  stats(args) {
    if (args.length > 0) return docker(['stats', ...args]);
    const ids = projectIds();
    if (ids.length === 0) { console.error('No containers.'); return 1; }
    return docker(['stats', ...ids]);
  },

  ports: () => compose(['ps', '--format', 'table {{.Service}}\t{{.Ports}}']),
  health: () => compose(['ps', '--format', 'table {{.Service}}\t{{.State}}\t{{.Status}}']),

  ip() {
    const ids = projectIds();
    if (ids.length === 0) { console.error('No containers.'); return 1; }
    const tpl = '{{.Name}}{{range $n,$v := .NetworkSettings.Networks}}  {{$n}}={{$v.IPAddress}}{{end}}';
    const out = capture(['inspect', '-f', tpl, ...ids]);
    console.log(out.replace(/^\//gm, '').trimEnd());
    return 0;
  },

  vols() {
    let project;
    try {
      project = JSON.parse(capture(['compose', 'config', '--format', 'json'])).name;
    } catch { /* fall back to listing everything */ }
    return docker(['volume', 'ls', ...(project ? ['--filter', `label=com.docker.compose.project=${project}`] : [])]);
  },

  df: () => docker(['system', 'df']),
  ls: () => compose(['ls', '-a']),
  run: (args) => compose(['run', '--rm', ...args]),

  ps: passthrough('ps'),
  restart: passthrough('restart'),
  stop: passthrough('stop'),
  start: passthrough('start'),
  pull: passthrough('pull'),
  exec: passthrough('exec'),
  cp: passthrough('cp'),
  config: passthrough('config'),
  top: passthrough('top'),
  images: passthrough('images'),

  completion([shell]) {
    const script = completionScript(shell);
    if (!script) { console.error('Usage: dc completion bash|zsh'); return 1; }
    process.stdout.write(script);
    return 0;
  },

  __services() {
    process.stdout.write(capture(['compose', 'config', '--services']));
    return 0;
  },
};

commands.up = commands.deploy;
commands.sh = commands.shell;

// ---------- main ----------

const [cmd, ...args] = process.argv.slice(2);

if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
  (cmd ? console.log : console.error)(USAGE);
  process.exitCode = cmd ? 0 : 1;
} else if (Object.hasOwn(commands, cmd)) {
  process.exitCode = await commands[cmd](args);
} else {
  console.error(`dc: unknown command '${cmd}'\n`);
  console.error(USAGE);
  process.exitCode = 1;
}
