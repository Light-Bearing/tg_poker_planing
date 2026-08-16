// web/static/adf-parser.js
// PP Jira ADF Parser — converts Jira ADF descriptions to HTML.
// Wiki-разметкой занимается отдельный файл wiki-parser.js.

(function () {
    'use strict';

    // Схему адреса проверяет общий модуль: в браузере он уже загружен, в тестах
    // на node подтягивается напрямую
    const безопасныйАдрес = (typeof module !== 'undefined' && module.exports)
        ? require('./safe-url.js').safeUrl
        : (typeof window !== 'undefined' && window.safeUrl) || (a => a);

    // ========== UTILITY ==========
    // Чистая реализация: не требует DOM (нужно для запуска в Node) и, в отличие
    // от прежней через createElement, экранирует кавычки — результат подставляется
    // в том числе в значения атрибутов.
    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ========== TEXT MARKS ==========
    function renderMarks(text, marks) {
        if (!marks || marks.length === 0) return escapeHtml(text);
        var hasLink = marks.some(function(m) { return m.type === 'link'; });
        var result = escapeHtml(text);
        for (var i = 0; i < marks.length; i++) {
            var mark = marks[i];
            switch (mark.type) {
                case 'strong': result = '<strong>' + result + '</strong>'; break;
                case 'em': result = '<em>' + result + '</em>'; break;
                case 'code': result = '<code>' + result + '</code>'; break;
                case 'strike': {
                    // Jira может применить strike к тексту между дефисами внутри
                    // Markdown-ссылок [text](url) или путей. Если нет link-марки,
                    // а в тексте есть URL/путевые символы — это ложное зачёркивание.
                    if (!hasLink && (/[\/()]/.test(text) || /^https?:\/\//i.test(text))) break;
                    result = '<s>' + result + '</s>';
                    break;
                }
                case 'underline': result = '<u>' + result + '</u>'; break;
                case 'subsup': {
                    var type = mark.attrs && mark.attrs.type || 'sub';
                    result = type === 'sup' ? '<sup>' + result + '</sup>' : '<sub>' + result + '</sub>';
                    break;
                }
                case 'link': {
                    var href = escapeHtml(безопасныйАдрес(mark.attrs && mark.attrs.href || '#'));
                    result = '<a href="' + href + '" target="_blank" class="jira-desc-link">' + result + '</a>';
                    break;
                }
                case 'textColor': {
                    var color = mark.attrs && mark.attrs.color || 'inherit';
                    result = '<span style="color:' + color + '">' + result + '</span>';
                    break;
                }
                case 'backgroundColor': {
                    var bg = mark.attrs && mark.attrs.color || 'transparent';
                    result = '<span style="background:' + bg + '">' + result + '</span>';
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
                const VALID_PANEL_TYPES = ['info', 'note', 'warning', 'success', 'error'];
                const rawPanelType = (attrs.panelType || 'info').toLowerCase();
                const panelType = VALID_PANEL_TYPES.includes(rawPanelType) ? rawPanelType : 'info';
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

    // ========== ENTRY POINT ==========
    function parseJiraDescription(desc) {
        if (!desc) return '';
        if (typeof desc === 'object' && desc !== null && desc.type === 'doc') {
            return adfToHtml(desc);
        }
        if (typeof desc === 'string') {
            const wiki = (typeof module !== 'undefined' && module.exports)
                ? require('./wiki-parser.js').parseJiraWiki
                : (typeof window !== 'undefined' ? window.parseJiraWiki : null);
            // Если wiki-parser.js не подключён, отдаём экранированный текст,
            // а не падаем: описание задачи важнее разметки.
            return wiki ? wiki(desc) : escapeHtml(desc);
        }
        return escapeHtml(String(desc));
    }

    if (typeof window !== 'undefined') {
        window.parseJiraDescription = parseJiraDescription;
    }

    // Файл работает и как обычный <script> на странице, и как модуль в Node —
    // это нужно, чтобы парсер можно было тестировать без браузера и без сборщика.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { parseJiraDescription, escapeHtml };
    }
})();
