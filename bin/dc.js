#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { createInterface as createLineReader } from "node:readline";
import {
  FLAGS,
  DOWN_FLAGS,
  ERROR_RE,
  translate,
  logsArgs,
  buildArgs,
} from "../src/args.js";
import { USAGE, completionScript } from "../src/help.js";
import {
  configPath,
  readConfig,
  writeConfig,
  resolveEditor,
  editorBinary,
} from "../src/config.js";
import { parse as parseToml } from "smol-toml";
import { dump as toYaml } from "js-yaml";

// ---------- process helpers ----------

function status(r) {
  if (r.error) {
    console.error(
      r.error.code === "ENOENT"
        ? "dc: docker not found in PATH"
        : `dc: ${r.error.message}`,
    );
    return 127;
  }
  return r.status ?? 130;
}

const docker = (args, opts = {}) =>
  status(spawnSync("docker", args, { stdio: "inherit", ...opts }));
const compose = (args) => docker(["compose", ...args]);

function capture(args) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

function captureText(args) {
  const result = capture(args);
  if (!result.ok) {
    const detail =
      result.error?.code === "ENOENT"
        ? "docker not found in PATH"
        : result.stderr.trim() || result.error?.message || `exit code ${result.status}`;
    console.error(`dc: docker ${args.join(" ")} failed: ${detail}`);
    return undefined;
  }
  return result.stdout;
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
  const candidates = [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
  ];
  return candidates.find((f) => existsSync(f)) ?? "docker-compose.yml";
}

function loadConfigSafe() {
  try {
    return readConfig();
  } catch (e) {
    console.error(`dc: warning: ${e.message} (ignoring config)`);
    return {};
  }
}

function onPath(binary) {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [binary], { stdio: "ignore" }).status === 0;
}

function editFile(file) {
  const { editor } = resolveEditor(loadConfigSafe());
  const parts = [];
  const tokenPattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  let end = 0;
  while ((match = tokenPattern.exec(editor)) !== null) {
    if (editor.slice(end, match.index).trim()) {
      console.error("dc: invalid editor command: unmatched quote");
      return 1;
    }
    parts.push(match[1] ?? match[2] ?? match[3]);
    end = tokenPattern.lastIndex;
  }
  if (!parts.length || editor.slice(end).trim()) {
    console.error("dc: invalid editor command");
    return 1;
  }

  return status(spawnSync(parts[0], [...parts.slice(1), file], {
    shell: false,
    stdio: "inherit",
  }));
}

