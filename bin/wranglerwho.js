#!/usr/bin/env node
"use strict";

/*
 * wranglerwho — a friendly front-end for Cloudflare wrangler's native auth
 * profiles (beta).
 *
 * wrangler already does the hard part: `wrangler auth create/list/activate/
 * delete` manage named OAuth logins, and `--profile <name>` runs one command
 * as a given account. wranglerwho adds the three things wrangler doesn't:
 *
 *   1. notes per account      (stored in ~/.wranglerwho/notes.json)
 *   2. an interactive picker  (arrow keys / numbers)
 *   3. a "switch once" shell  (pick an account, then run native wrangler
 *                              commands in a subshell; `exit` to leave)
 *
 * The subshell works by putting a tiny `wrangler` shim first on PATH that
 * injects `--profile <name>` into every command (and passes auth/login/logout
 * straight through, since those reject the flag). No global state is mutated.
 *
 * Requires a wrangler new enough to have `wrangler auth create` (beta profiles).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const HOME = os.homedir();
const ROOT = path.join(HOME, ".wranglerwho");
const NOTES_FILE = path.join(ROOT, "notes.json");

// ---------- ansi ----------
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const green = (s) => c("32", s);
const cyan = (s) => c("36", s);
const yellow = (s) => c("33", s);
const red = (s) => c("31", s);

// ---------- startup badge (figlet "Small", Cloudflare-orange gradient) ----------
const BADGE = ["                            _                _        "," __ __ ___ _ __ _ _ _  __ _| |___ _ ___ __ _| |_  ___ "," \\ V  V / '_/ _` | ' \\/ _` | / -_) '_\\ V  V / ' \\/ _ \\","  \\_/\\_/|_| \\__,_|_||_\\__, |_\\___|_|  \\_/\\_/|_||_\\___/","                      |___/                           "];
const BADGE_W = Math.max(...BADGE.map((l) => l.length));
const GRAD_START = [251, 191, 55]; // #fbbf37
const GRAD_END = [227, 81, 0];     // #e35100

function gradColor(x) {
  const t = BADGE_W > 1 ? x / (BADGE_W - 1) : 0;
  const r = Math.round(GRAD_START[0] + (GRAD_END[0] - GRAD_START[0]) * t);
  const g = Math.round(GRAD_START[1] + (GRAD_END[1] - GRAD_START[1]) * t);
  const b = Math.round(GRAD_START[2] + (GRAD_END[2] - GRAD_START[2]) * t);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function printBadge() {
  const indent = "  ";
  console.log();
  if (!tty || process.env.NO_COLOR) {
    for (const line of BADGE) console.log(indent + line);
  } else {
    for (const line of BADGE) {
      let out = indent, cur = "";
      for (let x = 0; x < line.length; x++) {
        const ch = line[x];
        if (ch === " ") { out += " "; continue; }
        const col = gradColor(x);
        if (col !== cur) { out += col; cur = col; }
        out += ch;
      }
      console.log(out + "\x1b[0m");
    }
  }
  console.log(indent + "⛅  " + bold("Who are you today?"));
  console.log();
}

function die(msg) {
  console.error(red("✘ ") + msg);
  process.exit(1);
}

// ---------- notes store (names + metadata only; wrangler owns credentials) ----------
function readNotes() {
  try {
    return JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeNotes(data) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(NOTES_FILE, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

// wrangler profile names allow only [A-Za-z0-9_-]. Derive a safe id from a
// friendly label; the label itself is kept in notes.json for display.
function toProfileId(label) {
  const id = label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || "account";
}
function uniqueId(base, taken) {
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}
// "default" is wrangler's reserved global fallback login, not a wranglerwho
// account. Point the user at the right tool instead of erroring cryptically.
function guardDefault(name) {
  if (name && name.toLowerCase() === "default") {
    die(
      '"default" is wrangler\'s global login, not a wranglerwho account.\n' +
        "  Manage it with " + bold("wrangler login") + " / " + bold("wrangler logout") + "."
    );
  }
}

// Match a profile by either its wrangler id or its friendly label.
function matchProfile(profiles, q) {
  const lq = q.toLowerCase();
  return profiles.find(
    (p) => p.name === q || p.label === q || p.name.toLowerCase() === lq || p.label.toLowerCase() === lq
  );
}

// ---------- wrangler discovery ----------
function wranglerPath() {
  // When we're nested inside a wranglerwho subshell, our own shim is first on
  // PATH, so `command -v wrangler` would resolve to the shim — pointing the new
  // shim at the old one and stacking a second --profile (which crashes
  // wrangler). Reuse the real path recorded by the outermost session instead.
  const recorded = process.env.WRANGLERWHO_REAL;
  if (recorded && fs.existsSync(recorded)) return recorded;
  const r = spawnSync("sh", ["-c", "command -v wrangler"], { encoding: "utf8" });
  const p = (r.stdout || "").trim();
  if (!p) die("wrangler is not on your PATH. Install it: npm i -g wrangler");
  return p;
}

function wrangler(args, opts = {}) {
  return spawnSync("wrangler", args, {
    encoding: "utf8",
    stdio: opts.stdio || "pipe",
    cwd: opts.cwd,
    env: opts.env || process.env,
  });
}

// Does this wrangler have native profiles? (4.68.1 has only `auth token`.)
function assertNativeProfiles() {
  const help = wrangler(["auth", "--help"]);
  const txt = (help.stdout || "") + (help.stderr || "");
  if (!/\bcreate\b/.test(txt) || !/\blist\b/.test(txt)) {
    die(
      "your wrangler doesn't have auth profiles yet.\n" +
        "  Upgrade it:  " + bold("npm i -g wrangler@latest") + "\n" +
        "  (profiles are a beta feature; `wrangler auth create` must exist.)"
    );
  }
}

function authCreateSupportsNoBrowser() {
  const help = wrangler(["auth", "create", "--help"]);
  return /--(no-)?browser/.test((help.stdout || "") + (help.stderr || ""));
}

// ---------- parse `wrangler auth list` ----------
// Output is a box-drawing table:
//   ┌─────────┬───────────────────┐
//   │ Profile │ Bound Directories │
//   ├─────────┼───────────────────┤
//   │ default │ -                 │
//   └─────────┴───────────────────┘
// Parse by the │ cell separator and drop the header row. Only lines containing
// a cell separator are data/header rows; borders and the banner have none.
function nativeProfiles() {
  const txt = wrangler(["auth", "list"]);
  const out = (txt.stdout || "") + "\n" + (txt.stderr || "");
  const rows = [];
  for (let line of out.split("\n")) {
    line = line.replace(/\x1b\[[0-9;]*m/g, "");
    const sep = line.includes("│") ? "│" : line.includes("|") ? "|" : null;
    if (!sep) continue; // banner / borders / separators
    const cells = line.split(sep).map((s) => s.trim()).filter((s) => s.length);
    if (!cells.length) continue;
    const name = cells[0];
    if (name === "Profile") continue;    // header row
    if (name === "default") continue;    // wrangler's reserved global login (manage via login/logout)
    if (/^[─—-]+$/.test(name)) continue; // stray separator cell
    const bound = cells[1] && cells[1] !== "-" ? cells[1] : "";
    rows.push({ name, bound });
  }
  return rows;
}

// Merge native profiles with notes metadata into a display list. Accounts we
// recorded in notes.json always show up too, even if list parsing misses them.
function listProfiles() {
  const notes = readNotes();
  const map = new Map();
  for (const { name, bound } of nativeProfiles()) map.set(name, { name, bound });
  for (const k of Object.keys(notes)) if (!map.has(k)) map.set(k, { name: k, bound: "" });
  return [...map.values()].map(({ name, bound }) => {
    const meta = notes[name] || {};
    return {
      name, label: meta.label || name, bound: bound || "",
      notes: meta.notes || "", email: meta.email || "", accountName: meta.accountName || "",
    };
  });
}

function parseWhoami(text) {
  const out = {};
  const email = text.match(/email\s+([^\s.]+@[^\s.]+(?:\.[^\s.]+)+)/i);
  if (email) out.email = email[1];
  const id = text.match(/\b([0-9a-f]{32})\b/i);
  if (id) {
    out.accountId = id[1];
    for (const line of text.split("\n")) {
      if (line.includes(id[1]) && line.includes("│")) {
        const cells = line.split("│").map((s) => s.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean);
        if (cells.length) out.accountName = cells[0];
        break;
      }
    }
  }
  return out;
}

// Best-effort: capture a profile's identity by briefly binding it to a temp
// dir and running whoami there, then unbinding. Never fatal.
function captureIdentity(name) {
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wranglerwho-id-"));
    const act = wrangler(["auth", "activate", name, tmp]);
    if (act.status !== 0) return {};
    const who = wrangler(["whoami"], { cwd: tmp });
    return parseWhoami((who.stdout || "") + "\n" + (who.stderr || ""));
  } catch {
    return {};
  } finally {
    if (tmp) {
      try { wrangler(["auth", "deactivate", tmp]); } catch {}
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
}

// ---------- prompts ----------
function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

// ---------- interactive picker ----------
function pickProfile(profiles) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      return reject(new Error("no TTY; name an account, e.g. `wranglerwho use <name>`"));
    }
    let idx = 0;
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    const lineCount = profiles.length + 3;
    let drawn = false;

    function render() {
      if (drawn) process.stdout.write(`\x1b[${lineCount}A`);
      drawn = true;
      const w = (s) => process.stdout.write("\x1b[2K" + s + "\n");
      w(bold("Select an account:") + dim("   ↑/↓ or number · enter · q"));
      w("");
      profiles.forEach((p, i) => {
        const sel = i === idx;
        const pointer = sel ? cyan("❯ ") : "  ";
        const num = dim(`${i + 1}.`);
        const nm = sel ? bold(cyan(p.label)) : p.label;
        const idTag = p.label !== p.name ? dim(` [${p.name}]`) : "";
        const who = p.email ? dim(` ${p.email}`) : "";
        const acct = p.accountName ? dim(` · ${p.accountName}`) : "";
        const bnd = p.bound ? dim(`  ⟵ ${p.bound}`) : "";
        const note = p.notes ? yellow(`  — ${p.notes}`) : "";
        w(`${pointer}${num} ${nm}${idTag}${who}${acct}${bnd}${note}`);
      });
      w("");
    }
    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("keypress", onKey);
    }
    function onKey(str, key) {
      if (!key) return;
      if (key.name === "up" || key.name === "k") { idx = (idx - 1 + profiles.length) % profiles.length; render(); }
      else if (key.name === "down" || key.name === "j") { idx = (idx + 1) % profiles.length; render(); }
      else if (/^[1-9]$/.test(str || "")) { const n = +str - 1; if (n < profiles.length) { idx = n; render(); } }
      else if (key.name === "return" || key.name === "enter") { cleanup(); resolve(profiles[idx]); }
      else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup(); process.stdout.write(dim("cancelled\n")); process.exit(0);
      }
    }
    stdin.on("keypress", onKey);
    printBadge();
    render();
  });
}

// ---------- session subshell via a PATH shim ----------
function sq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function activate(p) {
  const real = wranglerPath();
  const label = p.label || p.name;
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "wranglerwho-"));
  const activeMsg = `wranglerwho active profile: ${label}` + (p.email ? ` (${p.email})` : "");
  const shim = `#!/bin/sh
# wranglerwho session shim — injects --profile for ${p.name}
REAL=${sq(real)}
PROFILE=${sq(p.name)}
# auth/login/logout reject --profile; pass them straight through.
case "$1" in
  auth|login|logout)
    exec "$REAL" "$@" ;;
  whoami)
    printf '%s\\n' ${sq(activeMsg)}
    printf '%s\\n' "(this shell runs: wrangler --profile $PROFILE ...)"
    exit 0 ;;
esac
# If a --profile is already present, don't add ours: two --profile flags make
# wrangler parse an array and crash ("name2.toLowerCase is not a function").
for a in "$@"; do
  case "$a" in
    --profile|--profile=*) exec "$REAL" "$@" ;;
  esac
done
exec "$REAL" --profile "$PROFILE" "$@"
`;
  const shimFile = path.join(shimDir, "wrangler");
  fs.writeFileSync(shimFile, shim, { mode: 0o755 });

  // record lastUsed
  const notes = readNotes();
  notes[p.name] = { ...(notes[p.name] || {}), lastUsed: new Date().toISOString() };
  writeNotes(notes);

  // Give each profile its own wrangler cache dir. wrangler's Pages commands
  // cache account_id in pages.json *unscoped by profile*, so without this,
  // switching accounts reuses the previous account's id and fails auth.
  const cacheDir = path.join(ROOT, "cache", p.name);
  fs.mkdirSync(cacheDir, { recursive: true });

  const shell = process.env.SHELL || "/bin/zsh";
  const env = {
    ...process.env,
    PATH: shimDir + path.delimiter + process.env.PATH,
    WRANGLERWHO_PROFILE: p.name,
    WRANGLERWHO_REAL: real, // so a nested session resolves the real binary, not this shim
    WRANGLER_CACHE_DIR: cacheDir, // isolate wrangler's account/pages cache per profile
  };
  console.log(
    green("● ") + `wrangler is now ${bold(label)}` + (p.email ? dim(` (${p.email})`) : "") +
    dim("  — run wrangler commands; `exit` to leave")
  );
  const child = spawn(shell, ["-i"], { stdio: "inherit", env });
  child.on("exit", (code) => {
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
    process.exit(code || 0);
  });
}

// ---------- commands ----------
async function cmdUse(args) {
  assertNativeProfiles();
  const name = args.find((a) => !a.startsWith("-"));
  guardDefault(name);
  const profiles = listProfiles();
  if (!profiles.length) die("no accounts yet. add one with `wranglerwho add <name>`");
  let p;
  if (name) {
    p = matchProfile(profiles, name);
    if (!p) die(`no account named "${name}"`);
  } else {
    p = await pickProfile(profiles);
  }
  activate(p);
}

async function cmdAdd(args) {
  assertNativeProfiles();
  // The label is free-form (e.g. daze@stacked); join words so unquoted labels
  // with spaces still work.
  const label =
    args.filter((a) => !a.startsWith("-")).join(" ") ||
    (await prompt("Account label (e.g. work, daze@stacked): "));
  if (!label) die("a label is required");
  if (/[|│\u0000-\u001f]/.test(label)) die('label can\'t contain "|" or control characters');

  // Derive a wrangler-safe profile id; keep the friendly label for display.
  const taken = new Set(listProfiles().map((p) => p.name));
  const profileId = uniqueId(toProfileId(label), taken);

  const noBrowser = authCreateSupportsNoBrowser();
  console.log();
  console.log(bold(`Logging in account "${label}" via wrangler auth create.`));
  if (profileId !== label) {
    console.log(dim(`wrangler profile name: "${profileId}"  (names allow only letters, numbers, - and _)`));
  }
  if (noBrowser) {
    console.log(dim("wrangler will print a login URL (it won't auto-open a browser)."));
    console.log(dim("Open that URL in the exact browser / container you want for this account."));
  } else {
    console.log(dim("wrangler will open your default browser. If it's the wrong one,"));
    console.log(dim("copy the URL it prints and paste it into the right browser / container."));
  }
  console.log();

  const createArgs = ["auth", "create", profileId];
  if (noBrowser) createArgs.push("--no-browser");
  const r = wrangler(createArgs, { stdio: "inherit" });
  if (r.status !== 0) die("wrangler auth create failed; nothing saved");

  const noteText = await prompt("Notes (optional): ");
  console.log(dim("capturing account identity..."));
  const info = captureIdentity(profileId);

  const notes = readNotes();
  notes[profileId] = {
    ...(notes[profileId] || {}),
    label,
    notes: noteText,
    email: info.email || (notes[profileId] && notes[profileId].email) || "",
    accountName: info.accountName || "",
    accountId: info.accountId || "",
    createdAt: (notes[profileId] && notes[profileId].createdAt) || new Date().toISOString(),
  };
  writeNotes(notes);
  console.log(
    green("✓ ") + `added ${bold(label)}` +
    (profileId !== label ? dim(` (wrangler: ${profileId})`) : "") +
    (info.email ? dim(` ${info.email}`) : "")
  );
}

function cmdList() {
  const profiles = listProfiles();
  if (!profiles.length) {
    console.log(dim("no accounts yet. add one with ") + bold("wranglerwho add <name>"));
    return;
  }
  profiles.forEach((p, i) => {
    console.log(
      [dim(`${i + 1}.`), bold(p.label), p.label !== p.name ? dim(`[${p.name}]`) : "",
       p.email ? dim(p.email) : "", p.accountName ? dim("· " + p.accountName) : "",
       p.bound ? dim("⟵ " + p.bound) : "", p.notes ? yellow("— " + p.notes) : ""]
        .filter(Boolean).join(" ")
    );
  });
}

function cmdRun(args) {
  assertNativeProfiles();
  const sep = args.indexOf("--");
  const head = sep === -1 ? args : args.slice(0, sep);
  const wargs = sep === -1 ? [] : args.slice(sep + 1);
  const name = head.find((a) => !a.startsWith("-"));
  if (!name) die("usage: wranglerwho run <name> -- <wrangler args>");
  guardDefault(name);
  if (!wargs.length) die("put the wrangler command after `--`");
  const p = matchProfile(listProfiles(), name);
  const profileId = p ? p.name : name;
  const r = spawnSync("wrangler", ["--profile", profileId, ...wargs], { stdio: "inherit" });
  process.exit(r.status || 0);
}

async function cmdNote(args) {
  const name = args[0];
  if (!name) die("usage: wranglerwho note <name> [text]");
  guardDefault(name);
  const p = matchProfile(listProfiles(), name);
  const notes = readNotes();
  if (!p && !notes[name]) die(`no account named "${name}"`);
  const id = p ? p.name : name;
  const disp = p ? p.label : name;
  const text = args.slice(1).join(" ") || (await prompt(`Notes for ${disp}: `));
  notes[id] = { ...(notes[id] || {}), notes: text };
  writeNotes(notes);
  console.log(green("✓ ") + `notes updated for ${bold(disp)}`);
}

async function cmdRm(args) {
  assertNativeProfiles();
  const name = args[0];
  if (!name) die("usage: wranglerwho rm <name>");
  guardDefault(name);
  const p = matchProfile(listProfiles(), name);
  if (!p) die(`no account named "${name}"`);
  const idTag = p.label !== p.name ? dim(` (wrangler: ${p.name})`) : "";
  const ans = await prompt(`Delete profile ${bold(p.label)}${idTag} from wrangler and remove its notes? [y/N] `);
  if (ans.toLowerCase() !== "y") { console.log(dim("cancelled")); return; }
  const r = wrangler(["auth", "delete", p.name], { stdio: "inherit" });
  if (r.status !== 0) console.log(yellow("! ") + "wrangler auth delete reported an error; removing notes anyway");
  const notes = readNotes();
  delete notes[p.name];
  writeNotes(notes);
  console.log(green("✓ ") + `removed ${p.label}`);
}

function cmdHelp() {
  console.log(`${bold("wranglerwho")} — switch between Cloudflare / wrangler accounts

${bold("Usage")}
  wranglerwho                 pick an account, then run wrangler in a subshell
  wranglerwho use [name]      same; jump straight to a named account
  wranglerwho run <name> -- <wrangler args>   one-shot command as that account
  wranglerwho add <name>      log in a new account (wrangler auth create)
  wranglerwho ls              list accounts and notes
  wranglerwho note <name> [text]   set/edit notes for an account
  wranglerwho rm <name>       delete an account (wrangler auth delete)
  wranglerwho help

${bold("How it works")}
  Logins and credentials are wrangler's own native auth profiles (beta).
  wranglerwho adds notes, an interactive picker, and a subshell where a
  ${cyan("wrangler")} shim injects ${cyan("--profile <name>")} so every command targets the
  account you picked. Notes live in ~/.wranglerwho/notes.json.`);
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case undefined: return cmdUse([]);
    case "use": case "select": return cmdUse(args);
    case "add": case "login": return cmdAdd(args);
    case "ls": case "list": return cmdList();
    case "run": return cmdRun(args);
    case "note": case "notes": return cmdNote(args);
    case "rm": case "remove": case "delete": return cmdRm(args);
    case "help": case "-h": case "--help": return cmdHelp();
    default:
      guardDefault(cmd);
      if (matchProfile(listProfiles(), cmd)) return cmdUse([cmd]);
      die(`unknown command "${cmd}" — try \`wranglerwho help\``);
  }
}

main().catch((e) => die(e.message));
