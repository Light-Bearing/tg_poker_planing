import { test, expect, Page } from '@playwright/test';
import { ADF_SAMPLES } from '../fixtures/adf-samples';
import { WIKI_SAMPLES } from '../fixtures/wiki-samples';

test.describe('ADF Parser', () => {
    /**
     * Evaluate parseJiraDescription in browser context.
     */
    async function parseInBrowser(page: Page, input: any): Promise<string> {
        return page.evaluate((desc) => {
            // Injected via adf-parser.js
            return (window as any).parseJiraDescription(desc);
        }, input);
    }

    test.beforeEach(async ({ page }) => {
        // Navigate to app to load adf-parser.js
        await page.goto('/');
    });

    for (const [name, sample] of Object.entries(ADF_SAMPLES)) {
        test(`should parse ADF: ${name}`, async ({ page }) => {
            const result = await parseInBrowser(page, sample.doc);

            if ('expectedHtml' in sample) {
                expect(result).toContain(sample.expectedHtml);
            }
            if ('expectedContain' in sample) {
                for (const substr of sample.expectedContain) {
                    expect(result).toContain(substr);
                }
            }
        });
    }

    for (const [name, sample] of Object.entries(WIKI_SAMPLES)) {
        test(`should parse wiki: ${name}`, async ({ page }) => {
            const result = await parseInBrowser(page, sample.input);

            for (const substr of sample.expectedContain) {
                expect(result).toContain(substr);
            }
        });
    }

    test('should handle null/undefined gracefully', async ({ page }) => {
        expect(await parseInBrowser(page, null)).toBe('');
        expect(await parseInBrowser(page, undefined)).toBe('');
        expect(await parseInBrowser(page, '')).toBe('');
    });

    test('should fallback for unknown format', async ({ page }) => {
        const result = await parseInBrowser(page, 12345);
        expect(result).toBe('12345');
    });
});