// Салют при единогласии.
//
// Команда сошлась на одной оценке — это редкий и приятный момент, и он стоит
// того, чтобы его заметили: обычно вскрытие показывает разброс, ради обсуждения
// которого всё и затевалось. Отдельный файл, потому что к самой игре эффект
// отношения не имеет и не должен путаться под ногами в script.js.
//
// Без зависимостей: у проекта нет сборщика, и тащить библиотеку конфетти ради
// пятидесяти строк канваса незачем.

// Единогласие ли. Чистая функция — покрыта тестами в tests/js/salute.test.js.
//
// «❔» и «☕» не считаются согласием: первое означает «не знаю», второе — «нужен
// перерыв». Команда, дружно ответившая «не знаю», ни о чём не договорилась.
function isUnanimous(points, specialPoints = ['❔', '☕']) {
    const голоса = (points || []).filter(p => p !== null && p !== undefined && p !== '');
    if (голоса.length < 2) return false;                      // сам с собой не соглашаются
    if (specialPoints.includes(голоса[0])) return false;
    return голоса.every(p => p === голоса[0]);
}

// Одна частица салюта
function makeParticle(centerX, centerY, random = Math.random) {
    const угол = random() * Math.PI * 2;
    const скорость = 3 + random() * 5;
    return {
        x: centerX,
        y: centerY,
        vx: Math.cos(угол) * скорость,
        vy: Math.sin(угол) * скорость - 3,   // вверх заметнее, чем вниз
        радиус: 2 + random() * 3,
        оттенок: Math.floor(random() * 360),
        жизнь: 1,
    };
}

// Шаг физики: гравитация, трение, угасание. Отдельно от отрисовки, чтобы
// поведение можно было проверить без канваса.
function stepParticle(p, dt = 1) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 0.12 * dt;        // гравитация
    p.vx *= 0.99;             // сопротивление воздуха
    p.жизнь -= 0.012 * dt;
    return p;
}

// Уважает системную настройку «меньше движения»: для тех, кому анимация мешает
// или вызывает дурноту, праздник не должен быть обязательным.
function motionAllowed(win = typeof window !== 'undefined' ? window : null) {
    if (!win || !win.matchMedia) return true;
    return !win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function launchSalute({ залпов = 3, частицНаЗалп = 60 } = {}) {
    if (typeof document === 'undefined' || !motionAllowed()) return null;

    const canvas = document.createElement('canvas');
    canvas.className = 'salute-canvas';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    const частицы = [];
    let залповВыпущено = 0;

    const залп = () => {
        const x = canvas.width * (0.25 + Math.random() * 0.5);
        const y = canvas.height * (0.25 + Math.random() * 0.3);
        for (let i = 0; i < частицНаЗалп; i++) частицы.push(makeParticle(x, y));
        залповВыпущено++;
        if (залповВыпущено < залпов) setTimeout(залп, 350);
    };
    залп();

    const кадр = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const p of частицы) {
            stepParticle(p);
            if (p.жизнь <= 0) continue;
            ctx.globalAlpha = Math.max(0, p.жизнь);
            ctx.fillStyle = `hsl(${p.оттенок}, 90%, 60%)`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.радиус, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        const живые = частицы.filter(p => p.жизнь > 0);
        if (живые.length === 0 && залповВыпущено >= залпов) {
            canvas.remove();
            return;
        }
        requestAnimationFrame(кадр);
    };
    requestAnimationFrame(кадр);

    return canvas;
}

// Экспорт для юнит-тестов: в браузере module не определён, ветка не выполняется
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isUnanimous, makeParticle, stepParticle, motionAllowed };
}
