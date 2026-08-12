// Поиск по загруженным задачам Jira.
//
// Чистая функция, отделённая от разметки, чтобы её можно было проверить тестами:
// остальной код страницы живёт в одном файле и в Node не загружается.

/**
 * Отбирает задачи, подходящие под запрос.
 *
 * Совпадение ищется по ключу задачи, заголовку и названию эпика — по тем трём вещам,
 * которые видно в дереве. Запрос делится на слова, и подходят только задачи,
 * содержащие каждое из них: так «оплат карт» находит «Оплата картой», а порядок слов
 * значения не имеет.
 *
 * @param {Array} issues задачи в том виде, как их отдаёт Jira
 * @param {string} query строка поиска
 * @param {Object} epicMap соответствие ключа эпика его названию
 * @param {string} epicLinkField идентификатор поля связи с эпиком
 * @returns {Array} подходящие задачи; при пустом запросе — все
 */
function filterJiraIssues(issues, query, epicMap = {}, epicLinkField = '') {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return issues || [];

    return (issues || []).filter((issue) => {
        const haystack = jiraIssueHaystack(issue, epicMap, epicLinkField);
        return words.every((word) => haystack.includes(word));
    });
}

/** Собирает в одну строку всё, по чему ищем: ключ, заголовок, ключ и название эпика. */
function jiraIssueHaystack(issue, epicMap = {}, epicLinkField = '') {
    const parts = [issue && issue.key, issue && issue.fields && issue.fields.summary];

    const raw = epicLinkField && issue && issue.fields ? issue.fields[epicLinkField] : null;
    const epicKey = raw && typeof raw === 'object' ? raw.key : raw;
    if (epicKey) {
        parts.push(epicKey);
        parts.push(epicMap[epicKey]);
    }

    return parts.filter(Boolean).join(' ').toLowerCase();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { filterJiraIssues, jiraIssueHaystack };
}
