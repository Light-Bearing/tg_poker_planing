import { Page, Locator, expect } from '@playwright/test';

export class SessionPage {
    readonly page: Page;
    readonly taskDisplay: Locator;
    readonly voteCount: Locator;
    readonly pointsGrid: Locator;
    readonly progressLabel: Locator;
    readonly resultCard: Locator;
    readonly averageValue: Locator;
    readonly resultValue: Locator;
    readonly autoRevealToggle: Locator;
    readonly revealButton: Locator;
    readonly restartButton: Locator;
    readonly participantsList: Locator;
    readonly newTaskInput: Locator;
    readonly connectionStatus: Locator;
    readonly sessionIdDisplay: Locator;

    constructor(page: Page) {
        this.page = page;
        this.taskDisplay = page.locator('#taskDisplay');
        this.voteCount = page.locator('#voteCount');
        this.pointsGrid = page.locator('#pointsGrid');
        this.progressLabel = page.locator('#progressLabel');
        this.resultCard = page.locator('#resultCard');
        this.averageValue = page.locator('#averageValue');
        this.resultValue = page.locator('#resultValue');
        this.autoRevealToggle = page.locator('#autoRevealToggle');
        this.revealButton = page.locator('.btn-success');
        this.restartButton = page.locator('.btn-warning');
        this.participantsList = page.locator('#participantsList');
        this.newTaskInput = page.locator('#newTaskText');
        this.connectionStatus = page.locator('#connectionStatus');
        this.sessionIdDisplay = page.locator('#sessionIdDisplay');
    }

    async vote(point: string) {
        await this.page.locator(`.point-btn[data-point="${point}"]`).click();
    }

    async reveal() {
        await this.revealButton.click();
    }

    async restart() {
        await this.restartButton.click();
    }

    getVoteCount() {
        return this.voteCount.textContent();
    }

    isResultVisible() {
        return this.resultCard.isVisible();
    }
}