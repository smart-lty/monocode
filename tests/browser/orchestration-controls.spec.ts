import { expect, test } from "@playwright/test";

for (const [button, result] of [["Resume", "resumed"], ["Stop orchestration", "stopped"]]) {
  test(`${button} receives a real pointer click inside a draggable session card`, async ({ page }) => {
    await page.goto("/tests/browser/orchestration-controls.html");
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.getByTestId("result")).toHaveText(result);
    await expect(page.getByTestId("captures")).toHaveText("0");
    await expect(page.getByTestId("selections")).toHaveText("0");
    // Event isolation on the controls must leave the card header interactive.
    await page.getByTestId("session-header").click();
    await expect(page.getByTestId("captures")).toHaveText("1");
    await expect(page.getByTestId("selections")).toHaveText("1");
  });
}
