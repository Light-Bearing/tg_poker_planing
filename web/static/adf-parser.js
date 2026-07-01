// web/static/adf-parser.js
// PP Jira ADF & Wiki Parser — converts Jira descriptions to HTML

(function () {
    'use strict';

    // ========== UTILITY ==========
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ========== TEXT MARKS ==========
    function renderMarks(text, marks) {
        if (!marks || marks.length === 0) return escapeHtml(text);
        let result = escapeHtml(text);
        for (const mark of marks) {
            switch (mark.type) {
                case 'strong': result = `<strong>${result}</strong>`; break;
                case 'em': result = `<em>${result}</em>`; break;
                case 'code': result = `<code>${result}</code>`; break;
                case 'strike': result = `<s>${result}</s>`; break;
                case 'underline': result = `<u>${result}</u>`; break;
                case 'subsup': {
                    const type = mark.attrs?.type || 'sub';
                    result = type === 'sup' ? `<sup>${result}</sup>` : `<sub>${result}</sub>`;
                    break;
                }
                case 'link': {
                    const href = escapeHtml(mark.attrs?.href || '#');
                    result = `<a href="${href}" target="_blank" class="jira-desc-link">${result}</a>`;
                    break;
                }
                case 'textColor': {
                    const color = mark.attrs?.color || 'inherit';
                    result = `<span style="color:${color}">${result}</span>`;
                    break;
                }
                case 'backgroundColor': {
                    const bg = mark.attrs?.color || 'transparent';
                    result = `<span style="background:${bg}">${result}</span>`;
                    break;
                }
            }
        }
        return result;
    }

    // ========== ADF → HTML RECURSIVE ==========
    function adfToHtml(node) {
        if (!node || typeof node !== 'object') return '';

        const type = node.type;
        const content = node.content;
        const attrs = node.attrs || {};
        const marks = node.marks;

        if (type === 'text') {
            return marks ? renderMarks(node.text || '', marks) : escapeHtml(node.text || '');
        }

        let innerHtml = '';
        if (content && Array.isArray(content)) {
            innerHtml = content.map(adfToHtml).join('');
        } else {
            innerHtml = '';
        }

        switch (type) {
            case 'doc':
                return `<div class="jira-doc">${innerHtml}</div>`;

            case 'paragraph':
                return `<p>${innerHtml || ' '}</p>`;

            case 'heading': {
                const level = Math.min(Math.max(attrs.level || 1, 1), 6);
                return `<h${level}>${innerHtml}</h${level}>`;
            }

            case 'bulletList':
                return `<ul>${innerHtml}</ul>`;

            case 'orderedList':
                return `<ol>${innerHtml}</ol>`;

            case 'listItem':
                return `<li>${innerHtml}</li>`;

            case 'codeBlock': {
                const lang = attrs.language ? ` data-language="${escapeHtml(attrs.language)}"` : '';
                return `<pre class="jira-code"><code${lang}>${innerHtml || escapeHtml(node.text || '')}</code></pre>`;
            }

            case 'blockquote':
                return `<blockquote>${innerHtml}</blockquote>`;

            case 'panel': {
                const panelType = attrs.panelType || 'info';
                const panelIcons = { info: 'ℹ️', note: '📝', warning: '⚠️', success: '✅', error: '❌' };
                const icon = panelIcons[panelType] || 'ℹ️';
                return `<div class="jira-panel jira-panel-${panelType}"><span class="jira-panel-icon">${icon}</span><span class="jira-panel-content">${innerHtml}</span></div>`;
            }

            case 'rule':
                return `<hr>`;

            case 'hardBreak':
                return `<br>`;

            case 'table':
                return `<table class="jira-table"><tbody>${innerHtml}</tbody></table>`;

            case 'tableRow':
                return `<tr>${innerHtml}</tr>`;

            case 'tableHeader':
                return `<th>${innerHtml}</th>`;

            case 'tableCell':
                return `<td>${innerHtml}</td>`;

            case 'media':
            case 'mediaSingle':
            case 'mediaGroup':
                return `<div class="jira-media-placeholder">📎 ${escapeHtml(attrs.type || 'media')}</div>`;

            case 'mention': {
                const mentionText = attrs.text || attrs.id || '';
                return `<span class="jira-mention">@${escapeHtml(mentionText)}</span>`;
            }

            case 'inlineCard': {
                const url = attrs?.url || '';
                return url ? `<a href="${escapeHtml(url)}" target="_blank" class="jira-desc-link">${escapeHtml(url)}</a>` : '';
            }

            case 'emoji': {
                return attrs.text || '😀';
            }

            case 'applicationCard':
            case 'decisionList':
            case 'decisionItem':
            case 'taskList':
            case 'taskItem': {
                return innerHtml;
            }

            default:
                return innerHtml;
        }
    }

    // ========== WIKI → HTML ==========
    function parseWikiMarkup(text) {
        if (!text) return '';

        let html = text;

        html = escapeHtml(html);

        html = html.replace(/\{code\}([\s\S]*?)\{code\}/g, '<pre class="jira-code"><code>$1</code></pre>');

        html = html.replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, '<pre class="jira-code"><code>$1</code></pre>');

        html = html.replace(/\{quote\}([\s\S]*?)\{quote\}/g, '<blockquote>$1</blockquote>');

        // {color:red}text{color} — цветной текст
        html = html.replace(/\{color(?::([^}]+))?\}([\s\S]*?)\{color\}/g, (_, color, content) => {
            const col = color ? color.trim() : 'inherit';
            return `<span style="color:${col}">${content}</span>`;
        });

        // {panel}text{panel} или {panel:title=X}text{panel} — информационные панели
        html = html.replace(/\{panel(?::title=([^}]+))?\}([\s\S]*?)\{panel\}/g, (_, title, content) => {
            const titleHtml = title ? `<div class="jira-panel-title">${title.trim()}</div>` : '';
            return `<div class="jira-panel jira-panel-info">${titleHtml}<div class="jira-panel-content">${content.trim()}</div></div>`;
        });

        html = html.replace(/^h([1-6])\.\s+(.*)$/gm, (_, level, title) => `<h${level}>${title}</h${level}>`);

        html = html.replace(/^\|\|(.+)\|\|$/gm, (_, row) => {
            const cells = row.split('||').map(c => c.trim()).filter(Boolean);
            const tag = cells.length > 0 && row.trim().startsWith('||') && row.trim().endsWith('||') ? 'th' : 'td';
            const cellTag = tag;
            return `<tr>${cells.map(c => `<${cellTag}>${c}</${cellTag}>`).join('')}</tr>`;
        });
        html = html.replace(/((?:<tr>.*?<\/tr>\n?)+)/g, '<table class="jira-table"><tbody>$1</tbody></table>');

        html = html.replace(/^(#+)\s+(.*)$/gm, (_, level, item) => {
            const nest = level.length - 1;
            return `${'  '.repeat(nest)}<li>${item}</li>`;
        });
        html = html.replace(/((?:^|\n)\s*<li>.*?\n?)+/g, (match) => {
            const items = match.trim().split('\n').map(l => l.trim()).join('\n');
            return `\n<ol>${items.replace(/<li>/g, '\n<li>')}\n</ol>\n`;
        });

        html = html.replace(/^(\s*)[*-]\s+(.*)$/gm, (_, spaces, item) => `<li>${item}</li>`);
        html = html.replace(/(?:^|\n)((?:<li>.*?<\/li>(?:\n|$))+)/g, '\n<ul>$1</ul>\n');

        html = html.replace(/\{\{(.+?)\}\}/g, '<code>$1</code>');
        html = html.replace(/-([\S\x20]+?)-/g, (match, text) => {
            if (match.startsWith('[') || match.endsWith(']')) return match;
            return `<s>${text}</s>`;
        });
        html = html.replace(/\+(.+?)\+/g, '<u>$1</u>');
        html = html.replace(/\^(.+?)\^/g, '<sup>$1</sup>');
        html = html.replace(/~(.+?)~/g, '<sub>$1</sub>');
        html = html.replace(/\*(\S[\s\S]*?\S)\*/g, '<strong>$1</strong>');
        html = html.replace(/_(\S[\s\S]*?\S)_/g, '<em>$1</em>');

        html = html.replace(/\[([^|]+?)\|([^\]\n]+?)\]/g, (_, text, url) => {
            const href = url.match(/^https?:\/\//) ? url : `https://${url}`;
            return `<a href="${escapeHtml(href)}" target="_blank" class="jira-desc-link">${text.trim()}</a>`;
        });

        html = html.replace(/\[([A-Z]{2,6}-\d+)\]/g, '<span class="jira-task-ref">$1</span>');
        html = html.replace(/\b([A-Z]{2,6}-\d+)\b/g, '<span class="jira-task-ref">$1</span>');

        html = html.replace(/(^|[\s(\[,;:>!?])(https?:\/\/[^\s<>\])"]+)/g, (_, before, url) =>
            `${before}<a href="${escapeHtml(url)}" target="_blank" class="jira-desc-link">${url}</a>`
        );

        html = html.replace(/\n/g, '<br>');

        return html;
    }

    // ========== ENTRY POINT ==========
    window.parseJiraDescription = function parseJiraDescription(desc) {
        if (!desc) return '';
        if (typeof desc === 'object' && desc !== null && desc.type === 'doc') {
            return adfToHtml(desc);
        }
        if (typeof desc === 'string') {
            return parseWikiMarkup(desc);
        }
        return escapeHtml(String(desc));
    };
})();