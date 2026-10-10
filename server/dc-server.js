#!/usr/bin/env node
"use strict";

// Dependency-free web/API server for dc Compose Manager.
// Requires Node.js 18+ and Docker Compose v2.
// Defaults to loopback only. Use an SSH tunnel for remote access.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOST = "127.0.0.1";
const PORT = 56213;
const STACKS_DIR = path.resolve(
  process.env.DC_STACKS_DIR ||
    path.join(os.homedir(), ".local", "share", "dc", "stacks"),
);
const UI_FILE = path.resolve(path.join(__dirname, "dc-compose-manager.html"));

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

fs.mkdirSync(STACKS_DIR, { recursive: true, mode: 0o700 });

function send(res, status, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);

  res.writeHead(status, {
    "Content-Type":
      typeof payload === "string"
        ? "text/plain; charset=utf-8"
        : "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...headers,
  });

  res.end(body);
}

function sendError(res, status, message) {
  send(res, status, { error: message });
}

function validName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 128 &&
    name !== "." &&
    name !== ".." &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)
  );
}

function managedPath(name) {
  if (!validName(name)) {
    throw new Error(
      "Invalid stack name. Use letters, numbers, dots, underscores, or hyphens.",
    );
  }

  const dir = path.resolve(STACKS_DIR, name);

  if (!dir.startsWith(STACKS_DIR + path.sep)) {
    throw new Error("Invalid stack path.");
  }

  return path.join(dir, "compose.yaml");
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();

      if (!settled) {
        settled = true;
        reject(
          new Error(
            `${command} timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds.`,
          ),
        );
      }
    }, REQUEST_TIMEOUT_MS);

    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      reject(
        new Error(
          error.code === "ENOENT"
            ? "Docker CLI not found. Install Docker Compose v2 and ensure `docker` is on PATH."
            : error.message,
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            (stderr || stdout || `${command} exited with code ${code}`).trim(),
          ),
        );
      }
    });
  });
}

function splitConfigFiles(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

async function listRunningProjects() {
  const { stdout } = await run("docker", [
    "compose",
    "ls",
    "--all",
    "--format",
    "json",
  ]);

  let parsed;

  try {
    parsed = JSON.parse(stdout || "[]");
  } catch {
    throw new Error(
      "Could not parse `docker compose ls --all --format json` output.",
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Unexpected output from `docker compose ls`.");
  }

  return parsed
    .map((item) => ({
      name: String(item.Name || item.name || ""),
      status: String(item.Status || item.status || ""),
      configFiles: splitConfigFiles(
        item.ConfigFiles || item.configFiles || item.ConfigFile || "",
      ),
    }))
    .filter((item) => validName(item.name));
}

function listManagedProjects() {
  let entries = [];

  try {
    entries = fs.readdirSync(STACKS_DIR, { withFileTypes: true });
  } catch {}

  const result = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !validName(entry.name)) continue;

    const candidates = [
      "compose.yaml",
      "compose.yml",
      "docker-compose.yaml",
      "docker-compose.yml",
    ];

    const file = candidates
      .map((name) => path.join(STACKS_DIR, entry.name, name))
      .find((candidate) => {
        try {
          return fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      });

    if (file) {
      result.push({
        name: entry.name,
        content: readText(file),
        source: "managed",
        configFiles: [file],
        status: "",
      });
    }
  }

  return result;
}

async function getStacks() {
  const managed = listManagedProjects();
  const running = await listRunningProjects();
  const byName = new Map();

  for (const stack of managed) {
    byName.set(stack.name, stack);
  }

  for (const project of running) {
    const existing = byName.get(project.name);
    const files = project.configFiles;

    if (existing) {
      existing.status = project.status;
      existing.configFiles = files.length ? files : existing.configFiles;
      existing.running = true;
      continue;
    }

    const firstFile = files[0] || "";

    byName.set(project.name, {
      name: project.name,
      content: firstFile ? readText(firstFile) : "",
      source: "docker",
      configFiles: files,
      status: project.status,
      running: true,
    });
  }

  return [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((stack) => ({
      name: stack.name,
      content: stack.content,
      status: stack.status || (stack.running ? "running" : "managed"),
      source: stack.source,
    }));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("Request body is too large."), {
        statusCode: 413,
      });
    }

    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), {
      statusCode: 400,
    });
  }
}

function findProject(name, runningProjects) {
  return runningProjects.find((project) => project.name === name) || null;
}

