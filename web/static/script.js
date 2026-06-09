let state = {
    username: localStorage.getItem('pp_username') || '',
    sessionId: null,
    isInitiator: false,
    selectedPoint: null,
    ws: null,
    reconnectAttempts: 0,
    wasRevealed: false
};

function initTheme() {
    const savedTheme = localStorage.getItem('pp_theme') || 'dark';
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
        updateThemeButton(true);
    } else {
        updateThemeButton(false);
    }
}

function toggleTheme() {
    const isLight = document.body.classList.toggle('light-theme');
    localStorage.setItem('pp_theme', isLight ? 'light' : 'dark');
    updateThemeButton(isLight);
}

function updateThemeButton(isLight) {
    document.getElementById('themeIcon').textContent = isLight ? '☾' : '☀';
    document.getElementById('themeText').textContent = isLight ? 'ТЁМНАЯ' : 'СВЕТЛАЯ';
}

function toggleTaskField() {
    const sessionId = document.getElementById('sessionId').value.trim();
    const taskGroup = document.getElementById('taskGroup');
    taskGroup.style.display = sessionId ? 'none' : 'block';
}

function formatTaskText(text) {
    if (!text) return '';
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    return text.replace(urlRegex, url => `<a href="${url}" target="_blank" style="color: var(--accent); text-decoration: underline; word-break: break-all;">${url}</a>`);
}

document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    document.getElementById('username').value = state.username;
    
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session');
    if (sessionId) {
        document.getElementById('sessionId').value = sessionId;
        document.getElementById('taskGroup').style.display = 'none';
    }
    
    if (state.username && sessionId) joinOrCreateSession();
});

async function joinOrCreateSession() {
    const username = document.getElementById('username').value.trim();
    const sessionId = document.getElementById('sessionId').value.trim();
    const taskText = document.getElementById('taskText').value.trim();
    
    if (!username) { alert('Введите идентификатор'); return; }
    
    state.username = username;
    localStorage.setItem('pp_username', username);
    
    try {
        if (sessionId) {
            const response = await fetch(`/api/sessions/${sessionId}`);
            if (!response.ok) throw new Error('Комната не найдена');
            const data = await response.json();
            enterSession(sessionId, data, false);
        } else {
            if (!taskText) { alert('Опишите задачу'); return; }
            const response = await fetch('/api/sessions', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username, text: taskText })
            });
            if (!response.ok) throw new Error('Ошибка создания комнаты');
            const data = await response.json();
            enterSession(data.session_id, data, true);
        }
    } catch (error) {
        alert('Ошибка: ' + error.message);
    }
}

function enterSession(sessionId, session, isInitiator) {
    state.sessionId = sessionId;
    state.isInitiator = isInitiator;
    state.wasRevealed = session.revealed;
    
    document.getElementById('joinScreen').classList.add('hidden');
    document.getElementById('sessionScreen').classList.remove('hidden');
    document.getElementById('leaveBtn').classList.remove('hidden');
    
    window.history.pushState({ sessionId }, '', `${window.location.pathname}?session=${sessionId}`);
    updateSessionDisplay(session);
    connectWebSocket(sessionId);
}

function connectWebSocket(sessionId) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    state.ws = new WebSocket(`${protocol}//${window.location.host}/ws/${sessionId}`);
    
    updateConnectionStatus('connecting');
    state.ws.onopen = () => {
        updateConnectionStatus('connected');
        state.reconnectAttempts = 0;
        state.ws.send(JSON.stringify({ type: 'join', username: state.username }));
        state.pingInterval = setInterval(() => {
            if (state.ws.readyState === WebSocket.OPEN) state.ws.send('ping');
        }, 30000);
    };
    
    state.ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            if (message.type === 'init' || message.type === 'update') updateSessionDisplay(message.data);
        } catch (e) { console.error('Parse error:', e); }
    };
    
    state.ws.onclose = () => {
        updateConnectionStatus('disconnected');
        clearInterval(state.pingInterval);
        if (state.sessionId && state.reconnectAttempts < 5) {
            state.reconnectAttempts++;
            setTimeout(() => { if (state.sessionId) connectWebSocket(state.sessionId); }, 2000 * state.reconnectAttempts);
        }
    };
}

function updateConnectionStatus(status) {
    const el = document.getElementById('connectionStatus');
    el.className = 'connection-status ' + status;
    el.textContent = { 'connected': 'ONLINE', 'disconnected': 'OFFLINE', 'connecting': 'CONNECTING' }[status] || status;
}

