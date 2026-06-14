# Reference — server tools (`packages/backend/src/server/tools/`)

This directory is the I/O half of the tool system: every tool that touches the filesystem, a subprocess, the network, or the JSON file store lives here as a `(ToolDefinition, ToolImpl)` pair and is registered into the library-side `ToolRegistry` (`packages/backend/src/lib/meta-agent/registry.ts`). Definitions are pure data (name, description, `category`, `risk`, optional argument-aware `isDestructive`, Zod schema — `registry.ts:39`); implementations are async functions `(args, ctx: ToolRunContext) => Promise<ToolExecResult>` that never throw — every failure becomes `{ success: false, result: string }`. Alongside the tools sit the safety primitives they share: the filesystem jail (`sandbox.ts`), the SSRF egress guard (`url-guard.ts`), env scrubbing for subprocesses, and the `SH_ENABLE_TOOLS` destructive kill switch.

```
packages/backend/src/server/api/tick.ts:219     packages/backend/src/server/api/settings/skills.ts:16,61
        │                                                  │
        ▼                                                  ▼
createAppRegistryWithCustomTools()  ──────────►  createAppRegistry()
  (built-ins + .simple-harmonic/skills/*.json)     (built-ins only)
        │                                                  │
        │   listCustomToolFiles() →                        │
        │   buildApiToolDef/buildApiToolImpl               │
        └──────────────────────┬───────────────────────────┘
                               ▼
            registry.register(def, impl)  × 12 server tools (+ 3 lib tools)
                               │
   runner.ts:442  ─────►  registry.execute(name, rawArgs, ctx)   (Zod validate)
                               │
                               ▼
                          tool impl
            ┌──────────┬───────┴───────┬────────────┬─────────────┐
            ▼          ▼               ▼            ▼             ▼
        sandbox.ts  url-guard.ts   proxyFetch    store repos   runSubprocess
        (jail, env  (SSRF check,   (pinned-IP    (teams/       (codex / claude /
         scrub,      DNS pin)       HTTPS)        agents/       opencode CLI)
         kill switch)                            actionLog)
```

Action emission: a successful impl may attach `action: { actionType, payload }` (`ToolResult`, `packages/backend/src/lib/meta-agent/tools.ts:14`); the tick handler persists it via the `actionLog` repo, appending one row to the agent's `actions.jsonl` (`packages/backend/src/server/api/tick.ts:673,687`). Most payloads carry a UI snippet capped at 2,000 chars.

`ToolRunContext` (`packages/backend/src/lib/meta-agent/tools.ts:39`, extends `ToolExecContext` at `tools.ts:31`) — what every impl receives as `ctx`:

| Field | Type | Used in this directory by |
|---|---|---|
| `teamId` | `string` | management tools (scope root, `parentTeamId` for spawns), `action_history` team scope, `observe_app` query filter |
| `agentId` | `string` | `action_history` self scope, `modify_agent` self-deletion guard |
| `agentName` | `string` | unused here — in fact no registered impl (lib or server) reads `ctx.agentName`; the runner fills it from `config.name` (`runner.ts:191`) and uses `config.name` directly for its own summaries |
| `peers` | `PeerAgent[]` | unused here |
| `a2ax` | `A2AXSender` | unused here |

---

## packages/backend/src/server/tools/index.ts

Assembly point. Imports every def/impl pair, builds the registry, and re-exports the pairs plus the sandbox primitives.

### `createAppRegistry()` — `packages/backend/src/server/tools/index.ts:45`
Calls `createDefaultRegistry()` (`packages/backend/src/lib/meta-agent/default-tools.ts:46`) to get the three internal tools (`send_message`, `broadcast`, `report_action`), then registers the 12 server tools in this order: `read_file`, `write_file`, `run_command`, `coding_task`, `http_fetch`, `github_api`, `set_team_goal`, `spawn_sub_team`, `modify_agent`, `modify_team`, `action_history`, `observe_app` (`index.ts:48-59`). `ToolRegistry.register` throws on a duplicate name (`registry.ts:83`), so assembly fails loud on collisions. Returns the 15-tool registry (pinned by `server-tools.test.ts:400` — `toHaveLength(15)`).
- **Calls:** `createDefaultRegistry`, `ToolRegistry.register` with each def/impl pair from `filesystem.ts`, `shell.ts`, `coding/index.ts`, `network.ts`, `management.ts`, `action-history.ts`, `observe.ts`.
- **Called by:** `createAppRegistryWithCustomTools` (`index.ts:69`); `packages/backend/src/server/api/settings/skills.ts:16,61` (list tool metadata; validate PATCHed tool allowlists — built-ins only, so custom tool names are rejected there); tests `packages/backend/tests/unit/server-tools.test.ts:367,389,399`, `packages/backend/tests/unit/security/tools-security.test.ts:260-295`.

### `createAppRegistryWithCustomTools()` — `packages/backend/src/server/tools/index.ts:68`
`createAppRegistry()` plus file-defined custom tools: iterates `listCustomToolFiles()` (`packages/backend/src/server/custom-tools.ts:39`), skips any tool whose name is already registered (`registry.has`, first-wins — a custom tool can never shadow a built-in), and registers `buildApiToolDef(name, description, config)` / `buildApiToolImpl(name, config)` for the rest. The whole loop is wrapped in a single `try/catch {}` — if the skills directory is unreadable, custom tools are silently absent; and because the catch sits outside the loop, one tool whose def construction throws (e.g. a config missing `allowedMethods` crashes `buildApiToolDef` at `api-tool-runtime.ts:25` before its Zod schema is built) silently drops every custom tool not yet registered. Synchronous (file reads).
- **Calls:** `createAppRegistry`, `listCustomToolFiles`, `ToolRegistry.has`, `ToolRegistry.register`, `buildApiToolDef`, `buildApiToolImpl`.
- **Called by:** `packages/backend/src/server/api/tick.ts:219` (fresh registry per team per tick; type referenced at `tick.ts:371`); tests `packages/backend/tests/unit/custom-tools.test.ts:115-162`.

### Re-exports — `packages/backend/src/server/tools/index.ts:86-117`
Every def/impl pair except `set_team_goal` is re-exported (lines 86-111) so consumers can import from `@simple-harmonic/backend/server/tools` (`setTeamGoalDef`/`setTeamGoalImpl` are registered at `index.ts:54` but not re-exported — import them from `./management` directly). Lines 112-117 re-export the sandbox surface: `toolsRoot`, `toolsEnabled`, `resolveInJail`, `JailEscapeError`. (`packages/backend/src/server/api/settings/connectors.ts:7` imports `toolsEnabled`/`toolsRoot` directly from `server/tools/sandbox` instead.)

---

## packages/backend/src/server/tools/sandbox.ts

Containment primitives shared by the filesystem, shell, and coding tools. No tool defs here.

### `toolsRoot()` — `packages/backend/src/server/tools/sandbox.ts:24`
Returns `resolve(process.env.SH_TOOLS_CWD || process.cwd())` — the jail root. Every `read_file`/`write_file` path, the `run_command` cwd, the coding-subprocess cwd, the skills directory, and the connectors directory resolve against it. Re-evaluated on every call (env changes take effect immediately; tests rely on this).
- **Calls:** `node:path.resolve`.
- **Called by:** `resolveInJail` (`sandbox.ts:59`), `resolveInJailReal` (`sandbox.ts:91`), `filesystem.ts:52,83,123,127` (relative-path display), `shell.ts:154` (execFile cwd), `coding/index.ts:119` (coding cwd), `custom-tools.ts:36` (skills dir), `connectors.ts:30,34,103` (connectors dir, secrets file), `packages/backend/src/server/api/settings/connectors.ts:51` (settings display).

### `toolsEnabled()` — `packages/backend/src/server/tools/sandbox.ts:36`
The destructive-tools kill switch. Returns true only when `process.env.SH_ENABLE_TOOLS`, lowercased, is `"1"`, `"true"`, or `"yes"`. Default OFF. Gates `write_file`, `run_command`, `coding_task`, and mutating `github_api` calls — independent of (and in addition to) the registry's approval gate. Read-only tools (`read_file`, `http_fetch`, GET `github_api`) are not gated.
- **Calls:** nothing (env read).
- **Called by:** `filesystem.ts:108` (`write_file`), `shell.ts:109` (`run_command`), `network.ts:106` (`github_api` writes), `coding/index.ts:109` (`coding_task`), `packages/backend/src/server/api/settings/connectors.ts:40-41` (settings display).

### class `JailEscapeError` — `packages/backend/src/server/tools/sandbox.ts:42`
`extends Error`; constructor takes the requested path and sets the message to `Path "<requested>" resolves outside the allowed working directory` and `name = "JailEscapeError"`. Thrown by both jail resolvers; `filesystem.ts`'s `errToMessage` special-cases it to surface the message verbatim.
- **Called by (instanceof checks / throws):** thrown at `sandbox.ts:62,72,99`; caught at `filesystem.ts:142`; re-exported from `index.ts:116`.

### `resolveInJail(requestedPath)` — `packages/backend/src/server/tools/sandbox.ts:58`
Synchronous **logical** containment. Throws `JailEscapeError` if the path contains a null byte (`\0`). Resolves the input against `toolsRoot()` (an absolute input is resolved as-is) and checks containment textually via the private `isContained` — throws if `relative(root, abs)` starts with `..` or is absolute. Returns the absolute path. Does **not** follow symlinks; it is the fast first gate.
- **Calls:** `toolsRoot`, `node:path.resolve/isAbsolute`, `isContained`.
- **Called by:** `resolveInJailReal` (`sandbox.ts:90`), `coding/run-subprocess.ts:39` (re-asserts the subprocess cwd before `spawn`); re-exported from `index.ts:115`.

### `resolveInJailReal(requestedPath)` — `packages/backend/src/server/tools/sandbox.ts:89`
Async **symlink-aware** containment: runs `resolveInJail` first, then realpaths the jail root itself (`realpath(root).catch(() => root)` — so a root under a symlink like macOS `/tmp` → `/private/tmp` compares real-to-real), computes the effective real location of the target via `realpathDeepestExisting`, and throws `JailEscapeError` if that escapes the real root. Returns the **logical** absolute path (callers read/write through it; the OS resolves the now-verified symlinks). Closes the hole where a symlink inside the jail points outside.
- **Calls:** `resolveInJail`, `toolsRoot`, `node:fs/promises.realpath`, `realpathDeepestExisting`, `isContained`.
- **Called by:** `filesystem.ts:51` (`read_file`), `filesystem.ts:117` (`write_file`). Not used by the shell or coding tools (their cwd is `toolsRoot()` itself).

### `scrubbedEnv()` — `packages/backend/src/server/tools/sandbox.ts:110`
Builds a minimal child-process environment from an allowlist of exactly eight variables: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `TMPDIR`, `TZ`. Everything else in `process.env` (API keys, `GITHUB_TOKEN`, `APOLLO_MASTER_KEY`, etc.) is dropped. Unset allowlisted vars are omitted, not set to empty.
- **Calls:** nothing (env read).
- **Called by:** `shell.ts:159` (`run_command` execFile env), `codingEnv` (`sandbox.ts:129`).

### `codingEnv(extraKeys = [])` — `packages/backend/src/server/tools/sandbox.ts:128`
`scrubbedEnv()` plus only the explicitly named provider keys (e.g. `ANTHROPIC_API_KEY`). Each key must match `/^[A-Z][A-Z0-9_]*$/`; non-matching names are silently ignored, and unset keys are omitted. Same posture as `run_command`, applied to the coding subprocesses.
- **Calls:** `scrubbedEnv`.
- **Called by:** `coding/run-subprocess.ts:52` (spawn env); tests `coding-env.test.ts`, `run-subprocess.test.ts`.

