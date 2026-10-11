export const COMMANDS = [
  'toml', 'edit', 'env', 'editor', 'rm', 'deploy', 'up', 'down', 're', 'upgrade', 'update',
  'pull', 'build', 'ps', 'logs', 'errs', 'top', 'stats', 'ports', 'ip',
  'health', 'images', 'vols', 'df', 'ls', 'config', 'shell', 'sh', 'exec',
  'run', 'cp', 'clean', 'prune', 'restart', 'stop', 'start', 'completion', 'help',
  'server',
];

export const KEYWORDS = [
  'build', 'force', 'pull', 'orphans', 'renew', 'wait', 'vols', 'images', 'nocache',
];

export const USAGE = `Usage: dc COMMAND [OPTIONS]

Lifecycle
  deploy|up [kw] [svc]   Start/recreate (keywords: build force pull orphans renew wait)
  down [kw]              Stop and remove (keywords: vols orphans images)
  restart|stop|start     Act on services
  re SVC...              Force-recreate specific services
  upgrade [SVC...]       Pull + recreate (all, or just the given services)
  update                 Pull images and redeploy with --build
  pull                   Pull service images
  build [nocache]        Build images

Inspect
  ps                     List project containers
  logs [N] [svc]         Follow logs, optionally last N lines
  errs [svc]             Follow logs filtered to error/warn/fatal
  top                    Show running processes
  stats                  Live resource usage (project only)
  ports                  Show published ports
  ip                     Show container IP addresses
  health                 Show service state and health
  images                 List images used by the project
  vols                   List project volumes
  df                     Docker disk usage
  ls                     List all compose projects on this host
  config                 Validate and display Compose config

Access
  shell|sh [svc]         Shell into a container (picker if no service)
  exec SERVICE CMD       Run a command in a service
  run SERVICE CMD        One-off container (removed afterwards)
  cp SRC DST             docker compose cp (use svc:/path)

Files
  toml [kw] [svc]        Convert compose TOML to YAML, then start it
  edit                   Edit compose file
  env                    Edit .env
  editor [cmd|--unset]   Show or set the editor used by edit/env (e.g. dc editor vim)
  rm                     Delete compose file (asks first)

Cleanup
  clean                  Prune stopped containers, dangling images, networks
  prune                  Full prune incl. unused images (asks first)

Other
  server enable|disable   Install/remove and start/stop the systemd server (Linux; sudo required)
  completion bash|zsh    Print a shell completion script
`;

export function completionScript(shell) {
  const cmds = COMMANDS.join(' ');
  const kws = KEYWORDS.join(' ');
  if (shell === 'bash') {
    return `_dc() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${cmds}" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "$(dc __services 2>/dev/null) ${kws}" -- "$cur"))
  fi
}
complete -F _dc dc
`;
  }
  if (shell === 'zsh') {
    return `#compdef dc
_dc() {
  if (( CURRENT == 2 )); then
    compadd ${cmds}
  else
    compadd $(dc __services 2>/dev/null) ${kws}
  fi
}
compdef _dc dc
`;
  }
  return null;
}