// Returns a container id: the given service's, or one chosen from a picker.
async function pickContainer(service) {
  if (service) {
    return lines(
      captureText(["compose", "ps", "--status", "running", "-q", service]) ?? "",
    )[0];
  }
  const ids = lines(
    captureText(["compose", "ps", "--status", "running", "-q"]) ?? "",
  );
  if (ids.length === 0) {
    console.error("No running containers found.");
    return undefined;
  }
  if (ids.length === 1) return ids[0];

  console.log("Select a container:");
  ids.forEach((id, i) => {
    const name = (captureText(["inspect", "-f", "{{.Name}}", id]) ?? "")
      .trim()
      .replace(/^\//, "");
    console.log(`  ${i + 1}) ${name}`);
  });
  const choice = Number(await ask(`Choice [1-${ids.length}]: `));
  if (!Number.isInteger(choice) || choice < 1 || choice > ids.length) {
    console.error("Invalid selection.");
    return undefined;
  }
  return ids[choice - 1];
}

function projectIds() {
  return lines(captureText(["compose", "ps", "-q"]) ?? "");
}

// ---------- commands ----------

const passthrough = (sub) => (args) => compose([sub, ...args]);

const commands = {
  toml: (args) => {
    // converts *-compose.toml, compose.toml to *-compose.yaml, compose.yaml
    const candidates = ["compose.toml", "docker-compose.toml"];
    const file = candidates.find((f) => existsSync(f));
    if (!file) {
      console.error("No compose.toml or docker-compose.toml found.");
      return 1;
    }

    const outFile = file.replace(/\.toml$/, ".yaml");

    let data;
    try {
      data = parseToml(readFileSync(file, "utf8"));
    } catch (err) {
      console.error(`Failed to parse ${file}: ${err.message}`);
      return 1;
    }

    try {
      writeFileSync(outFile, toYaml(data, { noRefs: true }));
    } catch (err) {
      console.error(`Failed to write ${outFile}: ${err.message}`);
      return 1;
    }

    console.log(`Wrote ${outFile}`);
    // Validate the generated file without echoing the rendered YAML.
    const configCode = status(
      spawnSync("docker", ["compose", "-f", outFile, "config"], {
        stdio: ["inherit", "ignore", "inherit"],
      }),
    );
    if (configCode !== 0) return configCode;
    if (args[0] !== "up") return 0;
    return commands.up(args.slice(1));
  },
  edit: () => editFile(composeFile()),
  env: () => editFile(".env"),

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
      console.error(
        `dc: ${e.message}\nFix or delete the file, then try again.`,
      );
      return 1;
    }

    if (args[0] === "--unset" || args[0] === "unset") {
      delete config.editor;
      writeConfig(config, path);
      const { editor, source } = resolveEditor(config);
      console.log(`Editor unset. Now using: ${editor}  (${source})`);
      return 0;
    }

    const value = args.join(" ").trim();
    const binary = editorBinary(value);
    if (binary && !onPath(binary)) {
      console.error(
        `dc: warning: '${binary}' was not found in PATH (saving anyway)`,
      );
    }
    config.editor = value;
    writeConfig(config, path);
    console.log(`Editor set to: ${value}`);
    return 0;
  },

  async rm() {
    const file = composeFile();
    if (!existsSync(file)) {
      console.error(`${file} not found.`);
      return 1;
    }
    if (!(await confirm(`Remove ${file}?`))) {
      console.log("Cancelled.");
      return 0;
    }
    rmSync(file);
    return 0;
  },

  async prune() {
    if (
      (await ask(
        "This affects the entire Docker daemon and removes ALL unused images, containers, and networks (not volumes). Type DELETE to continue: ",
      )) !== "DELETE"
    ) {
      console.log("Cancelled.");
      return 0;
    }
    return docker(["system", "prune", "-a", "-f"]);
  },

  async clean() {
    if (
      !(await confirm(
        "Prune stopped containers and unused images and networks across the entire Docker daemon?",
      ))
    ) {
      console.log("Cancelled.");
      return 0;
    }
    for (const kind of ["container", "image", "network"]) {
      const code = docker([kind, "prune", "-f"]);
      if (code !== 0) return code;
    }
    return 0;
  },

  async shell([service]) {
    const id = await pickContainer(service);
    if (!id) {
      if (service) console.error("Service not running.");
      return 1;
    }
    const hasBash =
      spawnSync("docker", ["exec", id, "bash", "-c", "exit 0"], {
        stdio: "ignore",
      }).status === 0;
    return docker(["exec", "-it", id, hasBash ? "bash" : "sh"]);
  },

  deploy: (args) => compose(["up", "-d", ...translate(FLAGS, args)]),
  async down(args) {
    const translated = translate(DOWN_FLAGS, args);
    if (translated.includes("--volumes")) {
      if (
        (await ask(
          "This removes project-associated Docker volumes and their data. Type DELETE to continue: ",
        )) !== "DELETE"
      ) {
        console.log("Cancelled.");
        return 0;
      }
    }
    return compose(["down", ...translated]);
  },
  re: (args) => {
    if (args.length === 0) {
      console.error("Usage: dc re SERVICE...");
      return 1;
    }
    return compose(["up", "-d", "--force-recreate", ...args]);
  },

  upgrade(args) {
    let code = compose(["pull", ...args]);
    if (code !== 0) return code;
    code = compose(["up", "-d", "--remove-orphans", ...args]);
    if (code !== 0) return code;
    return status(
      spawnSync("docker", ["image", "prune", "-f"], { stdio: "ignore" }),
    );
  },

  update() {
    const code = compose(["pull"]);
    return code !== 0 ? code : compose(["up", "-d", "--build"]);
  },

  logs: (args) => compose(logsArgs(args)),
  build: (args) => compose(["build", ...buildArgs(args)]),

  errs(args) {
    return new Promise((resolve) => {
      const child = spawn(
        "docker",
        ["compose", "logs", "-f", "--tail", "200", ...args],
        {
          stdio: ["inherit", "pipe", "pipe"],
        },
      );
      child.on("error", (e) => resolve(status({ error: e })));
      for (const stream of [child.stdout, child.stderr]) {
        createLineReader({ input: stream }).on("line", (l) => {
          if (ERROR_RE.test(l)) console.log(l);
        });
      }
      child.on("close", (c) => resolve(c ?? 130));
    });
  },

  stats(args) {
    if (args.length > 0) return docker(["stats", ...args]);
    const ids = projectIds();
    if (ids.length === 0) {
      console.error("No containers.");
      return 1;
    }
    return docker(["stats", ...ids]);
  },

  ports: () => compose(["ps", "--format", "table {{.Service}}\t{{.Ports}}"]),
  health: () =>
    compose(["ps", "--format", "table {{.Service}}\t{{.State}}\t{{.Status}}"]),

  ip() {
    const ids = projectIds();
    if (ids.length === 0) {
      console.error("No containers.");
      return 1;
    }
    const tpl =
      "{{.Name}}{{range $n,$v := .NetworkSettings.Networks}}  {{$n}}={{$v.IPAddress}}{{end}}";
    const out = captureText(["inspect", "-f", tpl, ...ids]);
    if (out === undefined) return 1;
    console.log(out.replace(/^\//gm, "").trimEnd());
    return 0;
  },

  vols() {
    let project;
    const config = captureText(["compose", "config", "--format", "json"]);
    if (config === undefined) return 1;
    try {
      project = JSON.parse(config).name;
    } catch (error) {
      console.error(`dc: could not parse Compose configuration: ${error.message}`);
      return 1;
    }
    return docker([
      "volume",
      "ls",
      ...(project
        ? ["--filter", `label=com.docker.compose.project=${project}`]
        : []),
    ]);
  },

  df: () => docker(["system", "df"]),
  ls: () => compose(["ls", "-a"]),
  run: (args) => compose(["run", "--rm", ...args]),

  ps: passthrough("ps"),
  restart: passthrough("restart"),
  stop: passthrough("stop"),
  start: passthrough("start"),
  pull: passthrough("pull"),
  exec: passthrough("exec"),
  cp: passthrough("cp"),
  config: passthrough("config"),
  top: passthrough("top"),
  images: passthrough("images"),

  completion([shell]) {
    const script = completionScript(shell);
    if (!script) {
      console.error("Usage: dc completion bash|zsh");
      return 1;
    }
    process.stdout.write(script);
    return 0;
  },

  __services() {
    const output = captureText(["compose", "config", "--services"]);
    if (output === undefined) return 1;
    process.stdout.write(output);
    return 0;
  },
};

commands.up = commands.deploy;
commands.sh = commands.shell;

// ---------- main ----------

const [cmd, ...args] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  (cmd ? console.log : console.error)(USAGE);
  process.exitCode = cmd ? 0 : 1;
} else if (Object.hasOwn(commands, cmd)) {
  process.exitCode = await commands[cmd](args);
} else {
  console.error(`dc: unknown command '${cmd}'\n`);
  console.error(USAGE);
  process.exitCode = 1;
}
