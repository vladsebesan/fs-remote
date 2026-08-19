import { expect, test } from "@playwright/test";
import { card, descend, login, openWorkspace } from "./helpers";
import { ALL_WORKSPACES, WORKSPACE_A, WORKSPACE_B } from "./fixtures";

test.describe("navigation", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  for (const w of ALL_WORKSPACES) {
    test(`shows the top-level layout of ${w.label}`, async ({ page }) => {
      await openWorkspace(page, w.label);
      const grid = page.getByTestId("file-grid");
      await expect(grid).toBeVisible();
      for (const entry of w.topLevel) {
        await expect(card(page, entry.name)).toBeVisible();
      }
    });

    test(`drills into the deeply nested folder of ${w.label}`, async ({
      page,
    }) => {
      await openWorkspace(page, w.label);
      await descend(page, w.deepFolder);

      // Breadcrumb reflects the full path.
      const crumbs = page.getByTestId("cwd");
      await expect(crumbs).toContainText(w.label);
      for (const seg of w.deepFolder) {
        await expect(crumbs).toContainText(seg);
      }

      // Every expected deep file is visible in the grid.
      for (const f of w.deepFiles) {
        await expect(card(page, f.name)).toBeVisible();
      }
    });
  }

  test("list view lets us switch workspaces via the sidebar", async ({
    page,
  }) => {
    await openWorkspace(page, WORKSPACE_A.label);
    await expect(card(page, "docs")).toBeVisible();

    await openWorkspace(page, WORKSPACE_B.label);
    await expect(card(page, "projects")).toBeVisible();
    // No cross-workspace leakage.
    await expect(card(page, "docs")).toHaveCount(0);
  });

  test("breadcrumb jumps back to the workspace root", async ({ page }) => {
    await openWorkspace(page, WORKSPACE_A.label);
    await descend(page, WORKSPACE_A.deepFolder);

    await page.getByTestId("cwd").getByText(WORKSPACE_A.label).click();

    // Back at the root: top-level entries visible, deep files are not.
    for (const entry of WORKSPACE_A.topLevel) {
      await expect(card(page, entry.name)).toBeVisible();
    }
    for (const f of WORKSPACE_A.deepFiles) {
      await expect(card(page, f.name)).toHaveCount(0);
    }
  });
});
