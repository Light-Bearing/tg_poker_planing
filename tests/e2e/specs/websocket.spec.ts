import { test, expect } from '@playwright/test';
import { JoinPage } from '../pages/join-page';
import { SessionPage } from '../pages/session-page';

test.describe('WebSocket', () => {
    test('should connect and show online status', async ({ page }) => {
        const joinPage = new JoinPage(page);
        const sessionPage = new SessionPage(page);

        await joinPage.goto();
        await joinPage.createSession('Alice', 'WS test');

        await expect(sessionPage.connectionStatus).toBeVisible();
        await expect(sessionPage.connectionStatus).toHaveText(/ONLINE/);
    });

    test('should show user_joined for other participants', async ({ page, context }) => {
        const joinPage = new JoinPage(page);
        const sessionPage = new SessionPage(page);

        await joinPage.goto();
        await joinPage.createSession('Alice', 'WS join test');
        const sessionId = await sessionPage.sessionIdDisplay.textContent();

        // Verify participants list shows Alice
        await expect(sessionPage.participantsList).toContainText('Alice');

        // Bob joins
        const page2 = await context.newPage();
        const joinPage2 = new JoinPage(page2);
        const sessionPage2 = new SessionPage(page2);
        await joinPage2.goto();
        await joinPage2.joinSession('Bob', sessionId!);

        // Alice should see Bob
        await expect(sessionPage.participantsList).toContainText('Bob');
    });
});