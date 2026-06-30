export const ADF_SAMPLES = {
    plainText: {
        doc: {
            type: 'doc',
            version: 1,
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Hello, world!' }] },
            ],
        },
        expectedHtml: 'Hello, world!', // Inside <p>
    },
    withMarks: {
        doc: {
            type: 'doc',
            version: 1,
            content: [{
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'Bold ', marks: [{ type: 'strong' }] },
                    { type: 'text', text: 'and ' },
                    { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
                ],
            }],
        },
        expectedContain: ['<strong>Bold</strong>', '<em>italic</em>'],
    },
    heading: {
        doc: {
            type: 'doc',
            version: 1,
            content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section' }] }],
        },
        expectedContain: ['<h2>', 'Section', '</h2>'],
    },
    bulletList: {
        doc: {
            type: 'doc',
            version: 1,
            content: [{
                type: 'bulletList',
                content: [{
                    type: 'listItem',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }],
                }, {
                    type: 'listItem',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }],
                }],
            }],
        },
        expectedContain: ['<ul>', '<li>', 'Item 1', 'Item 2', '</ul>'],
    },
    codeBlock: {
        doc: {
            type: 'doc',
            version: 1,
            content: [{
                type: 'codeBlock',
                attrs: { language: 'python' },
                content: [{ type: 'text', text: 'print("hello")' }],
            }],
        },
        expectedContain: ['<pre class="jira-code">', '<code>', 'print', '</code>', '</pre>'],
    },
    link: {
        doc: {
            type: 'doc',
            version: 1,
            content: [{
                type: 'paragraph',
                content: [{
                    type: 'text',
                    text: 'Click here',
                    marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
                }],
            }],
        },
        expectedContain: ['<a href="https://example.com"', 'Click here', '</a>'],
    },
    table: {
        doc: {
            type: 'doc',
            version: 1,
            content: [{
                type: 'table',
                content: [{
                    type: 'tableRow',
                    content: [
                        { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Key' }] }] },
                        { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }] },
                    ],
                }, {
                    type: 'tableRow',
                    content: [
                        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
                        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] },
                    ],
                }],
            }],
        },
        expectedContain: ['<table', '<th>', '<td>', 'Key', 'Value', 'A', '1'],
    },
};