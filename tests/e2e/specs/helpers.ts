import { expect, type Page } from "@playwright/test";

export const DEFAULT_USER = "admin";
export const DEFAULT_PASS = "admin";

export async function login(
  page: Page,
  user: string = DEFAULT_USER,
  pass: string = DEFAULT_PASS,
) {
  await page.goto("/");
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.getByTestId("login-user").fill(user);
  await page.getByTestId("login-pass").fill(pass);
  await Promise.all([
    // Wait until the main grid renders, meaning login succeeded and the
    // first directory listing has loaded.
    page.getByTestId("file-grid").waitFor({ state: "visible" }),
    page.getByTestId("login-submit").click(),
  ]);
}

// Click through the sidebar tree into a workspace by its label, then descend
// through the given folder names by double-clicking cards in the main grid.
export async function openWorkspace(page: Page, label: string) {
  const sidebar = page.getByTestId("file-tree-sidebar");
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole("button", { name: label }).click();
  // Breadcrumb should reflect the workspace label.
  await expect(page.getByTestId("cwd")).toContainText(label);
}

// In the main grid, locate a card (file or folder) by exact name.
export function card(page: Page, name: string) {
  return page.getByTestId("file-grid").getByText(name, { exact: true });
}

// Enter a folder from the main grid.
export async function enterFolder(page: Page, name: string) {
  await card(page, name).click();
  await expect(page.getByTestId("cwd")).toContainText(name);
}

// Walk through a series of folder names, verifying each transition.
export async function descend(page: Page, segments: string[]) {
  for (const seg of segments) {
    await enterFolder(page, seg);
  }
}
