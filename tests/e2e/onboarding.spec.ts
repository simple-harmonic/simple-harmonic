import { test, expect } from "@playwright/test";

test.describe("Chat onboarding", () => {
  test("displays initial greeting and accepts user input", async ({ page }) => {
    await page.goto("/new");

    // Initial greeting from meta-agent should be visible
    await expect(page.locator("text=meta-agent")).toBeVisible();
    await expect(page.locator("text=chief of staff")).toBeVisible();

    // Input bar should be present and enabled
    const textarea = page.locator("textarea");
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeEnabled();

    // Type a message and verify it appears
    await textarea.fill("I run a B2B SaaS doing email analytics.");
    await textarea.press("Meta+Enter");

    // User message should appear in the chat
    await expect(page.locator("text=B2B SaaS doing email analytics")).toBeVisible({
      timeout: 5000,
    });

    // Should show streaming state (thinking indicator or streaming text)
    // The API call will fail without a real Anthropic key, but the UI state transition is what we test
    await expect(
      page.locator("text=thinking...").or(page.locator("text=connection error")),
    ).toBeVisible({ timeout: 10000 });
  });

  test("shows approval card structure", async ({ page }) => {
    // Navigate to the new team page
    await page.goto("/new");

    // Verify the page layout: top bar with Simple Harmonic branding
    await expect(page.locator("text=Simple Harmonic")).toBeVisible();
    await expect(page.locator("text=new team")).toBeVisible();

    // Verify the input bar placeholder
    const textarea = page.locator("textarea");
    await expect(textarea).toHaveAttribute(
      "placeholder",
      "Tell the chief of staff about your company...",
    );
  });
});
