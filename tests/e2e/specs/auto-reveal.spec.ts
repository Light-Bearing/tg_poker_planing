import { test, expect } from '@playwright/test';
import { JoinPage } from '../pages/join-page';
import { SessionPage } from '../pages/session-page';

test.describe('Auto-Reveal', () => {
    test('should auto-reveal when enabled and all vote', async ({ page, context }) => {
        const joinPage = new JoinPage(page);
        const sessionPage = new SessionPage(page);

        await joinPage.goto();
        await joinPage.createSession('Alice', 'Auto-reveal task');
        const sessionId = await sessionPage.sessionIdDisplay.textContent();

        // Enable auto-reveal
        await sessionPage.autoRevealToggle.check();
        await expect(sessionPage.autoRevealToggle).toBeChecked();

        // Bob joins
        const page2 = await context.newPage();
        const joinPage2 = new JoinPage(page2);
        const sessionPage2 = new SessionPage(page2);
        await joinPage2.goto();
        await joinPage2.joinSession('Bob', sessionId!);

        // Alice votes
        await sessionPage.vote('5');
        // Bob votes
        await sessionPage2.vote('3');

        // Wait for auto-reveal (1s timer + network)
        await page.waitForTimeout(2500);

        // Cards should be revealed
        await expect(sessionPage.resultCard).toBeVisible({ timeout: 5000 });
    });

    test('should NOT auto-reveal when disabled even if all vote', async ({ page, context }) => {
        const joinPage = new JoinPage(page);
        const sessionPage = new SessionPage(page);

        await joinPage.goto();
        await joinPage.createSession('Alice', 'No auto-reveal');
        const sessionId = await sessionPage.sessionIdDisplay.textContent();

        // Ensure auto-reveal is OFF
        if (await sessionPage.autoRevealToggle.isChecked()) {
            await sessionPage.autoRevealToggle.uncheck();
        }
        await expect(sessionPage.autoRevealToggle).not.toBeChecked();

        // Bob joins
        const page2 = await context.newPage();
        const joinPage2 = new JoinPage(page2);
        const sessionPage2 = new SessionPage(page2);
        await joinPage2.goto();
        await joinPage2.joinSession('Bob', sessionId!);

        // Both vote
        await sessionPage.vote('5');
        await sessionPage2.vote('3');

        await page.waitForTimeout(2500);

        // Cards should NOT be revealed
        await expect(sessionPage.resultCard).not.toBeVisible();
    });

    test('should preserve auto-reveal checkbox state after reveal', async ({ page, context }) => {
        const joinPage = new JoinPage(page);
        const sessionPage = new SessionPage(page);

        await joinPage.goto();
        await joinPage.createSession('Alice', 'Persist checkbox');

        // Enable auto-reveal
        await sessionPage.autoRevealToggle.check();
        await expect(sessionPage.autoRevealToggle).toBeChecked();

        // Vote and manually reveal (not auto)
        await sessionPage.vote('3');
        await sessionPage.reveal();
        await expect(sessionPage.resultCard).toBeVisible();

        // Checkbox should still be checked
        await expect(sessionPage.autoRevealToggle).toBeChecked();
    });
});