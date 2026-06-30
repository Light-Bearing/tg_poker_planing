import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './specs',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'html',
    timeout: 15000,
    use: {
        baseURL: 'http://localhost:8000',
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
        // Firefox is less critical for smoke — single browser is enough for CI
    ],
    webServer: {
        command: 'python3 ../../main.py',
        port: 8000,
        reuseExistingServer: !process.env.CI,
        cwd: '../../',
        timeout: 15000,
    },
});