### `isContained(root, target)` (private) — `packages/backend/src/server/tools/sandbox.ts:143`
Textual check, no fs: `relative(root, target)` must be `""` (the root itself) or neither start with `..` nor be absolute.
- **Called by:** `resolveInJail` (`sandbox.ts:71`), `resolveInJailReal` (`sandbox.ts:98`). Not exported.

### `realpathDeepestExisting(abs)` (private) — `packages/backend/src/server/tools/sandbox.ts:154`
Walks up from `abs` until it finds the deepest path component that exists (`pathExists`, i.e. `lstat` succeeds), realpaths that component, and re-appends the non-existent tail components (which cannot themselves be symlinks). If it somehow reaches the filesystem root without finding an existing component, returns `abs` unchanged (loop guard). Result: the effective real location the OS would resolve `abs` to.
- **Calls:** `pathExists`, `node:fs/promises.realpath`, `node:path.dirname/join`.
- **Called by:** `resolveInJailReal` (`sandbox.ts:97`). Not exported.

### `pathExists(p)` (private) — `packages/backend/src/server/tools/sandbox.ts:176`
`lstat(p)` → true; any error → false. `lstat` (not `stat`) so a dangling symlink still counts as existing and gets realpath-checked.
- **Called by:** `realpathDeepestExisting` (`sandbox.ts:160`). Not exported.

---

## packages/backend/src/server/tools/url-guard.ts

Single SSRF egress policy for every agent-driven outbound request. Runs before any request is sent and before any connector secret is attached.

### `stripIpv6Brackets(host)` — `packages/backend/src/server/tools/url-guard.ts:18`
Returns `host` with one layer of surrounding `[` `]` removed if present (URL-literal IPv6 form), otherwise unchanged.
- **Calls:** nothing.
- **Called by:** `assertPublicAndResolve` (`url-guard.ts:76`). Exported but not imported elsewhere in src.

### `isPrivateIpv4(ip)` — `packages/backend/src/server/tools/url-guard.ts:22`
Parses the first two dotted octets and returns true for: `0.*`, `10.*`, `127.*` (loopback), `100.64.*`–`100.127.*` (CGNAT), `169.254.*` (link-local / cloud metadata), `172.16.*`–`172.31.*`, `192.168.*`, `198.18.*`–`198.19.*` (benchmarking), and everything with first octet `>= 224` (multicast + reserved).
- **Calls:** `Number.parseInt`.
- **Called by:** `isPrivateIp` (`url-guard.ts:51`), `isPrivateIpv6` (`url-guard.ts:43`, for `::ffff:`-mapped addresses).

### `isPrivateIpv6(ip)` — `packages/backend/src/server/tools/url-guard.ts:37`
Lowercases, then returns true for `::1`, `::`, any address starting `fc` or `fd` (ULA), any starting `fe80` (link-local), and `::ffff:<v4>` mapped addresses whose IPv4 part is private (delegates to `isPrivateIpv4`).
- **Calls:** `isPrivateIpv4`.
- **Called by:** `isPrivateIp` (`url-guard.ts:52`).

### `isPrivateIp(host)` — `packages/backend/src/server/tools/url-guard.ts:49`
Dispatcher: `node:net.isIP` → 4 ⇒ `isPrivateIpv4`, 6 ⇒ `isPrivateIpv6`, otherwise false (not an IP literal — the caller must resolve DNS first).
- **Calls:** `isIP`, `isPrivateIpv4`, `isPrivateIpv6`.
- **Called by:** `assertPublicAndResolve` (`url-guard.ts:84,102`); test `packages/backend/tests/unit/security/url-guard.test.ts:25-31`.

### interface `PinnedTarget` — `packages/backend/src/server/tools/url-guard.ts:56`

| Field | Type | Meaning |
|---|---|---|
| `url` | `URL` | The parsed, validated URL |
| `pinnedIp` | `string` | The public IP the connection must use |
| `family` | `4 \| 6` | IP family of `pinnedIp` |

### `assertPublicAndResolve(rawUrl)` — `packages/backend/src/server/tools/url-guard.ts:67`
Validates a URL for outbound agent use and returns a `PinnedTarget`. Throws `Error` (plain, with a descriptive message) on each violation, in order:
1. `new URL(rawUrl)` (throws on unparseable input).
2. Protocol must be exactly `https:` → `"Only https:// URLs are allowed"`.
3. No embedded credentials (`url.username || url.password`) → `"Credentials in URLs are not allowed"`.
4. Hostname is lowercased, a trailing dot stripped, IPv6 brackets stripped; `localhost` or any `*.localhost` → `"Localhost URLs are not allowed"`.
5. IP-literal host: `isPrivateIp` → `"Private-network URLs are not allowed"`; otherwise the literal itself is the pin (no DNS).
6. DNS name: `dns/promises.lookup(host, { all: true })`; failure → `"DNS resolution failed for <host>"`; empty set → `"No DNS records for <host>"`; **any** private address in the record set → `"Host resolves to a private-network address"` (a mixed public+private rebind set is rejected wholesale).
7. Pin selection: prefer the first IPv4 record (matches the v4 pin `proxy-fetch` relies on to avoid v6 tunnel hangs), else the first address.

The pin is consumed by `proxyFetch` (`packages/backend/src/server/proxy-fetch.ts:130`), which overrides DNS at connect time while keeping the hostname for TLS SNI/cert verification — closing the DNS-rebinding TOCTOU.
- **Calls:** `stripIpv6Brackets`, `isIP`, `isPrivateIp`, `dns/promises.lookup`.
- **Called by:** `network.ts:43` (`http_fetch`), `network.ts:143` (`github_api`), `api-tool-runtime.ts:98` (custom API tools); tests `url-guard.test.ts`, `api-tool-ssrf.test.ts`.

---

## packages/backend/src/server/tools/filesystem.ts

### Constants
- `MAX_READ_BYTES = 256 * 1024` (262,144 bytes) — `filesystem.ts:18`.
- `UI_SNIPPET_BYTES = 2_000` — `filesystem.ts:19`; cap on the `output` field in action payloads.

### tool `read_file` — def `packages/backend/src/server/tools/filesystem.ts:38`, impl `filesystem.ts:49`
Schema (`readFileSchema`, `filesystem.ts:21`):

| Field | Zod type | Notes |
|---|---|---|
| `path` | `z.string()` | Relative to the project working directory; description points agents at `.simple-harmonic/skills/` and `.simple-harmonic/connectors/` |

Category `filesystem`, risk `safe`, no `isDestructive`, no kill switch.

Impl steps:
1. `resolveInJailReal(args.path)` — symlink-aware jail check.
2. `isSensitivePath(relative(toolsRoot(), abs))` — deny → `Refusing to read sensitive path: <path>` (failure, not an exception).
3. `stat(abs)`; non-file → `Not a file: <path>`.
4. Size > `MAX_READ_BYTES` → `File too large (<n> bytes, max 262144). Read a smaller file or a subset.`
5. `readFile(abs, "utf-8")` and return the **full** contents as `result`.

Action: `file_read` with payload `{ path (jail-relative), bytes, output (first 2,000 chars) }`. Errors: any throw is mapped by `errToMessage` into a `success: false` result.
- **Calls:** `resolveInJailReal`, `toolsRoot`, `isSensitivePath`, `node:fs/promises.stat/readFile`, `errToMessage`.
- **Called by:** registered at `index.ts:48`; executed via `ToolRegistry.execute` (`registry.ts:147`) from `runner.ts:442`; re-exported `index.ts:87-88`.

### tool `write_file` — def `packages/backend/src/server/tools/filesystem.ts:98`, impl `filesystem.ts:107`
Schema (`writeFileSchema`, `filesystem.ts:31`):

| Field | Zod type | Notes |
|---|---|---|
| `path` | `z.string()` | Relative to the project working directory |
| `content` | `z.string()` | Full file contents (overwrite semantics) |

Category `filesystem`, risk `destructive` (static), **kill-switch gated**: if `!toolsEnabled()`, returns failure `"write_file is disabled. Destructive tools require SH_ENABLE_TOOLS to be set; …"` before doing anything.

Impl steps: `resolveInJailReal` → `mkdir(dirname(abs), { recursive: true })` → `writeFile(abs, content, "utf-8")` (overwrite). Success result: `Wrote <n> chars to <relpath>`. **No sensitive-path check** — `isSensitivePath` guards reads only, so with the switch on, `write_file` can overwrite any jailed path including `.env` files.

Action: `file_written` with payload `{ path (jail-relative), chars }` (no content snippet). Errors mapped by `errToMessage`.
- **Calls:** `toolsEnabled`, `resolveInJailReal`, `node:fs/promises.mkdir/writeFile`, `toolsRoot`, `errToMessage`.
- **Called by:** registered at `index.ts:49`; executed via `registry.execute` from `runner.ts:442`; re-exported `index.ts:89-90`.

### `errToMessage(tool, path, err)` — `packages/backend/src/server/tools/filesystem.ts:141`
Maps exceptions to friendly strings: `JailEscapeError` → its own message; errno `ENOENT` → `File not found: <path>`; `EACCES` → `Permission denied: <path>`; `EISDIR` → `Path is a directory, not a file: <path>`; anything else → `<tool> failed for <path>: <message>`.
- **Calls:** nothing.
- **Called by:** `readFileImpl` (`filesystem.ts:93`), `writeFileImpl` (`filesystem.ts:136`). Not exported.

### `isSensitivePath(path)` — `packages/backend/src/server/tools/filesystem.ts:150`
Denylist applied to the jail-relative path: backslashes normalized to `/`, lowercased, basename extracted. Returns true for:
- any path containing `.simple-harmonic/secrets.json`;
- anything under `.apollo/` or exactly `.apollo`;
- basenames starting `.env` unless they end `.example`, `.sample`, or `.template`;
- basenames `.npmrc`, `.pypirc`, `.netrc`;
- basenames `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`;
- basenames ending `.pem` or `.key`;
- exactly `.ssh`, paths starting `.ssh/`, or any path containing `/.ssh/`.

- **Calls:** `node:path.basename`.
- **Called by:** `readFileImpl` (`filesystem.ts:53`) only — not `writeFileImpl`. Not exported.

---

## packages/backend/src/server/tools/shell.ts

### Constants
- `TIMEOUT_MS = 30_000` — `shell.ts:23`.
- `MAX_OUTPUT_BYTES = 64 * 1024` (65,536) — `shell.ts:24`; used both as `execFile`'s `maxBuffer` and as the slice cap on returned text.
- `ALLOWED_PROGRAMS` — `shell.ts:29`, a `Set` of exactly 23 programs: `git`, `ls`, `cat`, `rg`, `grep`, `find`, `diff`, `tsc`, `vitest`, `npm`, `npx`, `biome`, `echo`, `pwd`, `wc`, `head`, `tail`, `mkdir`, `cp`, `mv`, `sort`, `uniq`, `tr`. Interpreters/package runners that execute arbitrary code (`node`, `python`, `sh`, …) are deliberately absent.
- `ALLOWED_GIT_SUBCOMMANDS` — `shell.ts:59`, a `Set` of 23 subcommands. Read-only: `status`, `log`, `diff`, `show`, `rev-parse`, `ls-files`, `grep`, `blame`, `branch`, `stash`. Write (permitted because `run_command` is itself approval-gated): `add`, `commit`, `push`, `pull`, `fetch`, `checkout`, `switch`, `merge`, `rebase`, `cherry-pick`, `restore`, `reset`, `tag`.

