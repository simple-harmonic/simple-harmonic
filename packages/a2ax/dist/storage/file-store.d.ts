export declare function readJson<T>(path: string, fallback: T): T;
export declare function writeJson(path: string, value: unknown): void;
export declare function readJsonl<T>(path: string): T[];
export declare function appendJsonl(path: string, row: unknown): void;
export declare function rewriteJsonl(path: string, rows: unknown[]): void;
/**
 * Walk the recursive team tree under `teamsRoot` and return teamId → its
 * messages/ directory. A folder is a team if it contains team.json; its
 * children live in its teams/ subfolder.
 */
export declare function discoverTeamMessageDirs(teamsRoot: string): Map<string, string>;
//# sourceMappingURL=file-store.d.ts.map