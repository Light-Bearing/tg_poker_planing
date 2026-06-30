import { test, expect } from '@playwright/test';
import { JoinPage } from '../pages/join-page';
import { SessionPage } from '../pages/session-page';

test.describe('Core Flow', () => {
    let joinPage: JoinPage;
    let sessionPage: SessionPage;

    test.beforeEach(async ({ page }) => {
        joinPage = new JoinPage(page);
        sessionPage = new SessionPage(page);
        await joinPage.goto();
    });

    test('should create a session and display task', async ({ page }) => {
        await joinPage.createSession('Alice', 'Test task description');

        await expect(page.locator('#sessionScreen')).toBeVisible();
        await expect(sessionPage.taskDisplay).toContainText('Test task description');
        await expect(sessionPage.connectionStatus).toHaveText(/ONLINE/);
        await expect(sessionPage.pointsGrid).not.toBeEmpty();
    });

    test('should vote, reveal and show average', async ({ page }) => {
        await joinPage.createSession('Alice', 'Story points estimation');

        // Vote "5"
        await sessionPage.vote('5');
        await expect(sessionPage.voteCount).not.toHaveText('0');

        // Reveal
        await sessionPage.reveal();
        await expect(sessionPage.resultCard).toBeVisible();
        await expect(sessionPage.averageValue).not.toHaveText('0');
    });

    test('should restart session after reveal', async ({ page }) => {
        await joinPage.createSession('Alice', 'Task for restart');

        await sessionPage.vote('8');
        await sessionPage.reveal();
        await expect(sessionPage.resultCard).toBeVisible();

        // Restart
        await sessionPage.restart();
        // Should handle confirm dialog
        await page.locator('#confirmOkBtn').click();
        await expect(sessionPage.resultCard).not.toBeVisible();
    });

    test('should join existing session by ID', async ({ page, context }) => {
        // Create session in first tab
        await joinPage.createSession('Alice', 'Task for Bob');
        const sessionId = await sessionPage.sessionIdDisplay.textContent();

        // Open second tab
        const page2 = await context.newPage();
        const joinPage2 = new JoinPage(page2);
        const sessionPage2 = new SessionPage(page2);

        await joinPage2.goto();
        await joinPage2.joinSession('Bob', sessionId!);

        await expect(page2.locator('#sessionScreen')).toBeVisible();
        await expect(sessionPage2.taskDisplay).toContainText('Task for Bob');
    });

    test('should sync votes between participants', async ({ page, context }) => {
        await joinPage.createSession('Alice', 'Sync test');
        const sessionId = await sessionPage.sessionIdDisplay.textContent();

        // Second user joins
        const page2 = await context.newPage();
        const joinPage2 = new JoinPage(page2);
        const sessionPage2 = new SessionPage(page2);
        await joinPage2.goto();
        await joinPage2.joinSession('Bob', sessionId!);

        // Alice votes
        await sessionPage.vote('3');
        await expect(sessionPage.voteCount).toHaveText('1');

        // Bob votes
        await sessionPage2.vote('5');
        await expect(sessionPage2.voteCount).toHaveText('2');
        await expect(sessionPage.voteCount).toHaveText('2');
    });
});