### tool `run_command` — def `packages/backend/src/server/tools/shell.ts:99`, impl `shell.ts:108`
Schema (`runCommandSchema`, `shell.ts:87`):

| Field | Zod type | Notes |
|---|---|---|
| `command` | `z.string()` | Program name, must be on the allowlist |
| `args` | `z.array(z.string()).optional()` | Literal argv — not a shell string |

Category `shell`, risk `destructive` (static), **kill-switch gated**.

Impl steps, checked in order:
1. `!toolsEnabled()` → fixed disabled message (failure).
2. `program = args.command.trim()`; not in `ALLOWED_PROGRAMS` → `Program "<p>" is not allowed. Allowed: <sorted list>`.
3. Any argv element matching `isEscapingArg` → `Argument "<a>" is not allowed because it can access paths outside the working directory`.
4. For `git`: `argv[0]` missing or not in `ALLOWED_GIT_SUBCOMMANDS` → `git <sub> is not allowed. Use read-only git subcommands like status, log, diff, show, ls-files, grep, or blame.`
5. `execFile(program, argv, { cwd: toolsRoot(), timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, env: scrubbedEnv() })` — **no shell**, so `|`, `;`, `&&`, `$()`, backticks are inert argv tokens.

Result handling (in the `execFile` callback):
- `err.killed` (timeout) → failure `Command timed out after 30000ms: <program> <args>`.
- Other `err` (non-zero exit, spawn failure) → failure `Command failed: <program> <args>\n<stderr || stdout || err.message>` sliced to 64 KiB.
- Success: stdout, with stderr (if any) appended under a `\n[stderr]\n` marker, sliced to 64 KiB; empty output becomes `(no output)`.

Action (success only): `command_run` with payload `{ command, args, output (first 2,000 chars) }`. The impl returns via a wrapped `Promise` and never rejects.
- **Calls:** `toolsEnabled`, `isEscapingArg`, `toolsRoot`, `scrubbedEnv`, `node:child_process.execFile`.
- **Called by:** registered at `index.ts:50`; executed via `registry.execute` from `runner.ts:442`; re-exported `index.ts:92`.

### `isEscapingArg(arg)` — `packages/backend/src/server/tools/shell.ts:207`
Argument screen. Returns true (rejected) for: any null byte; absolute paths (`/...`); `~` exactly or `~/...`; `..` exactly, `../...`, or any `/../` inside; and the git redirection flags `--git-dir=`, `--work-tree=`, `--output=`, `--exec-path=` (regex `/^--(?:git-dir|work-tree|output|exec-path)=/`).
- **Calls:** nothing.
- **Called by:** `runCommandImpl` (`shell.ts:129`). Not exported.

---

## packages/backend/src/server/tools/network.ts

### Constants
- `MAX_BODY_BYTES = 128 * 1024` (131,072) — `network.ts:21`; streaming response-body cap.
- `FETCH_TIMEOUT_MS = 20_000` — `network.ts:22`; `AbortController` timeout per request.

### tool `http_fetch` — def `packages/backend/src/server/tools/network.ts:30`, impl `network.ts:39`
Schema (`httpFetchSchema`, `network.ts:26`):

| Field | Zod type | Notes |
|---|---|---|
| `url` | `z.string().url()` | Absolute public HTTPS URL to GET |

Category `network`, risk `safe`, no kill switch — read-only by construction (GET is the only method).

Impl steps:
1. Arm a 20 s `AbortController` timer (cleared in `finally`).
2. `assertPublicAndResolve(args.url)` → validated URL + pinned IP.
3. `proxyFetch(url, { method: "GET", signal }, { ip: pinnedIp, family })` (`packages/backend/src/server/proxy-fetch.ts:130` — proxy-aware; on the direct path DNS is overridden to the pin while the hostname is kept for TLS).
4. `readCappedText(res, MAX_BODY_BYTES)` — streams up to 128 KiB, also counting total bytes read.
5. `success` mirrors `res.ok`. Non-2xx → `HTTP <status> <statusText>: <first 2,000 chars>`.

Action: `http_fetched` with payload `{ url, status, bytes (total read), output (first 2,000 chars) }` — emitted on both ok and non-ok responses (the action sits outside the ok branch). Any throw (guard rejection, abort, network error) → failure `http_fetch failed for <url>: <message>`.
- **Calls:** `assertPublicAndResolve`, `proxyFetch`, `readCappedText`.
- **Called by:** registered at `index.ts:52`; executed via `registry.execute` from `runner.ts:442`; re-exported `index.ts:94-99`.

### tool `github_api` — def `packages/backend/src/server/tools/network.ts:93`, impl `network.ts:103`
Schema (`githubApiSchema`, `network.ts:80`):

| Field | Zod type | Notes |
|---|---|---|
| `method` | `z.enum(["GET","POST","PATCH","PUT","DELETE"])` | Non-GET is destructive and gated |
| `path` | `z.string()` | GitHub API path, leading slash required (checked in impl) |
| `body` | `z.record(z.string(), z.unknown()).optional()` | JSON body for writes |

Category `network`, risk `destructive` with argument-aware `isDestructive: (args) => args.method !== "GET"` (`network.ts:99`) — GET calls bypass the approval gate; writes suspend for approval.

Impl steps:
1. `isWrite = method !== "GET"`; if write and `!toolsEnabled()` → failure (`"Mutating github_api calls are disabled… GET requests are always allowed."`).
2. `resolveConnector("GITHUB_TOKEN")` (`packages/backend/src/server/connectors.ts:53` — `.simple-harmonic/secrets.json` first, then `process.env`). Write without token → failure `"GITHUB_TOKEN is not configured…"`. GET proceeds without a token (attached only if present).
3. `path` must start with `/` → else failure.
4. Headers: `Accept: application/vnd.github+json`, `User-Agent: simple-harmonic-agent`, `Authorization: Bearer <token>` when token resolved, `Content-Type: application/json` when a body is given.
5. URL fixed to `https://api.github.com<path>`; `assertPublicAndResolve` still runs on it for the pin; `proxyFetch` with 20 s abort; body JSON-serialized.
6. `readCappedText` 128 KiB; `success` mirrors `res.ok`; non-2xx → `GitHub <status> <statusText>: <first 2,000 chars>`.

Action: `github_api_called` with payload `{ method, path, status, output (first 2,000 chars) }`. Any throw → failure `github_api failed for <method> <path>: <message>`.
- **Calls:** `toolsEnabled`, `resolveConnector`, `assertPublicAndResolve`, `proxyFetch`, `readCappedText`.
- **Called by:** registered at `index.ts:53`; executed via `registry.execute` from `runner.ts:442`; re-exported `index.ts:94-99`.

### `readCappedText(res, maxBytes)` — `packages/backend/src/server/tools/network.ts:183`
Streams `res.body` via its reader, keeping at most `maxBytes` bytes (`bytesKept`) while counting **all** bytes read (`bytesRead`); once the cap is hit it cancels the reader (errors swallowed) and stops. Returns `{ text, bytesRead }` (UTF-8 decode of the kept buffer). No body → `{ text: "", bytesRead: 0 }`. Note: byte-boundary truncation can split a multi-byte UTF-8 character at the cap edge.
- **Calls:** WHATWG stream reader API.
- **Called by:** `httpFetchImpl` (`network.ts:49`), `githubApiImpl` (`network.ts:154`). Not exported. (A near-duplicate, `readCapped`, lives in `api-tool-runtime.ts` — same loop without `bytesRead`.)

---

## packages/backend/src/server/tools/management.ts

Four store-mutating tools for lead agents and Harmon, all category `internal` and risk `destructive` (static — every call is approval-gated; none checks the kill switch). All four go through the `teams`/`agents` repos imported from `../store` (`management.ts:15-16`) — no SQL, no transactions. All authorization goes through the two shared helpers below. All four impls wrap their whole body in `try/catch` and return `"<tool> failed: <message>"` on unexpected errors.

### `assertInSubTree(callerTeamId, targetTeamId, targetLabel)` — `packages/backend/src/server/tools/management.ts:23`
Loads the caller's team sub-tree via `getSubTreeIds(callerTeamId)` (`packages/backend/src/server/team-tree.ts:40` — now backed by `teams.all()` over the location index, not a recursive SQL query) and returns `null` if the target is inside it, otherwise the error string `"<label>" is outside your scope. You can only manage your team and its sub-teams.` Callers treat a non-null return as the failure result. An agent can therefore only manage its own team and descendants.
- **Calls:** `getSubTreeIds`.
- **Called by:** `setTeamGoalImpl` (`management.ts:69`), `modifyTeamImpl` (`management.ts:117`), `modifyAgentImpl` (`management.ts:285,321` — destination team re-checked on move). Not exported.

