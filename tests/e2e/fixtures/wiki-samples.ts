export const WIKI_SAMPLES = {
    bold: { input: 'This is *bold* text', expectedContain: ['<strong>bold</strong>'] },
    italic: { input: 'This is _italic_ text', expectedContain: ['<em>italic</em>'] },
    code: { input: 'Use {{var}} here', expectedContain: ['<code>var</code>'] },
    strike: { input: '-deleted- text', expectedContain: ['<s>deleted</s>'] },
    heading: { input: 'h2. Title', expectedContain: ['<h2>', 'Title', '</h2>'] },
    codeBlock: { input: '{code}print("hi"){code}', expectedContain: ['<pre class="jira-code">', '<code>', 'print', '</code>', '</pre>'] },
    link: { input: '[text|https://example.com]', expectedContain: ['<a href="https://example.com"', 'text', '</a>'] },
};