import { expect, test } from "@playwright/test";
import { descend, login, openWorkspace } from "./helpers";
import { WORKSPACE_A, WORKSPACE_B } from "./fixtures";

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

test.describe("file listing", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("list view renders sizes that match the seeded bytes", async ({
    page,
  }) => {
    await openWorkspace(page, WORKSPACE_A.label);

    // Mantine SegmentedControl hides the real <input type="radio">; click the
    // visible label inside the radiogroup instead.
    const toggle = page.getByRole("radiogroup");
    await toggle.getByText("List", { exact: true }).click();
    const table = page.getByTestId("file-table");
    await expect(table).toBeVisible();

    // README.md is seeded at exactly 200 bytes.
    const readme = table.getByRole("row").filter({ hasText: "README.md" });
    await expect(readme).toContainText(humanSize(200));

    // Descend into the deep folder; both chapter files have deterministic sizes.
    await toggle.getByText("Grid", { exact: true }).click();
    await descend(page, WORKSPACE_A.deepFolder);
    await toggle.getByText("List", { exact: true }).click();

    for (const f of WORKSPACE_A.deepFiles) {
      const row = table.getByRole("row").filter({ hasText: f.name });
      await expect(row).toContainText(humanSize(f.size));
    }
  });

  test("search filters the current folder", async ({ page }) => {
    await openWorkspace(page, WORKSPACE_B.label);
    await expect(
      page.getByTestId("file-grid").getByText("notes.txt", { exact: true }),
    ).toBeVisible();

    await page.getByTestId("file-search").fill("zero");
    await expect(
      page.getByTestId("file-grid").getByText("zero.txt", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("file-grid").getByText("notes.txt", { exact: true }),
    ).toHaveCount(0);

    await page.getByTestId("file-search").fill("");
    await expect(
      page.getByTestId("file-grid").getByText("notes.txt", { exact: true }),
    ).toBeVisible();
  });

  test("empty folders render the empty state", async ({ page }) => {
    await openWorkspace(page, WORKSPACE_B.label);
    // The seeded tree has no empty folder, so create one on the fly and
    // verify the empty state renders for it.
    await page
      .getByTestId("file-grid")
      .getByText("projects", { exact: true })
      .click();
    await page.getByTestId("mkdir-submit").click();

    // Scope to the modal so we don't end up typing into the search box.
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("Folder name").fill("scratch-empty");
    await dialog.getByRole("button", { name: "Create" }).click();

    await page
      .getByTestId("file-grid")
      .getByText("scratch-empty", { exact: true })
      .click();
    await expect(page.getByText("This folder is empty")).toBeVisible();
  });
});
