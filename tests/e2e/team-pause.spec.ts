import { expect, test } from "@playwright/test";

// Floor item 2 (E2E honesty): the previous tests asserted nothing meaningful
// (one ended on a bare waitForTimeout; the other only checked the wordmark while
// its name promised a pause button + sidebar). They are rewritten below.
//
// A full pause/resume assertion needs a seeded team, which requires a database
// AND team creation via /api/spawn (an LLM planner call). That test is included
// as test.skip with the real data-testid selectors as its contract; enable it
// once a test database + a seeding path (direct DB insert, or a mocked-planner
// spawn) are wired in CI. The runnable test asserts only what is true with no DB.

test.describe("Team route", () => {
  test("shows the loading state for an unknown team id", async ({ page }) => {
    await page.goto("/f/00000000-0000-0000-0000-000000000000");
    // With no matching team row, the view stays in its loading state and never
    // crashes. This is the truthful, DB-free assertion.
    await expect(page.getByText(/loading team/i)).toBeVisible({ timeout: 5000 });
  });

  // CONTRACT (enable when a team can be seeded against a test DB):
  // Drives the real pause/resume flow through the live controls. The selectors
  // below (data-testid="pause-toggle" / "paused-indicator" on team-view.tsx, and
  // "narration-feed" on the inline TeamDashboard feed) are now present in the app.
  test.skip("pauses and resumes a seeded team", async ({ page }) => {
    // 1. Seed a team and open it. Replace this with your test-DB seeding path:
    //    e.g. a direct insert into `teams`, or POST /api/spawn with a stubbed
    //    planner. Capture the new team id.
    const seededTeamId = "REPLACE_WITH_SEEDED_TEAM_ID";
    await page.goto(`/f/${seededTeamId}`);

    // 2. Live feed renders and the team starts running (label = "Pause Team").
    await expect(page.getByTestId("narration-feed")).toBeVisible();
    const toggle = page.getByTestId("pause-toggle");
    await expect(toggle).toHaveText(/pause team/i);

    // 3. Pause: the paused indicator appears and the label flips to "Resume".
    await toggle.click();
    await expect(page.getByTestId("paused-indicator")).toBeVisible();
    await expect(toggle).toHaveText(/resume/i);

    // 4. Resume: indicator clears and the label returns to "Pause Team".
    await toggle.click();
    await expect(page.getByTestId("paused-indicator")).toHaveCount(0);
    await expect(toggle).toHaveText(/pause team/i);
  });
});
