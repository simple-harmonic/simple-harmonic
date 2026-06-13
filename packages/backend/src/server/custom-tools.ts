// ---------------------------------------------------------------------------
// Custom tool loading: flat files in .simple-harmonic/skills/.
//
// Each JSON file defines an API tool template. The tick loop reads these
// files and registers them into the tool registry. Agents discover them
// by reading the files with read_file.
//
// File format (.simple-harmonic/skills/<name>.json):
// {
//   "name": "slack_api",
//   "description": "Slack Web API",
//   "config": {
//     "baseUrl": "https://slack.com/api",
//     "connectorKey": "SLACK_TOKEN",
//     "allowedMethods": ["GET", "POST"],
//     "authPrefix": "Bearer"
//   }
// }
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { toolsRoot } from "./tools/sandbox";
import { assertValidToolName } from "./validation";
import type { ApiToolConfig } from "./store/types";

const DIR = ".simple-harmonic/skills";

export interface CustomToolFile {
  name: string;
  description: string;
  config: ApiToolConfig;
}

function skillsDir(): string {
  return join(toolsRoot(), DIR);
}

export function listCustomToolFiles(): CustomToolFile[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const tools: CustomToolFile[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      if (!raw.name || !raw.config?.baseUrl) continue;
      tools.push({
        name: raw.name,
        description: raw.description || "",
        config: raw.config,
      });
    } catch {
      // skip malformed files
    }
  }
  return tools;
}

export function saveCustomToolFile(tool: CustomToolFile): void {
  assertValidToolName(tool.name);
  const dir = skillsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${tool.name}.json`),
    JSON.stringify(tool, null, 2) + "\n",
  );
}

export function deleteCustomToolFile(name: string): boolean {
  assertValidToolName(name);
  const file = join(skillsDir(), `${name}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