function composeArgs(name, files, action) {
  const args = ["compose", "-p", name];

  for (const file of files) {
    args.push("-f", file);
  }

  if (action === "start-new") {
    args.push("up", "-d");
  } else if (action === "stop") {
    args.push("stop");
  } else if (action === "start") {
    args.push("start");
  } else if (action === "restart") {
    args.push("restart");
  }

  return args;
}

async function runStackAction(name, action) {
  const runningProjects = await listRunningProjects();
  const running = findProject(name, runningProjects);

  let files = running && running.configFiles.length ? running.configFiles : [];

  if (!files.length) {
    const candidates = [
      "compose.yaml",
      "compose.yml",
      "docker-compose.yaml",
      "docker-compose.yml",
    ];

    const file = candidates
      .map((candidate) => path.join(STACKS_DIR, name, candidate))
      .find((candidate) => {
        try {
          return fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      });

    if (file) files = [file];
  }

  if (!files.length) {
    throw new Error(`No Compose files found for stack '${name}'.`);
  }

  if (action === "start" && !running) {
    await run("docker", composeArgs(name, files, "start-new"), {
      cwd: path.dirname(files[0]),
    });
  } else {
    await run("docker", composeArgs(name, files, action), {
      cwd: path.dirname(files[0]),
    });
  }

  const verbs = {
    start: "started",
    stop: "stopped",
    restart: "restarted",
  };

  return `Stack '${verbs[action]}' successfully`;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/stacks") {
    try {
      return send(res, 200, { stacks: await getStacks() });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }

  const match = url.pathname.match(
    /^\/stacks\/([^/]+)(?:\/(start|stop|restart))?$/,
  );

  if (!match) {
    return sendError(res, 404, "Not found.");
  }

  let name;

  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return sendError(res, 400, "Invalid stack name encoding.");
  }

  if (!validName(name)) {
    return sendError(res, 400, "Invalid stack name.");
  }

  const action = match[2];

  if (req.method === "POST" && action) {
    try {
      const message = await runStackAction(name, action);
      return send(res, 200, { message });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }

  if (req.method === "POST" && !action) {
    let body;

    try {
      body = await readBody(req);
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }

    const bodyName = String(body.name || name).trim();
    const content = typeof body.content === "string" ? body.content : "";

    if (!validName(bodyName)) {
      return sendError(
        res,
        400,
        "Invalid stack name. Use letters, numbers, dots, underscores, or hyphens.",
      );
    }

    if (bodyName !== name) {
      return sendError(
        res,
        400,
        "The stack name in the URL must match the name in the request body.",
      );
    }

    if (!content.trim()) {
      return sendError(res, 400, "Compose content cannot be empty.");
    }

    try {
      // Docker-discovered projects are edited in their first Compose file.
      // New projects are stored in the managed stacks directory.
      const runningProjects = await listRunningProjects();
      const existing = findProject(name, runningProjects);

      let destination;

      if (existing && existing.configFiles.length) {
        destination = existing.configFiles[0];
      } else {
        destination = managedPath(name);
      }

      fs.mkdirSync(path.dirname(destination), {
        recursive: true,
        mode: 0o700,
      });

      const temp = path.join(
        path.dirname(destination),
        `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`,
      );

      fs.writeFileSync(temp, content, {
        encoding: "utf8",
        mode: 0o600,
      });

      fs.renameSync(temp, destination);

      return send(res, 200, {
        message: `The stack '${name}' was modified successfully`,
      });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }

  res.setHeader("Allow", "GET, POST");
  return sendError(res, 405, "Method not allowed.");
}

const server = http.createServer(async (req, res) => {
  let url;

  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return sendError(res, 400, "Invalid request URL.");
  }

  if (url.pathname.startsWith("/stacks")) {
    return handleApi(req, res, url);
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/index.html")
  ) {
    try {
      const html = fs.readFileSync(UI_FILE);

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      });

      return res.end(html);
    } catch {
      return send(
        res,
        404,
        `Dashboard not found. Place your dashboard at ${UI_FILE} or set DC_UI_FILE.`,
        { "Content-Type": "text/plain; charset=utf-8" },
      );
    }
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true });
  }

  return sendError(res, 404, "Not found.");
});

server.requestTimeout = REQUEST_TIMEOUT_MS + 5000;
server.headersTimeout = 10_000;

server.listen(PORT, HOST, () => {
  console.log(`dc webserver listening on http://${HOST}:${PORT}`);
  console.log(`Managed stacks: ${STACKS_DIR}`);
  console.log(`Dashboard file: ${UI_FILE}`);

  if (HOST !== "127.0.0.1" && HOST !== "::1" && HOST !== "localhost") {
    console.warn(
      "WARNING: server is listening beyond loopback. Only do this on a trusted network with suitable access controls.",
    );
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
