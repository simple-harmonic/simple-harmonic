// The AI Cofounder participates in agent messaging using a fixed sentinel UUID
// so it can send/receive direct messages and tasks like any other agent.
// All-zeros except the "c0f0" tail for easy recognition in logs.
export const COFOUNDER_AGENT_ID = "00000000-0000-0000-0000-00000000c0f0";
// Default cofounder display name. Each team can override via teams.cofounderName.
export const DEFAULT_COFOUNDER_NAME = "Harmon";

// Human users participate as first-class identities so they can DM agents
// (steer), wake them, or pause them mid-flight. A team can have multiple
// humans in the loop in the future; for v0.0 we ship with one primary user.
// "fffe" tail = the primary "You" identity.
export const PRIMARY_USER_AGENT_ID = "00000000-0000-0000-0000-00000000fffe";
export const PRIMARY_USER_DISPLAY_NAME = "You";

// Back-compat aliases (legacy single-user API surface).
export const USER_AGENT_ID = PRIMARY_USER_AGENT_ID;
export const USER_DISPLAY_NAME = PRIMARY_USER_DISPLAY_NAME;

// POV sentinels used by the messaging view. The APIs translate these to
// the real UUIDs before querying.
export const COFOUNDER_POV = "cofounder";
export const USER_POV = "user";

export interface HumanParticipant {
  id: string;
  name: string;
}

// Returns the list of humans associated with a team. For v0.0 this is a fixed
// singleton; the structure is here so the dropdown and APIs can grow into
// multi-human teams without further refactoring.
export function getTeamHumans(_teamId: string): HumanParticipant[] {
  return [{ id: PRIMARY_USER_AGENT_ID, name: PRIMARY_USER_DISPLAY_NAME }];
}

export function resolveCofounderName(teamCofounderName: string | null | undefined): string {
  return teamCofounderName?.trim() || DEFAULT_COFOUNDER_NAME;
}
