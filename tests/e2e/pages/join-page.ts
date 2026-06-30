import { Page, Locator } from '@playwright/test';

export class JoinPage {
    readonly page: Page;
    readonly usernameInput: Locator;
    readonly sessionIdInput: Locator;
    readonly taskTextInput: Locator;
    readonly createButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.usernameInput = page.locator('#username');
        this.sessionIdInput = page.locator('#sessionId');
        this.taskTextInput = page.locator('#taskText');
        this.createButton = page.locator('.btn-primary');
    }

    async goto() {
        await this.page.goto('/');
    }

    async createSession(username: string, taskText: string) {
        await this.usernameInput.fill(username);
        await this.taskTextInput.fill(taskText);
        await this.createButton.click();
    }

    async joinSession(username: string, sessionId: string) {
        await this.usernameInput.fill(username);
        await this.sessionIdInput.fill(sessionId);
        await this.createButton.click();
    }
}