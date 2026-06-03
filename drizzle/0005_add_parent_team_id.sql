-- Add parent_team_id to teams for recursive team hierarchy

ALTER TABLE "teams" ADD COLUMN "parent_team_id" uuid REFERENCES "teams"("id");
CREATE INDEX "teams_parent_idx" ON "teams" ("parent_team_id");
