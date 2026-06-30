import { test, expect } from '@playwright/test';
import { JoinPage } from '../pages/join-page';
import { SessionPage } from '../pages/session-page';

test.describe('Scales', () => {
    test('should create session with fibonacci scale', async ({ page }) => {
        const joinPage = new JoinPage(page);
        const sessionPage = new SessionPage(page);

        await joinPage.goto();

        // Select fibonacci scale
        await page.locator('.scale-btn[data-scale="fibonacci"]').click();

        await joinPage.createSession('Alice', 'Fibonacci task');

        // Check fibonacci points visible (1, 2, 3, 5, 8, 13...)
        await expect(page.locator('.point-btn[data-point="13"]')).toBeVisible();
    });

    test('should show custom scale editor', async ({ page }) => {
        const joinPage = new JoinPage(page);
        await joinPage.goto();

        // Switch to custom scale
        await page.locator('.scale-btn[data-scale="custom"]').click();

        // Open editor - edit button should be visible
        const editBtn = page.locator('.scale-edit-btn.visible');
        await expect(editBtn).toBeVisible();
        await editBtn.click();

        // Editor modal should be visible
        await expect(page.locator('#scaleEditorModal')).not.toHaveClass(/hidden/);
    });
});