// ---------------------------------------------------------------------------
// Minimal synchronous file helpers for the JSON-file transport.
//
// Self-contained (the a2ax package must not depend on the backend store). Mirrors
// the backend's fs primitives: atomic JSON writes (temp + rename), JSONL append
// logs, and a recursive walk that locates team folders by the team.json marker.
// ---------------------------------------------------------------------------
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import { dirname, join } from "node:path";
function ensureDir(filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
}
export function readJson(path, fallback) {
    let raw;
    try {
        raw = readFileSync(path, "utf-8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return fallback;
        throw err;
    }
    return raw.trim() === "" ? fallback : JSON.parse(raw);
}
export function writeJson(path, value) {
    ensureDir(path);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, path);
}
export function readJsonl(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf-8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return [];
        throw err;
    }
    const out = [];
    for (const line of raw.split("\n")) {
        if (line.trim() === "")
            continue;
        out.push(JSON.parse(line));
    }
    return out;
}
export function appendJsonl(path, row) {
    ensureDir(path);
    appendFileSync(path, `${JSON.stringify(row)}\n`);
}
export function rewriteJsonl(path, rows) {
    ensureDir(path);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, rows.length === 0 ? "" : `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    renameSync(tmp, path);
}
function listSubdirs(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return [];
        throw err;
    }
}
/**
 * Walk the recursive team tree under `teamsRoot` and return teamId → its
 * messages/ directory. A folder is a team if it contains team.json; its
 * children live in its teams/ subfolder.
 */
export function discoverTeamMessageDirs(teamsRoot) {
    const out = new Map();
    const walk = (container) => {
        for (const teamId of listSubdirs(container)) {
            const teamDir = join(container, teamId);
            if (!existsSync(join(teamDir, "team.json")))
                continue;
            out.set(teamId, join(teamDir, "messages"));
            walk(join(teamDir, "teams"));
        }
    };
    walk(teamsRoot);
    return out;
}
//# sourceMappingURL=file-store.js.map