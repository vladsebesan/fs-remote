import { expect, test, type ElementHandle, type Page } from "@playwright/test";
import { card, login, openWorkspace } from "./helpers";
import { WORKSPACE_A, WORKSPACE_B } from "./fixtures";

async function mkdir(page: Page, name: string) {
  await page.getByTestId("mkdir-submit").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("Folder name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(card(page, name)).toBeVisible();
}

async function selectCard(page: Page, name: string) {
  // Plain click on a folder enters it; use ControlOrMeta+click to toggle
  // selection without navigating.
  await card(page, name).click({ modifiers: ["ControlOrMeta"] });
}

test.describe("move / copy / multi-select", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("multi-select + multi-delete", async ({ page }) => {
    await openWorkspace(page, WORKSPACE_A.label);

    const names = ["mdel-a", "mdel-b", "mdel-c"];
    for (const n of names) {
      await mkdir(page, n);
    }

    for (const n of names) {
      await selectCard(page, n);
    }
    await expect(page.getByTestId("selection-count")).toHaveText(
      `${names.length} selected`,
    );

    await page.getByTestId("delete-btn").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Delete ${names.length} items`);
    await dialog.getByRole("button", { name: "Delete" }).click();

    for (const n of names) {
      await expect(card(page, n)).toHaveCount(0);
    }
  });

  test("cut + paste moves into another folder (same workspace)", async ({
    page,
  }) => {
    await openWorkspace(page, WORKSPACE_A.label);

    await mkdir(page, "mv-src");
    await mkdir(page, "mv-dst");

    await selectCard(page, "mv-src");
    await page.keyboard.press("ControlOrMeta+x");

    await card(page, "mv-dst").click();
    await expect(page.getByTestId("cwd")).toContainText("mv-dst");

    await page.keyboard.press("ControlOrMeta+v");
    await expect(card(page, "mv-src")).toBeVisible();

    // Source folder should no longer exist at the original location.
    await page.getByTestId("cwd").getByText(WORKSPACE_A.label).click();
    await expect(card(page, "mv-src")).toHaveCount(0);
    await expect(card(page, "mv-dst")).toBeVisible();
  });

  test("copy + paste into same folder auto-renames the duplicate", async ({
    page,
  }) => {
    await openWorkspace(page, WORKSPACE_A.label);

    await mkdir(page, "cp-src");

    await selectCard(page, "cp-src");
    await page.keyboard.press("ControlOrMeta+c");
    await page.keyboard.press("ControlOrMeta+v");

    // Original is untouched, and a uniquified copy appeared.
    await expect(card(page, "cp-src")).toBeVisible();
    await expect(card(page, "cp-src (2)")).toBeVisible();
  });

  test("cut + paste moves across workspaces", async ({ page }) => {
    await openWorkspace(page, WORKSPACE_A.label);
    await mkdir(page, "xroot-src");

    await selectCard(page, "xroot-src");
    await page.keyboard.press("ControlOrMeta+x");

    // Switch to workspace B via the sidebar.
    const sidebar = page.getByTestId("file-tree-sidebar");
    await sidebar.getByRole("button", { name: WORKSPACE_B.label }).click();
    await expect(page.getByTestId("cwd")).toContainText(WORKSPACE_B.label);

    await page.keyboard.press("ControlOrMeta+v");
    await expect(card(page, "xroot-src")).toBeVisible();

    // Back to A; source is gone.
    await sidebar.getByRole("button", { name: WORKSPACE_A.label }).click();
    await expect(page.getByTestId("cwd")).toContainText(WORKSPACE_A.label);
    await expect(card(page, "xroot-src")).toHaveCount(0);

    // Clean up the moved folder in B so the suite stays idempotent.
    await sidebar.getByRole("button", { name: WORKSPACE_B.label }).click();
    await selectCard(page, "xroot-src");
    await page.keyboard.press("Delete");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(card(page, "xroot-src")).toHaveCount(0);
  });

  test("drag-and-drop moves a file onto a folder card", async ({ page }) => {
    await openWorkspace(page, WORKSPACE_A.label);

    await mkdir(page, "dnd-src");
    await mkdir(page, "dnd-dst");

    await dragDropByName(page, "dnd-src", "dnd-dst");

    await expect(card(page, "dnd-src")).toHaveCount(0);
    await card(page, "dnd-dst").click();
    await expect(card(page, "dnd-src")).toBeVisible();
  });
});

// Simulates a same-page HTML5 drag-and-drop by dispatching dragstart/
// dragover/drop events sharing a single DataTransfer. We have to do this by
// hand because Playwright's built-in DnD does not preserve custom MIME
// payloads.
async function dragDropByName(page: Page, fromName: string, toName: string) {
  const fromCard = await locateDraggableCard(page, fromName);
  const toCard = await locateDraggableCard(page, toName);
  await page.evaluate(
    ({ from, to }) => {
      const dt = new DataTransfer();
      const fire = (el: Element, type: string) => {
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          }),
        );
      };
      fire(from, "dragstart");
      fire(to, "dragenter");
      fire(to, "dragover");
      fire(to, "drop");
      fire(from, "dragend");
    },
    { from: fromCard, to: toCard },
  );
  await fromCard.dispose();
  await toCard.dispose();
}

async function locateDraggableCard(
  page: Page,
  name: string,
): Promise<ElementHandle<HTMLElement>> {
  const handle = await page.evaluateHandle((name: string) => {
    const grid = document.querySelector('[data-testid="file-grid"]');
    if (!grid) throw new Error("no file-grid");
    const cards = grid.querySelectorAll('[draggable="true"]');
    for (const el of Array.from(cards) as HTMLElement[]) {
      if (el.innerText.includes(name)) return el;
    }
    throw new Error(`card not found: ${name}`);
  }, name);
  return handle.asElement() as ElementHandle<HTMLElement>;
}
