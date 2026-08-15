// Итоговая оценка: как из разных голосов получается одно число.
//
// Отдельный файл, потому что это единственное место с арифметикой, и её стоит
// проверять тестами, а не глазами на живой комнате (tests/js/estimate.test.js).

// Значения, которые не оценка, а отказ оценивать
const SPECIAL_POINTS = ['❔', '☕'];

// Ближайшая карта колоды к среднему.
//
// Среднее почти никогда не совпадает с картой: голоса 8/16/32 дают 18.7, и раньше
// в ИТОГ попадало 19 — число, которого нет в колоде и которое нельзя выбрать. Играют
// картами, значит и итог должен быть картой. При равном расстоянии берём большую:
// недооценить задачу дороже, чем переоценить.
function snapToScale(average, points) {
    const карты = (points || [])
        .filter(p => !SPECIAL_POINTS.includes(p))
        .map(p => ({ point: p, число: parseFloat(p) }))
        .filter(p => !isNaN(p.число))
        .sort((a, b) => a.число - b.число);

    if (карты.length === 0) return null;

    let ближайшая = карты[0];
    for (const карта of карты) {
        const было = Math.abs(ближайшая.число - average);
        const стало = Math.abs(карта.число - average);
        if (стало < было || (стало === было && карта.число > ближайшая.число)) {
            ближайшая = карта;
        }
    }
    return ближайшая.point;
}

// Самое частое значение среди голосов — итог для шкал, где нельзя считать среднее
// (T-shirt: L и M не складываются). Ничья решается порядком карт в колоде: берём
// ту, что старше, по той же причине, что и в snapToScale.
function modePoint(points, scalePoints = []) {
    const голоса = (points || []).filter(p => p && !SPECIAL_POINTS.includes(p));
    if (голоса.length === 0) return null;

    const счёт = new Map();
    for (const p of голоса) счёт.set(p, (счёт.get(p) || 0) + 1);

    const место = p => {
        const idx = scalePoints.indexOf(p);
        return idx === -1 ? -1 : idx;
    };

    let лучший = null;
    for (const [точка, сколько] of счёт) {
        if (лучший === null || сколько > счёт.get(лучший) ||
            (сколько === счёт.get(лучший) && место(точка) > место(лучший))) {
            лучший = точка;
        }
    }
    return лучший;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { snapToScale, modePoint, SPECIAL_POINTS };
}