function updateSessionDisplay(session) {
    if (session.revealed && !state.wasRevealed) {
        document.body.classList.add('reveal-effect');
        setTimeout(() => document.body.classList.remove('reveal-effect'), 1600);
        state.wasRevealed = true;
    } else if (!session.revealed) {
        state.wasRevealed = false;
    }

    // ✅ НОВОЕ: Динамически определяем, являемся ли мы инициатором
    // Это позволяет автоматически получить/потерять права при передаче роли
    state.isInitiator = (session.initiator_id === `web_${state.username}`);

    document.getElementById('taskDisplay').innerHTML = formatTaskText(session.text);
    document.getElementById('initiatorDisplay').textContent = session.initiator_name;
    document.getElementById('sessionIdDisplay').textContent = state.sessionId;
    document.getElementById('sessionLink').textContent = `${window.location.origin}?session=${state.sessionId}`;
    
    const grid = document.getElementById('pointsGrid');
    grid.innerHTML = '';
    session.available_points.forEach(point => {
        const btn = document.createElement('button');
        btn.className = 'point-btn';
        btn.textContent = point;
        btn.onclick = () => castVote(point);
        
        const myVote = session.votes.find(v => v.user_id === `web_${state.username}`);
        if (myVote && myVote.real_point === point) {
            btn.classList.add('selected');
            state.selectedPoint = point;
        }
        grid.appendChild(btn);
    });
    
    document.getElementById('voteCount').textContent = session.vote_count;
    const averageCard = document.getElementById('averageCard');
    const resultCard = document.getElementById('resultCard');
    
    if (session.revealed && session.average > 0) {
        averageCard.style.display = 'block';
        document.getElementById('averageValue').textContent = session.average.toFixed(1);
        resultCard.style.display = 'block';
        document.getElementById('resultValue').textContent = session.average.toFixed(1);
        document.getElementById('resultLabel').textContent = 'НАЖМИТЕ, ЧТОБЫ СКОПИРОВАТЬ';
    } else {
        averageCard.style.display = 'none';
        resultCard.style.display = 'none';
    }
    
    const totalConnected = session.participants ? session.participants.filter(p => p.online).length : 0;
    const percent = totalConnected > 0 ? Math.min(100, (session.vote_count / totalConnected) * 100) : 0;
    document.getElementById('progressFill').style.width = percent + '%';
    document.getElementById('progressLabel').textContent = `${session.vote_count} / ${totalConnected} ПРОГОЛОСОВАЛО`;
    
    renderParticipants(session);
    
    // Показываем кнопку "НОВАЯ ЗАДАЧА" только для инициатора
    document.getElementById('initiatorActions').style.display = state.isInitiator ? 'flex' : 'none';
    
    // Показываем блок управления только для инициатора
    const controlCard = document.getElementById('initiatorControlCard');
    controlCard.style.display = state.isInitiator ? 'block' : 'none';
    
    const votingSection = document.getElementById('votingSection');
    votingSection.style.opacity = session.revealed ? '0.4' : '1';
    votingSection.style.pointerEvents = session.revealed ? 'none' : 'auto';
}

function renderParticipants(session) {
    let participants = session.participants || [];
    const uniqueParticipants = {};
    
    // Строгая дедупликация по user_id
    participants.forEach(p => { uniqueParticipants[p.user_id] = p; });
    let pList = Object.values(uniqueParticipants).map(p => ({ ...p, isYou: p.user_id === `web_${state.username}` }));

    // Сортировка: при вскрытии по оценке (от мин к макс), иначе онлайн первые
    if (session.revealed) {
        const getSortValue = (point) => {
            if (!point) return 999;
            if (point === '❔') return 99;
            if (point === '☕') return 100;
            return parseFloat(point) || 0;
        };
        pList.sort((a, b) => {
            const valA = a.vote ? getSortValue(a.vote.real_point) : 999;
            const valB = b.vote ? getSortValue(b.vote.real_point) : 999;
            return valA - valB;
        });
    } else {
        pList.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
    }

    const list = document.getElementById('participantsList');
    document.getElementById('participantCount').textContent = pList.length;

    if (pList.length === 0) {
        list.innerHTML = '<p class="empty-message">Ожидание подключений...</p>';
        return;
    }

    list.innerHTML = pList.map(p => {
        let voteDisplay;
        if (!p.vote) {
            voteDisplay = '<span class="vote-status pending">ОЖИДАЕТ</span>';
        } else if (!session.revealed) {
            // СТРОГО используем замаскированное значение, которое прислал бэкенд
            const suit = p.vote.point || '♠';
            voteDisplay = `<span class="vote-value masked">${suit}</span>`;
        } else {
            const point = p.vote.real_point || p.vote.point;
            voteDisplay = `<span class="vote-value revealed">${point}</span>`;
        }

        return `
            <div class="participant-item ${p.online ? 'online' : 'offline'} ${p.isYou ? 'you' : ''}">
                <div class="participant-indicator ${p.online ? 'online' : 'offline'}"></div>
                <div class="participant-info">
                    <span class="participant-name">${p.username}</span>
                    ${p.isYou ? '<span class="participant-badge">ВЫ</span>' : ''}
                </div>
                <div class="participant-vote">${voteDisplay}</div>
            </div>
        `;
    }).join('');
}

