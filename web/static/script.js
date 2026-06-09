let state = {
    username: localStorage.getItem('pp_username') || '',
    sessionId: null,
    isInitiator: false,
    selectedPoint: null,
    ws: null,
    reconnectAttempts: 0,
    wasRevealed: false,
    soundEnabled: localStorage.getItem('pp_sound_enabled') !== 'false'
};

// ==================== SOUND MANAGER ====================
class SoundManager {
    constructor() {
        this.audioContext = null;
        this.enabled = true;
    }
    
    init() {
        if (!this.audioContext) {
            try {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                console.warn('Web Audio API not supported');
            }
        }
    }
    
    // Звук вскрытия карт - восходящая мелодия
    playReveal() {
        if (!this.enabled || !this.audioContext) return;
        
        const now = this.audioContext.currentTime;
        const notes = [523.25, 659.25, 783.99, 1046.50];
        
        notes.forEach((freq, i) => {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.frequency.value = freq;
            oscillator.type = 'sine';
            
            gainNode.gain.setValueAtTime(0, now + i * 0.1);
            gainNode.gain.linearRampToValueAtTime(0.3, now + i * 0.1 + 0.05);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + i * 0.1 + 0.3);
            
            oscillator.start(now + i * 0.1);
            oscillator.stop(now + i * 0.1 + 0.3);
        });
    }
    
    // Звук нового голоса - короткий бип
    playVote() {
        if (!this.enabled || !this.audioContext) return;
        
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        oscillator.frequency.value = 880;
        oscillator.type = 'sine';
        
        const now = this.audioContext.currentTime;
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.2, now + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        
        oscillator.start(now);
        oscillator.stop(now + 0.15);
    }
    
    // Звук сброса - нисходящий тон
    playReset() {
        if (!this.enabled || !this.audioContext) return;
        
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        oscillator.type = 'sawtooth';
        
        const now = this.audioContext.currentTime;
        oscillator.frequency.setValueAtTime(600, now);
        oscillator.frequency.exponentialRampToValueAtTime(200, now + 0.3);
        
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.15, now + 0.02);
        gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        
        oscillator.start(now);
        oscillator.stop(now + 0.3);
    }
    
    // ✅ НОВОЕ: Звук входа - восходящий двутоновый "приветственный"
    playJoin() {
        if (!this.enabled || !this.audioContext) return;
        
        const now = this.audioContext.currentTime;
        const notes = [659.25, 880]; // E5 -> A5
        
        notes.forEach((freq, i) => {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.frequency.value = freq;
            oscillator.type = 'sine';
            
            gainNode.gain.setValueAtTime(0, now + i * 0.12);
            gainNode.gain.linearRampToValueAtTime(0.18, now + i * 0.12 + 0.02);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + i * 0.12 + 0.2);
            
            oscillator.start(now + i * 0.12);
            oscillator.stop(now + i * 0.12 + 0.2);
        });
    }
    
    // ✅ НОВОЕ: Звук выхода - нисходящий двутоновый "прощальный"
    playLeave() {
        if (!this.enabled || !this.audioContext) return;
        
        const now = this.audioContext.currentTime;
        const notes = [880, 659.25]; // A5 -> E5
        
        notes.forEach((freq, i) => {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.frequency.value = freq;
            oscillator.type = 'sine';
            
            gainNode.gain.setValueAtTime(0, now + i * 0.12);
            gainNode.gain.linearRampToValueAtTime(0.18, now + i * 0.12 + 0.02);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + i * 0.12 + 0.2);
            
            oscillator.start(now + i * 0.12);
            oscillator.stop(now + i * 0.12 + 0.2);
        });
    }
    
    setEnabled(enabled) {
        this.enabled = enabled;
        if (enabled && !this.audioContext) {
            this.init();
        }
    }
}

const soundManager = new SoundManager();

// ==================== EXISTING CODE ====================

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

function toggleSound() {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('pp_sound_enabled', state.soundEnabled);
    soundManager.setEnabled(state.soundEnabled);
    updateSoundButton();
    
    if (state.soundEnabled) {
        soundManager.init();
        soundManager.playVote();
    }
}

function updateSoundButton() {
    const btn = document.querySelector('.sound-btn');
    const icon = document.getElementById('soundIcon');
    const text = document.getElementById('soundText');
    
    if (!btn) return;
    
    if (state.soundEnabled) {
        btn.classList.remove('muted');
        icon.textContent = '🔊';
        if (text) text.textContent = 'ЗВУК';
    } else {
        btn.classList.add('muted');
        icon.textContent = '🔇';
        if (text) text.textContent = 'ТИХО';
    }
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
    updateSoundButton();
    
    // ✅ Инициализируем AudioContext только если звук включен (по умолчанию)
    if (state.soundEnabled) {
        // AudioContext создается при первом клике пользователя (требование браузеров)
        document.addEventListener('click', function initAudioOnce() {
            soundManager.init();
            document.removeEventListener('click', initAudioOnce);
        }, { once: true });
    }
    soundManager.setEnabled(state.soundEnabled);
    
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
            
            // ✅ НОВОЕ: Обработка входа/выхода участников
            if (message.type === 'user_joined') {
                // Не играем звук для собственного входа
                if (message.username !== state.username) {
                    soundManager.playJoin();
                }
                updateSessionDisplay(message.data);
            } else if (message.type === 'user_left') {
                soundManager.playLeave();
                updateSessionDisplay(message.data);
            } else if (message.type === 'init' || message.type === 'update') {
                const prevVoteCount = document.getElementById('voteCount').textContent;
                updateSessionDisplay(message.data);
                
                const newVoteCount = message.data.vote_count;
                if (message.type === 'update' && newVoteCount > prevVoteCount) {
                    soundManager.playVote();
                }
            }
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
        
        soundManager.playReveal();
    } else if (!session.revealed) {
        state.wasRevealed = false;
    }

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
    
    document.getElementById('initiatorActions').style.display = state.isInitiator ? 'flex' : 'none';
    
    const controlCard = document.getElementById('initiatorControlCard');
    controlCard.style.display = state.isInitiator ? 'block' : 'none';
    
    const votingSection = document.getElementById('votingSection');
    votingSection.style.opacity = session.revealed ? '0.4' : '1';
    votingSection.style.pointerEvents = session.revealed ? 'none' : 'auto';
}

function renderParticipants(session) {
    let participants = session.participants || [];
    const uniqueParticipants = {};
    
    participants.forEach(p => { uniqueParticipants[p.user_id] = p; });
    let pList = Object.values(uniqueParticipants).map(p => ({ ...p, isYou: p.user_id === `web_${state.username}` }));

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
        if (!response.ok) {
            alert('Ошибка: ' + ((await response.json()).error || 'Неизвестная ошибка'));
        } else {
            soundManager.playVote();
        }
    } catch (error) { 
        alert('Ошибка соединения: ' + error.message); 
    }
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
        
        soundManager.playReset();
        
        document.body.classList.remove('reveal-effect', 'reset-effect');
        void document.body.offsetWidth;
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