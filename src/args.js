// Keyword aliases for `dc deploy` / `dc up`
export const FLAGS = {
  build: ['--build'],
  force: ['--force-recreate'],
  pull: ['--pull', 'always'],
  orphans: ['--remove-orphans'],
  renew: ['--renew-anon-volumes'],
  wait: ['--wait'],
};

// Keyword aliases for `dc down`
export const DOWN_FLAGS = {
  vols: ['--volumes'],
  volumes: ['--volumes'],
  orphans: ['--remove-orphans'],
  images: ['--rmi', 'all'],
};

// Replace known keywords with their flags, pass everything else through.
export function translate(map, args) {
  return args.flatMap((a) => (Object.hasOwn(map, a) ? map[a] : [a]));
}

// `dc logs 50 web` -> follow, tail 50, service web. Default tail is 100.
export function logsArgs(args) {
  const [first, ...rest] = args;
  if (first !== undefined && /^\d+$/.test(first)) {
    return ['logs', '-f', '--tail', first, ...rest];
  }
  return ['logs', '-f', '--tail', '100', ...args];
}

// `dc build nocache` -> --no-cache
export function buildArgs(args) {
  return args.map((a) => (a === 'nocache' ? '--no-cache' : a));
}

export const ERROR_RE = /error|warn|fatal|panic|exception|traceback/i;