async function castVote(point) {
    if (!state.sessionId) return;
    try {
        const response = await fetch(`/api/sessions/${state.sessionId}/vote`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username: state.username, point: point })
        });
        if (!response.ok) alert('Ошибка: ' + ((await response.json()).error || 'Неизвестная ошибка'));
    } catch (error) { alert('Ошибка соединения: ' + error.message); }
}

function toggleNewTaskForm() {
    const form = document.getElementById('newTaskForm');
    form.classList.toggle('active');
    if (form.classList.contains('active')) document.getElementById('newTaskText').focus();
}

async function startNewTask() {
    const newText = document.getElementById('newTaskText').value.trim();
    if (!newText) { alert('Опишите новую задачу'); return; }
    await restartSession(newText);
    toggleNewTaskForm();
    document.getElementById('newTaskText').value = '';
}

async function restartSession(newText = null) {
    // Убран alert-подтверждение
    try {
        const payload = { username: state.username };
        if (newText) payload.new_text = newText;
        const response = await fetch(`/api/sessions/${state.sessionId}/restart`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            alert('Ошибка: ' + ((await response.json()).error || 'Неизвестная ошибка'));
            return;
        }
        // Мерцание при успешном сбросе
        document.body.classList.remove('reveal-effect', 'reset-effect');
        void document.body.offsetWidth; // force reflow для перезапуска анимации
        document.body.classList.add('reset-effect');
        setTimeout(() => document.body.classList.remove('reset-effect'), 1400);
    } catch (error) { 
        alert('Ошибка соединения: ' + error.message); 
    }
}

async function revealCards() {
    try {
        const response = await fetch(`/api/sessions/${state.sessionId}/reveal`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username: state.username })
        });
        if (!response.ok) alert('Ошибка: ' + ((await response.json()).error || 'Неизвестная ошибка'));
    } catch (error) { alert('Ошибка соединения: ' + error.message); }
}

function leaveSession() {
    if (state.ws) state.ws.close();
    state.sessionId = null; state.isInitiator = false; state.selectedPoint = null; state.wasRevealed = false;
    document.getElementById('joinScreen').classList.remove('hidden');
    document.getElementById('sessionScreen').classList.add('hidden');
    document.getElementById('leaveBtn').classList.add('hidden');
    document.getElementById('newTaskForm').classList.remove('active');
    window.history.pushState({}, '', window.location.pathname);
}

function copySessionLink() {
    navigator.clipboard.writeText(`${window.location.origin}?session=${state.sessionId}`).then(() => {
        const el = document.getElementById('sessionLink');
        const original = el.textContent;
        el.textContent = '✓ СКОПИРОВАНО';
        setTimeout(() => { el.textContent = original; }, 2000);
    }).catch(() => alert('Не удалось скопировать'));
}

function copySessionId() {
    const sessionId = state.sessionId;
    if (!sessionId) return;
    
    navigator.clipboard.writeText(sessionId).then(() => {
        const el = document.getElementById('sessionIdDisplay');
        const original = el.textContent;
        el.textContent = '✓ СКОПИРОВАНО';
        el.classList.add('copied');
        setTimeout(() => { 
            el.textContent = original; 
            el.classList.remove('copied');
        }, 2000);
    }).catch(() => alert('Не удалось скопировать'));
}

function copyResult() {
    const val = document.getElementById('resultValue').textContent;
    if (val === '-') return;
    
    // Округляем вверх до целого
    const rounded = Math.ceil(parseFloat(val));
    
    navigator.clipboard.writeText(rounded).then(() => {
        const label = document.getElementById('resultLabel');
        const original = label.textContent;
        label.textContent = '✓ СКОПИРОВАНО В БУФЕР!';
        label.style.color = 'var(--success)';
        setTimeout(() => { 
            label.textContent = original; 
            label.style.color = 'var(--text-secondary)';
        }, 2000);
    }).catch(() => alert('Не удалось скопировать'));
}