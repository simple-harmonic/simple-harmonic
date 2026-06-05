// ---------------------------------------------------------------------------
// Input validators for identifiers that get interpolated into filesystem paths
// (connector keys -> .simple-harmonic/connectors/<KEY>.json, skill names ->
// .simple-harmonic/skills/<name>.json). Without these, a key like
// "../../secrets" escapes the intended directory. Reused at the API route
// boundary AND inside the path-building lib functions (defense in depth).
// ---------------------------------------------------------------------------

/** Connector keys are env-var-style, e.g. GITHUB_TOKEN, SLACK_BOT_TOKEN. */
export const CONNECTOR_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** Skill/tool names are lowercase-ish identifiers, e.g. slack_api, my-tool. */
export const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function isValidConnectorKey(key: unknown): key is string {
  return typeof key === "string" && CONNECTOR_KEY_RE.test(key);
}

export function isValidToolName(name: unknown): name is string {
  return typeof name === "string" && TOOL_NAME_RE.test(name);
}

export function assertValidConnectorKey(key: unknown): asserts key is string {
  if (!isValidConnectorKey(key)) {
    throw new Error(
      `invalid connector key: ${JSON.stringify(key)} (must match ${CONNECTOR_KEY_RE})`,
    );
  }
}

export function assertValidToolName(name: unknown): asserts name is string {
  if (!isValidToolName(name)) {
    throw new Error(
      `invalid tool name: ${JSON.stringify(name)} (must match ${TOOL_NAME_RE})`,
    );
  }
}