### `resolveTeamId(teamName, fallback)` — `packages/backend/src/server/tools/management.ts:35`
If `teamName` is undefined, returns `{ teamId: fallback }` (the caller's own team). Otherwise scans `teams.all()` for a row whose `name` matches (global, not scoped — scoping happens afterward in `assertInSubTree`); not found → `{ teamId: "", error: 'Team "<name>" not found.' }`.
- **Calls:** `teams.all`.
- **Called by:** `setTeamGoalImpl` (`management.ts:66`), `modifyTeamImpl` (`management.ts:114`), `modifyAgentImpl` (`management.ts:282`). Not exported.

### tool `set_team_goal` — def `packages/backend/src/server/tools/management.ts:54`, impl `management.ts:64`
Schema (`setTeamGoalSchema`, `management.ts:49`):

| Field | Zod type | Notes |
|---|---|---|
| `team_name` | `z.string().optional()` | Defaults to the caller's own team |
| `goal` | `z.string()` | The team objective |

Impl: `resolveTeamId` → `assertInSubTree` → `teams.update(teamId, { goal })` (rewrites that team's `team.json` via the store's atomic temp+rename). Success result `Goal set: "<goal>"`.
Action: `team_goal_set` with payload `{ teamId, goal }`.
- **Calls:** `resolveTeamId`, `assertInSubTree`, `teams.update`.
- **Called by:** registered at `index.ts:54`; executed via `registry.execute` from `runner.ts:442`.

### tool `modify_team` — def `packages/backend/src/server/tools/management.ts:101`, impl `management.ts:112`
Schema (`modifyTeamSchema`, `management.ts:89`):

| Field | Zod type | Notes |
|---|---|---|
| `team_name` | `z.string()` | Target team (by name) |
| `action` | `z.enum(["update","delete"])` | |
| `updates` | `z.object({ name?, goal?: string, paused?: boolean }).optional()` | `name`/`goal` are `z.string().optional()`; required for `update` |

Impl:
- Resolve + sub-tree check as above.
- **delete:** refuses the caller's own team (`"Cannot delete your own team."`). Counts the affected rows for the report — `getSubTreeIds(teamId)` for the team count, `agents.byTeams(subTreeIds).length` for the agent count — then `teams.delete(teamId)`, a single `rmdir` of the team's folder (`management.ts:131`). Because sub-teams nest under the parent's `teams/` dir and every agent's approvals/actions/trace plus the team's a2ax `messages/` live inside that folder, one recursive remove tears down the whole sub-tree at once — there is no per-table cascade and no transaction. Returns `Team "<name>" and <n> agent(s) deleted.`; action `team_deleted` with payload `{ teamId, teamName, agentsDeleted, teamsDeleted }`.
- **update:** requires `updates` (`"action 'update' requires updates."`); builds a partial set from `name`/`goal`/`paused`; empty set → `"No updates provided."`; `teams.update(teamId, set)`. Returns `Team "<name>" updated: <fields>.`; action `team_modified` with payload `{ teamId, updates: <field names> }`.
- **Calls:** `resolveTeamId`, `assertInSubTree`, `getSubTreeIds`, `agents.byTeams`, `teams.delete` / `teams.update`.
- **Called by:** registered at `index.ts:57`; executed via `registry.execute` from `runner.ts:442`; re-exported `index.ts:101-104`.

### tool `spawn_sub_team` — def `packages/backend/src/server/tools/management.ts:197`, impl `management.ts:207`
Schema (`spawnSubTeamSchema`, `management.ts:183`):

| Field | Zod type | Notes |
|---|---|---|
| `team_name` | `z.string()` | New sub-team name |
| `agents` | `z.array(z.object({ name, role, archetype: z.string(), tools: z.array(z.string()), schedule_seconds: z.number(), initial_prompt: z.string() }))` | Agents to create; no `output_contract` field here |

Impl: `teams.insert({ name, parentTeamId: ctx.teamId })` — the repo creates the sub-team folder under the parent's `teams/` dir and invalidates the location index (no sub-tree check needed — the parent is the caller by construction). If any agents, `agents.insertMany(team.id, …)` with `nextRunAt = now + schedule_seconds*1000 + i*2000` (2 s stagger per index). No chat-session row is created (the a2ax `messages/` folder is materialized lazily by the transport). Returns `Sub-team "<name>" created with <n> agent(s).`
Action: `sub_team_spawned` with payload `{ teamId, teamName, parentTeamId, agentCount }`.
- **Calls:** `teams.insert`, `agents.insertMany`.
- **Called by:** registered at `index.ts:55`; executed via `registry.execute` from `runner.ts:442`; re-exported `index.ts:105-110`.

### tool `modify_agent` — def `packages/backend/src/server/tools/management.ts:265`, impl `management.ts:277`
Schema (`modifyAgentSchema`, `management.ts:245`):

| Field | Zod type | Notes |
|---|---|---|
| `agent_name` | `z.string()` | Target agent name |
| `team_name` | `z.string().optional()` | Agent's team; defaults to caller's team |
| `action` | `z.enum(["update","delete","move"]).optional()` | Default `update` |
| `move_to_team` | `z.string().optional()` | Required for `move` |
| `updates` | `z.object({ tools?: string[], initial_prompt?: string, schedule_seconds?: number, status?: z.enum(["running","paused"]), role?: string, output_contract?: z.record(z.string(), z.unknown()) }).optional()` | Required for `update` |

Impl:
1. Resolve target team (`resolveTeamId`) + `assertInSubTree`.
2. Find the agent by scanning `agents.byTeam(targetTeamId)` for a matching `name`; not found → `Agent "<name>" not found in "<team>".`
3. **Self-deletion guard:** `agent.id === ctx.agentId && action === "delete"` → `"Cannot delete yourself."` (unconditional).
4. **delete:** `agents.delete(agent.id)` — one `rmdir` of the agent folder, which removes `agent.json` plus its `approvals.json`, `actions.jsonl`, and `trace.jsonl` together. Action `agent_deleted` `{ agentId, agentName }`.
5. **move:** requires `move_to_team`; destination team found by scanning `teams.all()` by name, must exist and pass its own `assertInSubTree`; `agents.move(agent.id, destTeam.id)` rewrites the agent's `teamId` and relocates its folder into the destination team's `agents/` dir. Action `agent_moved` `{ agentId, agentName, fromTeam, toTeam }`.
6. **update:** requires non-empty `updates`; maps snake_case → row fields (`initial_prompt`→`initialPrompt`, `schedule_seconds`→`scheduleSeconds`, `output_contract`→`outputContract`; `tools`, `status`, `role` direct) and applies via `agents.update(agent.id, set)`. Action `agent_modified` `{ agentId, agentName, updates: <field names> }`.

- **Calls:** `resolveTeamId`, `assertInSubTree`, `agents.byTeam` / `agents.delete` / `agents.move` / `agents.update`, `teams.all`.
- **Called by:** registered at `index.ts:56`; executed via `registry.execute` from `runner.ts:442`; re-exported `index.ts:105-110`.

---

## packages/backend/src/server/tools/action-history.ts

### tool `action_history` — def `packages/backend/src/server/tools/action-history.ts:40`, impl `action-history.ts:52`
Schema (`actionHistorySchema`, `action-history.ts:15`):

| Field | Zod type | Notes |
|---|---|---|
| `scope` | `z.enum(["agent","team","self"])` | |
| `agent_name` | `z.string().optional()` | Required when scope is `agent` |
| `team_name` | `z.string().optional()` | Optional for `team`; defaults to own team |
| `limit` | `z.number().optional()` | Default 20, clamped to max 50 |
| `validation_only` | `z.boolean().optional()` | Filter to entries carrying validation results |

Category `internal`, risk `safe`.

Impl steps:
1. `limit = min(args.limit ?? 20, 50)`.
2. Resolve target agent ids: `self` → `[ctx.agentId]`; `agent` → requires `agent_name` (`"scope 'agent' requires agent_name."`), found by scanning `agents.all()` by name **globally — not sub-tree restricted**; `team` → resolve team by name (default own team) via `teams.all()`, `getSubTreeIds`, then `agents.byTeams(subTreeIds)` (none → success `"No agents found in this team."`).
3. `actionLog.byAgents(targetAgentIds, { limit: limit * 2 })` — the repo reads each agent's `actions.jsonl`, merges, and sorts newest-first by `executedAt` (over-fetch `limit * 2` so the `validation_only` filter still fills the page).
4. Resolve agent names via `Promise.all(ids.map(agents.byId))`; map each row to `{ agent, actionType, timestamp, summary: summarize(...), validation }` where `validation` comes from `payload.validation` (`{ valid?: boolean, issues?: Array<{path, message}> }`, defaulting `valid` to true and `issues` to `[]`) or `null`.
5. Apply `validation_only` filter, slice to `limit`. Empty → success `"No entries with validation results found."` / `"No action history found."`
6. Render one line per entry: `[HH:MM:SS] <agent> · <actionType>: <summary>` plus ` [PASS]` or ` [FAIL: <path>: <message>; …]`.

Result: `"<n> entries:\n<lines>"`. **No action emitted** (read-only query; nothing appended to any `actions.jsonl`). Errors: catch-all → `action_history failed: <message>`.
- **Calls:** `agents.all` / `agents.byTeams` / `agents.byId`, `teams.all`, `actionLog.byAgents`, `getSubTreeIds`, `summarize`.
- **Called by:** registered at `index.ts:58`; executed via `registry.execute` from `runner.ts:442`; re-exported `index.ts:100`.

### `summarize(actionType, payload)` — `packages/backend/src/server/tools/action-history.ts:173`
Produces a one-line summary from an action payload, by preference: `payload.summary` → `payload.conclusion` → `payload.message` (each stringified and sliced to 120 chars); else if both `payload.tool` and `payload.args` exist → `` `${tool}(${JSON.stringify(args).slice(0,80)})` ``; else the JSON of the whole payload, truncated to 117 chars + `"..."` when over 120. The `actionType` parameter is accepted but unused in the body.
- **Calls:** `JSON.stringify`.
- **Called by:** `actionHistoryImpl` (`action-history.ts:119`). Not exported.

---

## packages/backend/src/server/tools/observe.ts

### tool `observe_app` — def `packages/backend/src/server/tools/observe.ts:39`, impl `observe.ts:48`
Schema (`observeAppSchema`, `observe.ts:16`):

| Field | Zod type | Notes |
|---|---|---|
| `severity` | `z.enum(["info","warning","error"]).optional()` | |
| `level` | `z.enum(["agent","team","tool"]).optional()` | `infra` deliberately not offered |
| `source` | `z.string().optional()` | e.g. `tick`, `tool`, `api`, `test` |
| `hours` | `z.number().optional()` | Default 1, clamped to max 24 |
| `limit` | `z.number().optional()` | Default 20, clamped to max 50 |

Category `internal`, risk `safe`.

Impl: clamps `hours`/`limit`, computes `since = now - hours*3600000`, then `queryAppEvents({ teamId: ctx.teamId, severity, level, source, since, limit, includeInfra: false })` (`packages/backend/src/server/app-events.ts:223`) — `includeInfra` is hard-coded false, so infrastructure-level events are never returned to agents. Zero events → success `"No events found in the last <h> hour(s)<filters>."`. Otherwise formats via `formatEventsForPrompt` (`app-events.ts:271`) and returns `"<n> event(s) in the last <h> hour(s):\n\n<formatted>"`.

Action (success with events only): `app_observed` with payload `{ eventCount, hours, filters: { severity, level, source } }`. Errors: catch-all → `observe_app failed: <message>`.
- **Calls:** `queryAppEvents`, `formatEventsForPrompt`.
- **Called by:** registered at `index.ts:59`; executed via `registry.execute` from `runner.ts:442`; re-exported `index.ts:111`.

---

## packages/backend/src/server/tools/api-tool-runtime.ts

Turns file-defined custom tools (`CustomToolFile` from `custom-tools.ts:29`) into registry pairs. Every custom tool is an HTTP API tool: a named tool that makes authenticated requests against a configured base URL, with methods restricted to the per-tool `allowedMethods` set. Exactly two exports: `buildApiToolDef` and `buildApiToolImpl`.

### Constants
- `MAX_BODY_BYTES = 128 * 1024` — `api-tool-runtime.ts:17` (same value as `network.ts`, defined separately).
- `FETCH_TIMEOUT_MS = 20_000` — `api-tool-runtime.ts:18`.

### consumed type: `ApiToolConfig` — defined at `packages/backend/src/server/store/types.ts:121`
Plain interface (imported at `api-tool-runtime.ts:12`); the shape of a custom tool file's `config` field, not backed by any store row. It was declared in the deleted `db/schema.ts` and was relocated here verbatim when PR #16 removed Postgres/Drizzle. How this module consumes each field:

| Field | Type | Consumption here |
|---|---|---|
| `baseUrl` | `string` | URL prefix: `new URL(baseUrl + pathPrefix + path)` (`api-tool-runtime.ts:86`); also shown in the `path` arg description |
| `connectorKey` | `string` | Resolved via `resolveConnector` (`api-tool-runtime.ts:73`); missing value fails only non-GET calls |
| `authHeader?` | `string` | Header name for the credential; default `"Authorization"` (`api-tool-runtime.ts:114`) |
| `authPrefix?` | `string` | Value prefix; default `"Bearer"` via `?? ` — an explicit `""` sends the raw value with no prefix (`api-tool-runtime.ts:115-116`) |
| `allowedMethods` | `string[]` | Becomes the `method` Zod enum; empty array falls back to `["GET"]` (`api-tool-runtime.ts:25-27`) |
| `defaultHeaders?` | `Record<string,string>` | Spread into headers after `User-Agent`, before the auth header (`api-tool-runtime.ts:111`) |
| `pathPrefix?` | `string` | Inserted between `baseUrl` and the per-call `path` (`api-tool-runtime.ts:84`) |

### `buildApiToolDef(name, description, config)` — `packages/backend/src/server/tools/api-tool-runtime.ts:20`
Builds a `ToolDefinition` for an HTTP API tool. Schema:

| Field | Zod type | Notes |
|---|---|---|
| `method` | `z.enum(config.allowedMethods \|\| ["GET"])` | Enum is the per-tool allowed set |
| `path` | `z.string()` | Appended to `baseUrl + pathPrefix`; leading slash recommended (added if missing in impl) |
| `body` | `z.record(z.string(), z.unknown()).optional()` | JSON body |
| `query` | `z.record(z.string(), z.string()).optional()` | Query params |

Category `network`, risk `destructive`, argument-aware `isDestructive: (args) => args.method !== "GET"` (`api-tool-runtime.ts:53`) — GETs on API tools run without approval; writes gate. No kill-switch interaction. Note `config.allowedMethods.length` is read unguarded (`api-tool-runtime.ts:25`), so a config without the field throws here — swallowed (with the rest of the loop) by `createAppRegistryWithCustomTools`'s catch.
- **Calls:** `z.object/enum/...`.
- **Called by:** `createAppRegistryWithCustomTools` (`index.ts:75`); test `api-tool-runtime.test.ts:40,48`.

### `buildApiToolImpl(toolName, config)` — `packages/backend/src/server/tools/api-tool-runtime.ts:58`
Returns a `ToolImpl` closure. Steps per call:
1. If `config.connectorKey` is set, `resolveConnector(connectorKey)`; a missing value fails the call **only when `method !== "GET"`** (`Connector "<key>" is not configured. Set it in .simple-harmonic/secrets.json or as an env var.`); GET proceeds unauthenticated.
2. URL: `baseUrl + (pathPrefix || "") + path` with a leading `/` added to `path` if absent; `query` entries set via `searchParams.set`.
3. `assertPublicAndResolve(url)` **before the secret is attached** (`api-tool-runtime.ts:98`) — failure returns `"<tool> blocked: <message>"` and the token never leaves the box (pinned in `api-tool-ssrf.test.ts`).
4. Headers: `User-Agent: simple-harmonic-agent`, then `config.defaultHeaders` spread (can override User-Agent), then the auth header (`authHeader || "Authorization"`: `authPrefix ?? "Bearer"` + space + value, or the raw value when the prefix is the empty string), plus `Content-Type: application/json` when a body is present.
5. `proxyFetch` with the IP pin, 20 s `AbortController` timeout, JSON-serialized body (`api-tool-runtime.ts:126`).
6. `readCapped(res, 128 KiB)`; `success` mirrors `res.ok`; non-2xx → `HTTP <status> <statusText>: <first 2,000 chars>`.

Action: `api_tool_called` with payload `{ tool, method, path (normalized), status, output (first 2,000 chars) }`. Throws → `"<tool> failed: <message>"`.
- **Calls:** `resolveConnector`, `assertPublicAndResolve`, `proxyFetch`, `readCapped`.
- **Called by:** `createAppRegistryWithCustomTools` (`index.ts:76`); tests `api-tool-runtime.test.ts` (many sites), `api-tool-ssrf.test.ts:27,45`.

### `readCapped(res, maxBytes)` — `packages/backend/src/server/tools/api-tool-runtime.ts:168`
Streaming body read keeping at most `maxBytes`; cancels the reader at the cap. Identical loop to `network.ts`'s `readCappedText` except it returns only the `string` (no `bytesRead` count).
- **Calls:** WHATWG stream reader API.
- **Called by:** `buildApiToolImpl` (`api-tool-runtime.ts:137`). Not exported.

### Parked: the skills-directory migration (stash@{0})

This module once carried two more layers — `buildSkillDef`/`buildSkillImpl` unifying API skills with zero-argument "instruction skills" loaded from directory `SKILL.md` files, plus `subSkills`/`instructions` on `ToolDefinition` and runner-side progressive disclosure (`ctx.openSkills`, a `close_skills` internal tool, a 16th built-in). That uncommitted migration was discarded on 2026-06-11; none of its code exists anywhere in the repo. Only untracked data survives in `git stash@{0}`: the `.simple-harmonic/skills/create-skill/` and `create_agent/` SKILL.md trees and `packages/backend/tests/unit/skill-tree.test.ts`. At HEAD there are exactly 15 built-in tools (3 internal + 12 server, `server-tools.test.ts:400`) and custom tools are flat `.simple-harmonic/skills/<name>.json` API tools.

---

## packages/backend/src/server/tools/coding/types.ts

The backend-neutral contract all coding CLI adapters implement.

### interface `CodingRunOpts` — `packages/backend/src/server/tools/coding/types.ts:9`

| Field | Type | Meaning |
|---|---|---|
| `task` | `string` | The prompt handed to the coding CLI (scope-prefixed by `codingTaskImpl`) |
| `cwd` | `string` | Working directory; re-asserted inside the jail by `runSubprocess` |
| `model?` | `string` | Model override forwarded as a CLI flag |
| `timeout?` | `number` | Milliseconds; backends default to 300,000 (5 min) |
| `signal?` | `AbortSignal` | Abort rejects the run promise |

### interface `CodingResult` — `packages/backend/src/server/tools/coding/types.ts:18`

| Field | Type | Meaning |
|---|---|---|
| `messages` | `string[]` | Assistant text outputs; the last one is the "conclusion" |
| `commands` | `Array<{ command: string; output: string; exitCode: number }>` | Tool/shell calls the coding agent made (there is no separately named `CodingCommand` type — the element shape is inline) |
| `errors` | `string[]` | Parse-level errors, timeouts, spawn failures, non-zero exits |

### interface `CodingBackend` — `packages/backend/src/server/tools/coding/types.ts:24`

| Field | Type | Meaning |
|---|---|---|
| `name` | `string` | `"codex"`, `"claude-code"`, or `"opencode"`; surfaced in error text and action payloads |
| `run` | `(opts: CodingRunOpts) => Promise<CodingResult>` | One-shot execution; resolves with partial results on timeout, rejects on abort/jail escape |

- **Used by:** `coding/index.ts` (factory map, `codingTaskImpl`), all three engine modules; re-exported from `coding/index.ts:19`.

---

## packages/backend/src/server/tools/coding/index.ts

### `BACKENDS` (private) — `packages/backend/src/server/tools/coding/index.ts:21`
`Record<string, () => CodingBackend>` mapping `codex` → `createCodexBackend`, `claude-code` → `createClaudeCodeBackend`, `opencode` → `createOpenCodeBackend`.

### `createCodingBackend(name?)` — `packages/backend/src/server/tools/coding/index.ts:27`
Resolves the backend key as `name || getConfig().codingBackend` (`packages/backend/src/server/config.ts` — config file `codingBackend` field → `SH_CODING_BACKEND` env var → default `"codex"`; invalid names already fall back to `"codex"` inside `getConfig`). Unknown key here (only possible via an explicit bad `name` argument) → **throws** `Unknown coding backend "<key>". Available: codex, claude-code, opencode`. Otherwise calls the factory and returns a fresh `CodingBackend`.
- **Calls:** `getConfig`, the matching `create*Backend` factory.
- **Called by:** `codingTaskImpl` (`coding/index.ts:120`, always argument-less). Exported but has no other src callers.

### `buildSummary(result)` (private) — `packages/backend/src/server/tools/coding/index.ts:38`
Renders a `CodingResult` into the tool's text result, joining up to three blocks with `\n\n`:
1. `Errors:\n<errors joined by \n>` when any.
2. `Commands run (<n>):` then per command `  $ <command> → exit <code>` plus up to the first 5 output lines indented 4 spaces.
3. `Agent conclusion:\n<last message sliced to 4,000 chars>` when a last message exists.

Empty everything → `"No output from coding agent."`
- **Calls:** nothing.
- **Called by:** `codingTaskImpl` (`coding/index.ts:133`). Not exported.

### tool `coding_task` — def `packages/backend/src/server/tools/coding/index.ts:95`, impl `coding/index.ts:108`
Schema (`codingTaskSchema`, `coding/index.ts:72`):

| Field | Zod type | Notes |
|---|---|---|
| `task` | `z.string()` | Specific, self-contained task description (coding/research/testing) |
| `scope` | `z.string().optional()` | File/dir focus; prefixed onto the task |
| `model` | `z.string().optional()` | Per-call model override |

Category `shell`, risk `destructive` (static), **kill-switch gated**.

Impl steps:
1. `!toolsEnabled()` → failure `"coding_task is disabled. Set SH_ENABLE_TOOLS=1 to enable destructive tools."`
2. `cfg = getConfig()`, `cwd = toolsRoot()`, `backend = createCodingBackend()` (config-selected), `backendCfg = cfg.codingConfig[cfg.codingBackend]` (per-backend `{ model?, timeout? }`).
3. If `scope`: task becomes `Focus on: <scope>\n\n<task>`.
4. `model = args.model || backendCfg?.model`; `timeout = backendCfg.timeout * 1000` when set (**config value is in seconds**; `coding/index.ts:129`), else `undefined` (backends then default to 5 min).
5. `await backend.run({ task, cwd, model, timeout })`; `summary = buildSummary(result)`.
6. Failure only when `result.errors.length > 0 && result.messages.length === 0`; any message at all makes the call a success (errors still shown in the summary).

Action (success only): `coding_task_completed` with payload `{ backend: backend.name, task (first 500 chars), scope (or null), commandsRun, conclusion (last message, first 2,000 chars) }`. A thrown error (abort, jail-escape cwd, factory throw) → failure `coding_task failed (<backend.name>): <message>`.
- **Calls:** `toolsEnabled`, `getConfig`, `toolsRoot`, `createCodingBackend`, `backend.run`, `buildSummary`.
- **Called by:** registered at `index.ts:51`; executed via `registry.execute` from `runner.ts:442`; re-exported `index.ts:93`.

---

## packages/backend/src/server/tools/coding/run-subprocess.ts

### interface `RunSubprocessOpts` — `packages/backend/src/server/tools/coding/run-subprocess.ts:17`

| Field | Type | Meaning |
|---|---|---|
| `cwd` | `string` | Re-validated through `resolveInJail` before spawn |
| `signal?` | `AbortSignal` | Abort → SIGTERM + promise rejection |
| `timeoutMs` | `number` | Hard wall clock; expiry → SIGTERM + **resolve** with partial result |
| `maxOutputBytes` | `number` | stdout retention cap (tail-keeping) |
| `envKeys` | `string[]` | Provider keys forwarded into the scrubbed child env |
| `label` | `string` | Short command label for error messages (e.g. `"claude"`) |

### `runSubprocess(cmd, argv, parseEvents, opts)` — `packages/backend/src/server/tools/coding/run-subprocess.ts:28`
Shared subprocess lifecycle for all three coding CLIs; single-sources the security posture. Behavior:
1. `resolveInJail(opts.cwd)` — a cwd outside the jail **rejects** the promise with the `JailEscapeError` (or `new Error("cwd outside jail")` for non-Error throws).
2. `spawn(cmd, argv, { cwd, stdio: ["ignore","pipe","pipe"], env: codingEnv(opts.envKeys) })` — stdin closed, env scrubbed + provider keys only.
3. **Timeout** (`opts.timeoutMs`): SIGTERM, then **resolves** with `parseEvents(stdout)` plus `errors.push("Timed out after <s>s")` — partial output is preserved, not discarded.
4. **Abort**: if already aborted or on the `abort` event — SIGTERM and **reject** with `signal.reason` (when an `Error`) or `new Error("aborted")`.
5. **stdout buffering**: appended per chunk; over `maxOutputBytes`, keeps the **tail**, cutting forward to the next `\n` so a JSONL record is never sliced mid-line (falls back to a raw tail slice if the window has no newline). **stderr**: each chunk individually truncated to 8,192 bytes before appending.
6. **Spawn error** (`child.on("error")`): **resolves** with `{ messages: [], commands: [], errors: ["Failed to spawn <label>: <message>"] }`.
7. **Exit**: resolves with `parseEvents(stdout)`; if the exit code is non-zero **and** no messages were parsed, appends `stderr` (or `"<label> exited with code <code>"`) to `errors`.

A `settled` flag makes timeout/abort/error/exit mutually exclusive.
- **Calls:** `resolveInJail`, `codingEnv`, `node:child_process.spawn`, the engine-supplied `parseEvents`.
- **Called by:** `claude-code.ts:82`, `codex.ts:81`, `opencode.ts:73`; test `packages/backend/tests/unit/run-subprocess.test.ts:49-72`.

---

## packages/backend/src/server/tools/coding/claude-code.ts

### Constants
- `DEFAULT_TIMEOUT_MS = 5 * 60_000` (300,000) — `claude-code.ts:8`.
- `MAX_OUTPUT_BYTES = 256 * 1024` — `claude-code.ts:9`.

### `parseEvents(jsonl)` (private) — `packages/backend/src/server/tools/coding/claude-code.ts:11`
Parses Claude Code `stream-json` output line by line (blank lines skipped, unparseable lines silently dropped):
- `type: "assistant"` → iterate `message.content`: `text` blocks push onto `messages`; `tool_use` blocks push `{ command: input.command || block.name, output: input.description || "", exitCode: 0 }` onto `commands` (skipped when both command and name are empty).
- `type: "result"` → push `event.result` onto `messages` if non-empty and not already present (dedupe against the final assistant text).
- `type: "error"` → push `event.message || "Unknown error"` onto `errors`.

- **Called by:** passed to `runSubprocess` at `claude-code.ts:82`. Not exported.

### `createClaudeCodeBackend()` — `packages/backend/src/server/tools/coding/claude-code.ts:63`
Returns `{ name: "claude-code", run }`. `run` builds argv `["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--no-session-persistence", ...(model ? ["--model", model] : []), task]` and delegates to `runSubprocess("claude", args, parseEvents, { cwd, signal, timeoutMs: opts.timeout || 300_000, maxOutputBytes: 256 KiB, envKeys: ["ANTHROPIC_API_KEY"], label: "claude" })`. `--dangerously-skip-permissions` is accepted because the cwd is jailed, the env is scrubbed, and `coding_task` is double-gated (kill switch + approval); `--no-session-persistence` makes every run a fresh one-shot.
- **Calls:** `runSubprocess`.
- **Called by:** `BACKENDS["claude-code"]` (`coding/index.ts:23`) via `createCodingBackend`.

---

## packages/backend/src/server/tools/coding/codex.ts

### Constants
- `DEFAULT_TIMEOUT_MS = 5 * 60_000` — `codex.ts:8`.
- `MAX_OUTPUT_BYTES = 256 * 1024` — `codex.ts:9`.

### interface `CodexEvent` (private) — `packages/backend/src/server/tools/coding/codex.ts:11`
Loose shape for a Codex JSONL event: `{ type, item?: { type, text?, status?, command?, aggregated_output?, exit_code? }, error?: { message } }`.

### `parseEvents(jsonl)` (private) — `packages/backend/src/server/tools/coding/codex.ts:24`
Per line (blank/unparseable skipped):
- `type: "item.completed"` with `item.type === "agent_message"` and non-empty `text` → `messages`.
- `type: "item.completed"` with `item.type === "tool_call"`, a `command`, and `status === "completed"` → `commands` as `{ command, output: (aggregated_output || "").slice(0, 2_000), exitCode: exit_code ?? -1 }`.
- `type: "error"` with `error.message` → `errors`.

- **Called by:** passed to `runSubprocess` at `codex.ts:81`. Not exported.

### `createCodexBackend()` — `packages/backend/src/server/tools/coding/codex.ts:62`
Returns `{ name: "codex", run }`. `run` builds argv `["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-C", opts.cwd, ...(model ? ["-m", model] : []), task]` — sandbox mode `workspace-write` keeps Codex's writes inside the jailed cwd (never `danger-full-access`); the cwd appears both as `-C` and as the spawn cwd. Delegates to `runSubprocess("codex", …, { timeoutMs: opts.timeout || 300_000, maxOutputBytes: 256 KiB, envKeys: ["CODEX_HOME", "OPENAI_API_KEY"], label: "codex" })`. Codex auth is otherwise file-based under `~/.codex` — reachable because `HOME` survives `scrubbedEnv`.
- **Calls:** `runSubprocess`.
- **Called by:** `BACKENDS["codex"]` (`coding/index.ts:22`) via `createCodingBackend` (the default backend).

---

## packages/backend/src/server/tools/coding/opencode.ts

### Constants
- `DEFAULT_TIMEOUT_MS = 5 * 60_000` — `opencode.ts:8`.
- `MAX_OUTPUT_BYTES = 256 * 1024` — `opencode.ts:9`.

### interface `OpenCodeEvent` (private) — `packages/backend/src/server/tools/coding/opencode.ts:11`
Loose event shape: `{ type, text?, content?, reason?, tool?, input?: { command? }, output?, exit_code?, message? }`.

### `parseEvents(jsonl)` (private) — `packages/backend/src/server/tools/coding/opencode.ts:23`
Per line (blank/unparseable skipped):
- `type: "text"` with `text` → `messages`.
- `type: "tool_use"` → `commands` as `{ command: input.command || tool || "", output: (output || "").slice(0, 2_000), exitCode: exit_code ?? 0 }` (skipped when the command resolves empty).
- `type: "step_finish"` with `reason === "stop"` and `content` → `messages`.
- `type: "error"` → `errors` gets `message || text || "Unknown error"`.

- **Called by:** passed to `runSubprocess` at `opencode.ts:73`. Not exported.

### `createOpenCodeBackend()` — `packages/backend/src/server/tools/coding/opencode.ts:64`
Returns `{ name: "opencode", run }`. `run` builds argv `["run", "--format", "json", "-q", "--working-dir", opts.cwd, ...(model ? ["--model", model] : []), task]` and delegates to `runSubprocess("opencode", …, { timeoutMs: opts.timeout || 300_000, maxOutputBytes: 256 KiB, envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"], label: "opencode" })`.
- **Calls:** `runSubprocess`.
- **Called by:** `BACKENDS["opencode"]` (`coding/index.ts:24`) via `createCodingBackend`.

---

## Cross-reference: emitted action types

| actionType | Emitted by |
|---|---|
| `file_read` | `read_file` (`filesystem.ts:81`) |
| `file_written` | `write_file` (`filesystem.ts:125`) |
| `command_run` | `run_command` (`shell.ts:193`) |
| `coding_task_completed` | `coding_task` (`coding/index.ts:148`) |
| `http_fetched` | `http_fetch` (`network.ts:57`) |
| `github_api_called` | `github_api` (`network.ts:162`) |
| `team_goal_set` | `set_team_goal` (`management.ts:88`) |
| `team_deleted` / `team_modified` | `modify_team` (`management.ts:183,210`) |
| `sub_team_spawned` | `spawn_sub_team` (`management.ts:279`) |
| `agent_deleted` / `agent_moved` / `agent_modified` | `modify_agent` (`management.ts:361,383,411`) |
| `app_observed` | `observe_app` (`observe.ts:78`) |
| `api_tool_called` | custom API tools (`api-tool-runtime.ts:146`) |
| (none) | `action_history` — read-only, emits no action |

---

## Python backend (FastAPI port) — symbol reference

The idiomatic Python port (`backend-py/simple_harmonic/`) mirrors the TS tool system one-for-one, with the same `(ToolDefinition, ToolImpl)` split, the same jail/SSRF/kill-switch posture, and the same 15-tool registry. Two structural differences shape the symbol mapping:

- **The TS library/server split is collapsed.** TS keeps the registry, the three internal tools, and the `ToolRunContext` shapes under `packages/backend/src/lib/meta-agent/`; the Python port folds them into the `tools/` package alongside the I/O tools (`tools/registry.py`, `tools/default_tools.py`, `tools/types.py`). The proxy fetch, connectors, and custom-tool loaders that TS puts at `packages/backend/src/server/{proxy-fetch,connectors,custom-tools}.ts` sit at the `simple_harmonic/` package root, not under `tools/`.
- **Args schemas are pydantic `BaseModel` subclasses, not Zod objects.** A `ToolDefinition.schema` is a model class; `schema_to_parameters` runs `model_json_schema()` and inlines `$defs` (the TS side hands Zod straight to the LLM SDK). The def/impl pairs are module-level values named `<tool>_def` / `<tool>_impl` (snake_case), versus TS's `<tool>Def` / `<tool>Impl`.

Naming throughout is `camelCase` → `snake_case` for functions and locals; **dataclass/payload field names stay camelCase** (e.g. `toolName`, `actionType`, `teamId`, `pinnedIp`, `exitCode`) so the JSON wire shape and action payloads match the TS store byte-for-byte. Tool *names* the LLM sees (`read_file`, `coding_task`, …) are identical across both backends.

### `backend-py/simple_harmonic/tools/registry.py`
TS source: `packages/backend/src/lib/meta-agent/registry.ts`.
- `class ToolDefinition` — `backend-py/simple_harmonic/tools/registry.py:45` — dataclass data half: `name`, `description`, `category`, `risk`, `schema` (pydantic model class), optional `is_destructive` arg-aware classifier. TS counterpart is the Zod-typed `ToolDefinition`.
- `class ToolRegistry` — `backend-py/simple_harmonic/tools/registry.py:96` — name-keyed `(definition, impl)` store.
- `ToolRegistry.register(definition, impl)` — `backend-py/simple_harmonic/tools/registry.py:102` — raises `ValueError` on a duplicate name (TS `register` throws; `registry.ts:83`).
- `ToolRegistry.has(name)` — `backend-py/simple_harmonic/tools/registry.py:111` — membership check used by custom-tool first-wins skipping.
- `ToolRegistry.get_openai_defs(allowed=None)` — `backend-py/simple_harmonic/tools/registry.py:128` — allowlist-filtered OpenAI-format tool defs; calls `schema_to_parameters` per tool.
- `ToolRegistry.list_for_agent(allowed=None)` — `backend-py/simple_harmonic/tools/registry.py:118` — definitions filtered to an agent's allowlist (unknown names ignored).
- `ToolRegistry.is_destructive(tool_name, raw_args=None)` — `backend-py/simple_harmonic/tools/registry.py:142` — approval-gate classifier; fail-safe `True` for an unknown tool or args that don't validate.
- `ToolRegistry.execute(name, raw_args, ctx)` — `backend-py/simple_harmonic/tools/registry.py:159` — `model_validate` then run impl; never raises (a `ValidationError` becomes a `success=False` `ToolExecResult`). Mirror of TS `registry.execute` (`registry.ts:147`).
- `schema_to_parameters(schema)` — `backend-py/simple_harmonic/tools/registry.py:84` — `model_json_schema()` with `$schema` stripped and `$defs` inlined (`_inline_refs`, `registry.py:68`). No direct TS analog — TS passes Zod to the SDK.

### `backend-py/simple_harmonic/tools/types.py`
TS source: `packages/backend/src/lib/meta-agent/tools.ts` + `types.ts`. These are dataclasses (not pydantic) — an in-process call frame carrying a live `a2ax` object, never serialized.
- `class ToolExecResult` — `backend-py/simple_harmonic/tools/types.py:41` — universal impl return: `toolName`, `success`, `result`, optional `action`. Fields stay camelCase.
- `class ToolResult` — `backend-py/simple_harmonic/tools/types.py:24` — `actionType` + `payload` attached on success and logged to the action feed.
- `class ToolExecContext` — `backend-py/simple_harmonic/tools/types.py:64` — `teamId`, `agentId`, `agentName`, `peers`; the public-caller context.
- `class ToolRunContext(ToolExecContext)` — `backend-py/simple_harmonic/tools/types.py:76` — adds `a2ax` (defaults `None`); what registry impls receive as `ctx`.
- `class PeerAgent` — `backend-py/simple_harmonic/tools/types.py:32` — `id`/`name`/`role`.
- `class A2AXSender(Protocol)` — `backend-py/simple_harmonic/tools/types.py:53` — `send_direct` / `broadcast` bus surface.
- `ToolImpl` — `backend-py/simple_harmonic/tools/types.py:92` — `Callable[[Any, ToolRunContext], Awaitable[ToolExecResult]]`. `OpenAIToolDef` — `types.py:87` — plain `dict[str, Any]`.

### `backend-py/simple_harmonic/tools/sandbox.py`
TS source: `packages/backend/src/server/tools/sandbox.ts`. Env is read at call time (`os.environ` / `os.getcwd()`), not via the cached `Settings`, so a test can flip `SH_TOOLS_CWD` between calls — same posture as the TS `process.env` reads.
- `tools_root()` — `backend-py/simple_harmonic/tools/sandbox.py:38` — jail root `Path(SH_TOOLS_CWD or cwd).resolve()` (TS `toolsRoot`). Returns a `pathlib.Path`, not a string.
- `tools_enabled()` — `backend-py/simple_harmonic/tools/sandbox.py:46` — destructive kill switch; true only for `SH_ENABLE_TOOLS` in `{1,true,yes}` (TS `toolsEnabled`).
- `class JailEscapeError(Exception)` — `backend-py/simple_harmonic/tools/sandbox.py:54` — same message `Path "<requested>" resolves outside the allowed working directory`; carries `.requested` (TS `JailEscapeError extends Error`).
- `resolve_in_jail(requested_path)` — `backend-py/simple_harmonic/tools/sandbox.py:71` — synchronous logical containment; rejects null byte / `..` / absolute escape (TS `resolveInJail`).
- `resolve_in_jail_real(requested_path)` — `backend-py/simple_harmonic/tools/sandbox.py:95` — **async** symlink-aware containment via `_realpath_deepest_existing` (`sandbox.py:162`); the fs tools use this (TS `resolveInJailReal`).
- `scrubbed_env()` — `backend-py/simple_harmonic/tools/sandbox.py:120` — minimal child env from the same eight-var allowlist `_SCRUB_ALLOW` (`sandbox.py:35`) (TS `scrubbedEnv`).
- `coding_env(extra_keys=None)` — `backend-py/simple_harmonic/tools/sandbox.py:132` — `scrubbed_env()` plus only uppercase-validated provider keys (`_ENV_KEY_RE`, `sandbox.py:31`) (TS `codingEnv`).

### `backend-py/simple_harmonic/tools/url_guard.py`
TS source: `packages/backend/src/server/tools/url-guard.ts`. Single SSRF egress policy.
- `assert_public_and_resolve(raw_url)` — `backend-py/simple_harmonic/tools/url_guard.py:124` — **async** (TS `assertPublicAndResolve` is sync-with-await); validates https-only, no embedded creds, no localhost, no private IP literal; resolves DNS via `_resolve_all` (`url_guard.py:113`, an overridable seam) and rejects if *any* record is private; returns a `PinnedTarget`.
- `class PinnedTarget` — `backend-py/simple_harmonic/tools/url_guard.py:96` — dataclass `url` (a `urllib.parse.SplitResult`, not a TS `URL`), `pinnedIp`, `family`, plus a `.hostname` property. TS interface `PinnedTarget` (`url-guard.ts:56`).
- `is_private_ipv4(ip)` — `backend-py/simple_harmonic/tools/url_guard.py:40` — full private/loopback/CGNAT/link-local/benchmark/reserved IPv4 set (TS `isPrivateIpv4`).
- `is_private_ipv6(ip)` — `backend-py/simple_harmonic/tools/url_guard.py:68` — `::1`/`::`/`fc`/`fd`/`fe80`/`::ffff:`-mapped (TS `isPrivateIpv6`).
- `is_private_ip(host)` — `backend-py/simple_harmonic/tools/url_guard.py:84` — IP-family dispatcher (TS `isPrivateIp`).
- `strip_ipv6_brackets(host)` — `backend-py/simple_harmonic/tools/url_guard.py:27` — `[::1]` → `::1` (TS `stripIpv6Brackets`).

### `backend-py/simple_harmonic/tools/types.py` → coding contract: `backend-py/simple_harmonic/tools/coding/types.py`
TS source: `packages/backend/src/server/tools/coding/types.ts`. Dataclasses.
- `class CodingRunOpts` — `backend-py/simple_harmonic/tools/coding/types.py:30` — `task`, `cwd`, `model?`, `timeout?` (ms). TS interface `CodingRunOpts` (`types.ts:9`); the Python port drops the `signal?` field (asyncio uses `wait_for`/cancellation instead of an `AbortSignal`).
- `class CodingResult` — `backend-py/simple_harmonic/tools/coding/types.py:39` — `messages`/`commands`/`errors` (TS `CodingResult`).
- `class CodingCommand` — `backend-py/simple_harmonic/tools/coding/types.py:21` — `command`/`output`/`exitCode`. **Named type** here, versus the TS inline element shape on `CodingResult.commands`.
- `class CodingBackend(Protocol)` — `backend-py/simple_harmonic/tools/coding/types.py:45` — `name` + async `run(opts)`. `ParseEvents`/`CodingBackendFactory` aliases at `types.py:55,52`.

### `backend-py/simple_harmonic/tools/default_tools.py`
TS source: `packages/backend/src/lib/meta-agent/default-tools.ts`. The three internal message-passing tools (`safe`, never approval-gated).
- `create_default_registry()` — `backend-py/simple_harmonic/tools/default_tools.py:96` — builds a registry pre-loaded with `send_message`, `broadcast`, `report_action` (TS `createDefaultRegistry`, `default-tools.ts:46`).
- args models `SendMessageArgs` / `BroadcastArgs` / `ReportActionArgs` — `default_tools.py:20,27,31`; impls `_send_message` / `_broadcast` / `_report_action` — `default_tools.py:44,69,83` (read `ctx.a2ax`).

### `backend-py/simple_harmonic/tools/filesystem.py`
TS source: `packages/backend/src/server/tools/filesystem.ts`. Constants `MAX_READ_BYTES` / `UI_SNIPPET_BYTES` — `filesystem.py:28,29` (262,144 / 2,000).
- `read_file_def` — `backend-py/simple_harmonic/tools/filesystem.py:47` / `read_file_impl(args, _ctx)` — `filesystem.py:95` — symlink-jailed read; sensitive-path deny (`_is_sensitive_path`, `filesystem.py:77`), `MAX_READ_BYTES` cap, emits `file_read`. TS `readFileDef`/`readFileImpl`.
- `write_file_def` — `backend-py/simple_harmonic/tools/filesystem.py:141` / `write_file_impl(args, _ctx)` — `filesystem.py:154` — kill-switch-gated overwrite; no sensitive-path check; emits `file_written`. TS `writeFileDef`/`writeFileImpl`.
- `_err_to_message(tool, path, err)` — `backend-py/simple_harmonic/tools/filesystem.py:65` — maps `JailEscapeError`/`FileNotFoundError`/`PermissionError`/`IsADirectoryError` to friendly strings (TS `errToMessage`; the TS errno checks become Python exception-type `isinstance` checks).

### `backend-py/simple_harmonic/tools/shell.py`
TS source: `packages/backend/src/server/tools/shell.ts`. Constants `TIMEOUT_S = 30.0` / `MAX_OUTPUT_BYTES` — `shell.py:29,30`; allowlists `ALLOWED_PROGRAMS` / `ALLOWED_GIT_SUBCOMMANDS` — `shell.py:34,45` (`frozenset`, same 23-program / 23-subcommand sets as the TS `Set`s).
- `run_command_def` — `backend-py/simple_harmonic/tools/shell.py:69` / `run_command_impl(args, _ctx)` — `shell.py:94` — kill-switch-gated; argv via `asyncio.create_subprocess_exec` (no shell), cwd pinned to `tools_root()`, scrubbed env, 30 s timeout, 64 KiB cap; emits `command_run`. TS `runCommandDef`/`runCommandImpl` (which used `child_process.execFile`).
- `_is_escaping_arg(arg)` — `backend-py/simple_harmonic/tools/shell.py:84` — rejects null byte, absolute/`~`/`..` paths, and git `--git-dir=`/`--work-tree=`/`--output=`/`--exec-path=` (TS `isEscapingArg`).

### `backend-py/simple_harmonic/tools/network.py`
TS source: `packages/backend/src/server/tools/network.ts`. Constant `MAX_BODY_BYTES` — `network.py:29`. `read_capped` lives in `proxy_fetch.py` here (see below), not duplicated locally as in TS.
- `http_fetch_def` — `backend-py/simple_harmonic/tools/network.py:49` / `http_fetch_impl(args, _ctx)` — `network.py:62` — `safe`, GET-only; `assert_public_and_resolve` → `proxy_fetch(pin=…)` → `read_capped`; emits `http_fetched`. TS `httpFetchDef`/`httpFetchImpl`. The Zod `.url()` becomes a pydantic `field_validator` (`network.py:40`).
- `github_api_def` — `backend-py/simple_harmonic/tools/network.py:109` / `github_api_impl(args, _ctx)` — `network.py:123` — arg-aware `is_destructive=lambda args: args.method != "GET"` (`network.py:118`); write requires `tools_enabled()` **and** a `GITHUB_TOKEN`; SSRF guard runs before the bearer token is attached; emits `github_api_called`. TS `githubApiDef`/`githubApiImpl`.

### `backend-py/simple_harmonic/tools/management.py`
TS source: `packages/backend/src/server/tools/management.ts`. Four store-mutating `internal`/`destructive` tools over the `teams`/`agents` repos. The TS helpers are **async** here (the file store is async).
- `_assert_in_sub_tree(caller_team_id, target_team_id, target_label)` — `backend-py/simple_harmonic/tools/management.py:31` — sub-tree scope check via `get_sub_tree_ids`; returns an error string or `None` (TS `assertInSubTree`).
- `_resolve_team_id(team_name, fallback)` — `backend-py/simple_harmonic/tools/management.py:43` — name→id over `teams.all()`, returns `(team_id, error)` (TS `resolveTeamId`).
- `set_team_goal_def` / `set_team_goal_impl` — `backend-py/simple_harmonic/tools/management.py:67,79` — emits `team_goal_set`.
- `modify_team_def` / `modify_team_impl` — `backend-py/simple_harmonic/tools/management.py:126,139` — update/delete; delete refuses own team and counts the sub-tree via `get_sub_tree_ids` + `agents.byTeams`; emits `team_deleted` / `team_modified`. Nested args model `ModifyTeamUpdates` (`management.py:110`).
- `spawn_sub_team_def` / `spawn_sub_team_impl` — `backend-py/simple_harmonic/tools/management.py:237,249` — `teams.insert(NewTeam(...))` + `agents.insertMany` with a 2 s-per-index `nextRunAt` stagger; emits `sub_team_spawned`. Args models `SpawnSubTeamArgs`/`SpawnSubTeamAgent` (`management.py:230,221`).
- `modify_agent_def` / `modify_agent_impl` — `backend-py/simple_harmonic/tools/management.py:332,346` — update/delete/move with the self-deletion guard (`management.py:372`); snake_case→row mapping (`initial_prompt`→`initialPrompt`, `schedule_seconds`→`scheduleSeconds`, `output_contract`→`outputContract`); emits `agent_deleted`/`agent_moved`/`agent_modified`. Args models `ModifyAgentArgs`/`ModifyAgentUpdates` (`management.py:312,297`).

### `backend-py/simple_harmonic/tools/action_history.py`
TS source: `packages/backend/src/server/tools/action-history.ts`.
- `action_history_def` — `backend-py/simple_harmonic/tools/action_history.py:51` / `action_history_impl(args, ctx)` — `action_history.py:79` — `internal`/`safe`, read-only (no action emitted); resolves `self`/`agent`/`team` scope, over-fetches `limit*2` via `actionLog.byAgents`, applies `validation_only`, renders `[HH:MM:SS] <agent> · <type>: <summary>` ± `[PASS]`/`[FAIL: …]`. TS `actionHistoryDef`/`actionHistoryImpl`.
- `_summarize(action_type, payload)` — `backend-py/simple_harmonic/tools/action_history.py:66` — `summary`→`conclusion`→`message`→`tool(args)`→raw-JSON preference, 120-char cap (TS `summarize`).

### `backend-py/simple_harmonic/tools/observe.py`
TS source: `packages/backend/src/server/tools/observe.ts` (+ `queryAppEvents`/`formatEventsForPrompt` from `app-events.ts`). The two helpers are ported into this module rather than into the slice-4 `events` module (which must stay store-decoupled).
- `observe_app_def` — `backend-py/simple_harmonic/tools/observe.py:110` / `observe_app_impl(args, ctx)` — `observe.py:124` — `internal`/`safe`; clamps `hours`≤24 / `limit`≤50, queries with `include_infra=False` hard-coded; emits `app_observed`. TS `observeAppDef`/`observeAppImpl`.
- `query_app_events(...)` — `backend-py/simple_harmonic/tools/observe.py:33` — keyword-only wrapper over `appEvents.query` (TS `queryAppEvents`, `app-events.ts:223`).
- `format_events_for_prompt(events)` — `backend-py/simple_harmonic/tools/observe.py:58` — filters infra, summarizes >24 h tool events, one line per event (TS `formatEventsForPrompt`, `app-events.ts:271`).

### `backend-py/simple_harmonic/tools/api_tool_runtime.py`
TS source: `packages/backend/src/server/tools/api-tool-runtime.ts`. Turns a `CustomToolFile` into a registry pair. Constant `MAX_BODY_BYTES` — `api_tool_runtime.py:30`.
- `build_api_tool_def(name, description, config)` — `backend-py/simple_harmonic/tools/api_tool_runtime.py:62` — builds the `ToolDefinition` with an arg-aware `is_destructive` (`api_tool_runtime.py:68`); the args model is built dynamically by `_build_args_model` (`api_tool_runtime.py:33`) via pydantic `create_model`, with `method` a `Literal` over `config.allowedMethods` (TS `buildApiToolDef`, which built a Zod enum).
- `build_api_tool_impl(tool_name, config)` — `backend-py/simple_harmonic/tools/api_tool_runtime.py:73` — returns the `impl` closure: connector resolve (missing fails only non-GET), URL build, `assert_public_and_resolve` **before** the auth header is attached, `proxy_fetch` with the IP pin, `read_capped`; emits `api_tool_called`. TS `buildApiToolImpl`. Consumes `ApiToolConfig` (imported from `store.types`, `api_tool_runtime.py:25`).

### `backend-py/simple_harmonic/tools/index.py`
TS source: `packages/backend/src/server/tools/index.ts`. Assembly point. No `JailEscapeError`/sandbox re-exports here (Python importers pull those from `tools.sandbox` directly).
- `create_app_registry()` — `backend-py/simple_harmonic/tools/index.py:48` — `create_default_registry()` + the 12 server tools in the exact TS registration order (`index.py:52-63`); duplicate name → `register` raises. Returns the 15-tool registry. TS `createAppRegistry` (`index.ts:45`).
- `create_app_registry_with_custom_tools()` — `backend-py/simple_harmonic/tools/index.py:68` — adds file-defined custom tools via `list_custom_tool_files` + `build_api_tool_def`/`build_api_tool_impl`, first-wins skip on `registry.has`, whole loop wrapped in one `try/except Exception: pass`. TS `createAppRegistryWithCustomTools` (`index.ts:68`).

### `backend-py/simple_harmonic/tools/coding/index.py`
TS source: `packages/backend/src/server/tools/coding/index.ts`. Re-exported from `tools/coding/__init__.py`.
- `coding_task_def` — `backend-py/simple_harmonic/tools/coding/index.py:97` / `coding_task_impl(args, _ctx)` — `coding/index.py:112` — `shell`/`destructive`, kill-switch-gated; selects the config backend, scope-prefixes the task, converts the per-backend `timeout` seconds→ms, runs `backend.run`, summarizes; failure only when `errors and not messages`; emits `coding_task_completed`. TS `codingTaskDef`/`codingTaskImpl`.
- `create_coding_backend(name=None)` — `backend-py/simple_harmonic/tools/coding/index.py:37` — resolves `name or get_config().codingBackend` against `BACKENDS`; unknown key raises `ValueError` (TS `createCodingBackend`).
- `BACKENDS` — `backend-py/simple_harmonic/tools/coding/index.py:30` — `{codex, claude-code, opencode}` → factory map (TS `BACKENDS`, private there; re-exported in the Python `__init__`).
- `build_summary(result)` — `backend-py/simple_harmonic/tools/coding/index.py:49` — renders errors / commands / conclusion blocks, `"No output from coding agent."` fallback (TS `buildSummary`).

### `backend-py/simple_harmonic/tools/coding/run_subprocess.py`
TS source: `packages/backend/src/server/tools/coding/run-subprocess.ts`. Constant `STDERR_CAP = 8_192` — `run_subprocess.py:25`.
- `run_subprocess(cmd, argv, parse_events, *, cwd, timeout_ms, max_output_bytes, env_keys, label)` — `backend-py/simple_harmonic/tools/coding/run_subprocess.py:28` — shared coding-CLI lifecycle: re-asserts cwd via `resolve_in_jail`, spawns with `asyncio.create_subprocess_exec` (stdin DEVNULL, scrubbed `coding_env`), line-boundary-trimmed stdout cap, timeout → kill + **partial** result + `"Timed out after Ns"`, spawn failure → result with `errors`, non-zero exit with no messages → append stderr. The TS `signal?`/abort path is absent (no `AbortSignal`). TS `runSubprocess`.

### `backend-py/simple_harmonic/tools/coding/{claude_code,codex,opencode}.py`
TS source: `coding/claude-code.ts`, `codex.ts`, `opencode.ts`. Each has `DEFAULT_TIMEOUT_MS = 300_000` and `MAX_OUTPUT_BYTES = 256 KiB` at lines 14/15, a module-level `parse_events(jsonl)`, a `_…Backend` dataclass with an async `run`, and a `create_…_backend()` factory.
- `create_claude_code_backend()` — `backend-py/simple_harmonic/tools/coding/claude_code.py:103` / `parse_events` — `claude_code.py:18` — argv `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --no-session-persistence`, `env_keys=["ANTHROPIC_API_KEY"]` (TS `createClaudeCodeBackend`). The `_ClaudeCodeBackend.run` dataclass method (`claude_code.py:74`) replaces the TS `{ name, run }` object literal.
- `create_codex_backend()` — `backend-py/simple_harmonic/tools/coding/codex.py:90` / `parse_events` — `codex.py:18` — argv `codex exec --json --skip-git-repo-check -s workspace-write -C <cwd>`, `env_keys=["CODEX_HOME","OPENAI_API_KEY"]` (TS `createCodexBackend`; the default backend). Parses `item.completed` agent_message / tool_call events; the TS `CodexEvent` interface has no Python equivalent (events stay plain dicts).
- `create_opencode_backend()` — `backend-py/simple_harmonic/tools/coding/opencode.py:81` / `parse_events` — `opencode.py:18` — argv `opencode run --format json -q --working-dir <cwd>`, `env_keys=["ANTHROPIC_API_KEY","OPENAI_API_KEY"]` (TS `createOpenCodeBackend`).

### `backend-py/simple_harmonic/proxy_fetch.py`
TS source: `packages/backend/src/server/proxy-fetch.ts` (package root, not under `tools/`). Built on `httpx` (the TS side used `undici`). Constants `FETCH_TIMEOUT_S = 20.0` / `DEFAULT_READ_CAP` — `proxy_fetch.py:35,36`.
- `proxy_fetch(url, *, method, headers, body, pin)` — `backend-py/simple_harmonic/proxy_fetch.py:233` — proxy-aware, IPv4-pinned fetch; returns a **streaming** `httpx.Response` (body not yet read) with the client stashed on `_pinned_client` for teardown (TS `proxyFetch`, `proxy-fetch.ts:130`).
- `read_capped(response, max_bytes=DEFAULT_READ_CAP)` — `backend-py/simple_harmonic/proxy_fetch.py:274` — streams up to `max_bytes`, stops early at the cap, always closes the response + client. This is the single shared cap the TS code duplicated as `readCappedText` (`network.ts`) and `readCapped` (`api-tool-runtime.ts`).
- `build_plan(url, *, method, headers, body, pin)` — `backend-py/simple_harmonic/proxy_fetch.py:116` — pure proxy-decision + pin function the tests assert on; drops the pin when a proxy is configured. `class PinnedAddress` — `proxy_fetch.py:40` (`ip`/`family`); `class ProxyFetchPlan` — `proxy_fetch.py:48`; `class _PinnedTransport(httpx.AsyncHTTPTransport)` — `proxy_fetch.py:157` — dials the pinned IP while preserving the real hostname for TLS SNI/cert (the Python equivalent of the TS `pinnedLookup`).

### `backend-py/simple_harmonic/connectors.py`
TS source: `packages/backend/src/server/connectors.ts` (package root). `.simple-harmonic/connectors/<KEY>.json` metadata + `secrets.json`/env value resolution.
- `resolve_connector(key)` — `backend-py/simple_harmonic/connectors.py:59` — `secrets.json` first, then `os.environ`, else `None`. Imported by `network.py`/`api_tool_runtime.py` for auth (TS `resolveConnector`, `connectors.ts:53`).
- `list_connector_metas()` — `backend-py/simple_harmonic/connectors.py:67` / `save_connector(meta, secret_value=None)` — `connectors.py:94` / `delete_connector_by_key(key)` — `connectors.py:110`; `class ConnectorMeta(BaseModel)` — `connectors.py:32`.

### `backend-py/simple_harmonic/custom_tools.py`
TS source: `packages/backend/src/server/custom-tools.ts` (package root). Loads flat `.simple-harmonic/skills/<name>.json` API-tool templates.
- `list_custom_tool_files()` — `backend-py/simple_harmonic/custom_tools.py:47` — reads/validates every skill file, skipping missing-name / missing-`config.baseUrl` / malformed JSON; consumed by `create_app_registry_with_custom_tools` (TS `listCustomToolFiles`, `custom-tools.ts:39`).
- `class CustomToolFile(BaseModel)` — `backend-py/simple_harmonic/custom_tools.py:37` — `name`/`description`/`config: ApiToolConfig` (TS `CustomToolFile`, `custom-tools.ts:29`).
- `save_custom_tool_file(tool)` — `backend-py/simple_harmonic/custom_tools.py:80` / `delete_custom_tool_file(name)` — `custom_tools.py:90` — write/delete with `assert_valid_tool_name` traversal guard.
