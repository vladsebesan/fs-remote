import { expect, test } from "@playwright/test";
import { login } from "./helpers";
import { ALL_WORKSPACES } from "./fixtures";

test.describe("auth", () => {
  test("signs in with admin/admin and lands on a workspace", async ({
    page,
  }) => {
    await login(page);
    // Sidebar shows every configured root.
    const sidebar = page.getByTestId("file-tree-sidebar");
    for (const w of ALL_WORKSPACES) {
      await expect(sidebar).toContainText(w.label);
    }
    // Header shows a breadcrumb for one of the workspaces (the first root).
    await expect(page.getByTestId("cwd")).toContainText(
      ALL_WORKSPACES[0].label,
    );
  });

  test("rejects bad password", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("login-user").fill("admin");
    await page.getByTestId("login-pass").fill("not-the-password");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("error")).toBeVisible();
    // Login form is still showing: we didn't transition to the app.
    await expect(page.getByTestId("login-form")).toBeVisible();
  });
});
