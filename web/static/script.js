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
// ==================== TOAST NOTIFICATION SYSTEM ====================
class ToastManager {
    constructor() {
        this.container = null;
        this.queue = [];
    }
    
    init() {
        this.container = document.getElementById('toastContainer');
    }
    
    _createToast(type, title, message, duration = 4000) {
        if (!this.container) this.init();
        
        const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.setAttribute('role', 'alert');
        toast.innerHTML = `
            <div class="toast-icon">${icons[type] || 'ℹ'}</div>
            <div class="toast-body">
                <div class="toast-title">${title}</div>
                <div class="toast-message">${message}</div>
            </div>
            <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
            <div class="toast-progress" style="animation-duration: ${duration}ms;"></div>
        `;
        
        this.container.appendChild(toast);
        
        // Ограничиваем количество toast'ов на экране
        const toasts = this.container.querySelectorAll('.toast');
        if (toasts.length > 4) {
            toasts[0].remove();
        }
        
        // Автоскрытие
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.add('removing');
                setTimeout(() => toast.remove(), 250);
            }
        }, duration);
    }
    
    success(message, title = 'УСПЕХ') { this._createToast('success', title, message); }
    error(message, title = 'ОШИБКА') { this._createToast('error', title, message, 5000); }
    warning(message, title = 'ВНИМАНИЕ') { this._createToast('warning', title, message); }
    info(message, title = 'ИНФО') { this._createToast('info', title, message); }
}

// ==================== CONFIRM MODAL SYSTEM ====================
class ConfirmManager {
    constructor() {
        this.resolvePromise = null;
        this.previousFocus = null;
    }
    
    show(message, title = 'ПОДТВЕРЖДЕНИЕ', okText = 'ПОДТВЕРДИТЬ', cancelText = 'ОТМЕНА') {
        return new Promise(resolve => {
            this.resolvePromise = resolve;
            this.previousFocus = document.activeElement;
            const modal = document.getElementById('confirmModal');
            document.getElementById('confirmTitle').textContent = title;
            document.getElementById('confirmMessage').textContent = message;
            document.getElementById('confirmOkBtn').textContent = okText;
            modal.classList.remove('hidden');
            
            // Фокус на кнопку ОК для быстрых действий с клавиатуры
            setTimeout(() => document.getElementById('confirmOkBtn').focus(), 50);
        });
    }
    
    close(result) {
        const modal = document.getElementById('confirmModal');
        modal.classList.add('hidden');
        if (this.previousFocus) {
            this.previousFocus.focus();
            this.previousFocus = null;
        }
        if (this.resolvePromise) {
            this.resolvePromise(result);
            this.resolvePromise = null;
        }
    }
}

const toast = new ToastManager();
const confirmDialog = new ConfirmManager();

// Глобальная функция для модалки (используется в onclick)
function closeConfirmModal(result) {
    confirmDialog.close(result);
}

// ==================== JOIN SCREEN HELPERS ====================
const AVAILABLE_POINTS_DISPLAY = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", 
    "11", "12", "14", "16", "18", "20", "28", "40", "❔", "☕"
];
const SPECIAL_POINTS = ["❔", "☕"];
const MAX_RECENT_ROOMS = 5;

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function saveRecentRoom(sessionId, taskText) {
    let recent = JSON.parse(localStorage.getItem('pp_recent_rooms') || '[]');
    recent = recent.filter(r => r.id !== sessionId);
    recent.unshift({
        id: sessionId,
        task: taskText || 'Без описания',
        time: Date.now()
    });
    recent = recent.slice(0, MAX_RECENT_ROOMS);
    localStorage.setItem('pp_recent_rooms', JSON.stringify(recent));
}

function loadRecentRooms() {
    try {
        return JSON.parse(localStorage.getItem('pp_recent_rooms') || '[]');
    } catch {
        return [];
    }
}

function formatRecentTime(timestamp) {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин. назад`;
    if (hours < 24) return `${hours} ч. назад`;
    if (days < 7) return `${days} дн. назад`;
    return new Date(timestamp).toLocaleDateString('ru-RU');
}

function renderRecentRooms() {
    const recent = loadRecentRooms();
    const container = document.getElementById('recentRooms');
    const list = document.getElementById('recentList');
    const clearBtn = document.getElementById('clearRecentBtn');
    
    if (!recent.length) {
        clearBtn.style.display = 'none';
        list.innerHTML = '<div class="recent-empty">Здесь появятся ваши последние комнаты</div>';
        return;
    }
    
    clearBtn.style.display = 'inline-block';
    
    // Если имя есть — кнопка "▸ ВОЙТИ" (быстрый вход), иначе "ВОЙТИ"
    const hasUsername = !!state.username;
    
    list.innerHTML = recent.map(room => `
        <div class="recent-item" onclick="joinRecentRoom('${room.id}')">
            <div class="recent-info">
                <div class="recent-id">⟁ ${room.id}</div>
                <div class="recent-task">${escapeHtml(room.task)}</div>
            </div>
            <div class="recent-time">${formatRecentTime(room.time)}</div>
            <button class="recent-enter">${hasUsername ? '▸ ВОЙТИ' : 'ВОЙТИ'}</button>
        </div>
    `).join('');
}

// ✅ Новая функция очистки истории
async function clearRecentRooms() {
    const confirmed = await confirmDialog.show(
        'Вся история последних комнат будет удалена без возможности восстановления.',
        'ОЧИСТКА ИСТОРИИ',
        'ОЧИСТИТЬ',
        'ОТМЕНА'
    );
    if (!confirmed) return;
    
    localStorage.removeItem('pp_recent_rooms');
    renderRecentRooms();
    toast.info('История комнат очищена');
}

function joinRecentRoom(sessionId) {
    // Если у пользователя уже есть идентификатор — сразу подключаемся к комнате
    if (state.username) {
        document.getElementById('sessionId').value = sessionId;
        document.getElementById('taskGroup').style.display = 'none';
        joinOrCreateSession();
    } else {
        // Если имени ещё нет — подставляем ID и просим ввести имя
        document.getElementById('sessionId').value = sessionId;
        toggleTaskField();
        document.getElementById('username').focus();
        document.getElementById('username').scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast.info('Введите идентификатор и нажмите ИНИЦИАЛИЗИРОВАТЬ', 'ПОДКЛЮЧЕНИЕ');
    }
}

function renderScalePoints() {
    const container = document.getElementById('scalePoints');
    if (!container) return;
    container.innerHTML = AVAILABLE_POINTS_DISPLAY.map(point => {
        const isSpecial = SPECIAL_POINTS.includes(point);
        return `<div class="scale-point ${isSpecial ? 'special' : ''}">${point}</div>`;
    }).join('');
}

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
    
    // Рендерим превью шкалы и последние комнаты
    renderScalePoints();
    renderRecentRooms();
    
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
    
    // Escape closes modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.getElementById('confirmModal').classList.contains('hidden')) {
            closeConfirmModal(false);
        }
    });
});

async function joinOrCreateSession() {
    const username = document.getElementById('username').value.trim();
    const sessionId = document.getElementById('sessionId').value.trim();
    const taskText = document.getElementById('taskText').value.trim();
    
    if (!username) { 
        toast.warning('Введите идентификатор пользователя');
        document.getElementById('username').focus();
        return; 
    }
    
    state.username = username;
    localStorage.setItem('pp_username', username);
    
    const btn = document.querySelector('.btn-primary');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = '...';
    
    try {
        if (sessionId) {
            const response = await fetch(`/api/sessions/${sessionId}`);
            if (!response.ok) throw new Error('Комната не найдена');
            const data = await response.json();
            // ✅ Определяем, являемся ли мы инициатором из данных сервера
            const isMeInitiator = data.initiator_id === `web_${username}`;
            enterSession(sessionId, data, isMeInitiator);
            toast.success(
                isMeInitiator ? 'С возвращением, оператор!' : 'Подключение к комнате установлено',
                isMeInitiator ? 'ОПЕРАТОР' : 'ПОДКЛЮЧЕНИЕ'
            );
        } else {
            if (!taskText) { 
                toast.warning('Опишите задачу для оценки');
                document.getElementById('taskText').focus();
                return; 
            }
            const response = await fetch('/api/sessions', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username, text: taskText })
            });
            if (!response.ok) throw new Error('Ошибка создания комнаты');
            const data = await response.json();
            enterSession(data.session_id, data, true);
            toast.success('Комната создана. Готовы к оценке!');
        }
    } catch (error) {
        toast.error(error.message, 'НЕ УДАЛОСЬ');
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.textContent = originalText;
    }
}

function enterSession(sessionId, session, isInitiator) {
    state.sessionId = sessionId;
    state.isInitiator = isInitiator;
    state.wasRevealed = session.revealed;
    
    // ✅ НОВОЕ: Сохраняем комнату в историю
    saveRecentRoom(sessionId, session.text);
    
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
    state.isInitiator = (session.initiator_id === `web_${state.username}`);

    if (session.revealed && !state.wasRevealed) {
        document.body.classList.add('reveal-effect');
        setTimeout(() => document.body.classList.remove('reveal-effect'), 1600);
        state.wasRevealed = true;
        
        soundManager.playReveal();
    } else if (!session.revealed) {
        state.wasRevealed = false;
    }

    document.getElementById('taskDisplay').innerHTML = formatTaskText(session.text);
    document.getElementById('initiatorDisplay').textContent = session.initiator_name;
    document.getElementById('sessionIdDisplay').textContent = state.sessionId;
    
    const grid = document.getElementById('pointsGrid');
    grid.innerHTML = '';
    session.available_points.forEach(point => {
        const btn = document.createElement('button');
        btn.className = 'point-btn';
        btn.textContent = point;
        btn.setAttribute('data-point', point);
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

    // Сортировка
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

    // ✅ НОВОЕ: Считаем мин/макс для подсветки
    let minPoint = null;
    let maxPoint = null;
    let hasVariation = false;
    
    if (session.revealed) {
        const numericPoints = pList
            .map(p => p.vote?.real_point)
            .filter(p => p && p !== '❔' && p !== '☕')
            .map(p => parseFloat(p))
            .filter(p => !isNaN(p));
        
        const uniqueNumeric = [...new Set(numericPoints)];
        hasVariation = uniqueNumeric.length > 1;
        
        if (hasVariation) {
            minPoint = Math.min(...uniqueNumeric);
            maxPoint = Math.max(...uniqueNumeric);
        }
    }

    const grid = document.getElementById('participantsList');
    document.getElementById('participantCount').textContent = pList.length;

    if (pList.length === 0) {
        grid.innerHTML = '<p class="empty-message">Ожидание подключений...</p>';
        return;
    }

    grid.innerHTML = pList.map(p => {
        let voteDisplay;
        if (!p.vote) {
            voteDisplay = '<span class="vote-status pending">ОЖИДАЕТ</span>';
        } else if (!session.revealed) {
            const suit = p.vote.point || '♠';
            voteDisplay = `<span class="vote-value masked">${suit}</span>`;
        } else {
            const point = p.vote.real_point || p.vote.point;
            
            // ✅ Определяем класс мин/макс
            let extraClass = '';
            if (hasVariation && point !== '❔' && point !== '☕') {
                const numPoint = parseFloat(point);
                if (!isNaN(numPoint)) {
                    if (numPoint === minPoint) extraClass = ' min';
                    else if (numPoint === maxPoint) extraClass = ' max';
                }
            }
            
            voteDisplay = `<span class="vote-value revealed${extraClass}">${point}</span>`;
        }

        return `
            <div class="participant-card ${p.online ? 'online' : 'offline'} ${p.isYou ? 'you' : ''}">
                <div class="participant-card-header">
                    <div class="participant-indicator ${p.online ? 'online' : 'offline'}"></div>
                    <span class="participant-name" title="${p.username}">${p.username}</span>
                    ${p.isYou ? '<span class="participant-badge">ВЫ</span>' : ''}
                </div>
                <div class="participant-vote-area">
                    ${voteDisplay}
                </div>
            </div>
        `;
    }).join('');
}

async function castVote(point) {
    if (!state.sessionId) return;
    const btn = document.querySelector(`.point-btn[data-point="${point}"]`);
    if (btn) {
        document.querySelectorAll('.point-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
    }
    try {
        const response = await fetch(`/api/sessions/${state.sessionId}/vote`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username: state.username, point: point })
        });
        if (!response.ok) {
            const err = await response.json();
            toast.error(err.error || 'Неизвестная ошибка', 'ОШИБКА ГОЛОСА');
            if (btn) btn.classList.remove('selected');
        } else {
            soundManager.playVote();
        }
    } catch (error) { 
        toast.error(error.message, 'НЕТ СВЯЗИ');
        if (btn) btn.classList.remove('selected');
    }
}

function toggleNewTaskForm() {
    const form = document.getElementById('newTaskForm');
    form.classList.toggle('active');
    if (form.classList.contains('active')) document.getElementById('newTaskText').focus();
}

async function startNewTask() {
    const newText = document.getElementById('newTaskText').value.trim();
    if (!newText) { 
        toast.warning('Опишите новую задачу');
        document.getElementById('newTaskText').focus();
        return; 
    }
    const btn = document.querySelector('#newTaskForm .btn-primary');
    if (btn) btn.disabled = true;
    await restartSession(newText);
    toggleNewTaskForm();
    document.getElementById('newTaskText').value = '';
    if (btn) btn.disabled = false;
}

async function restartSession(newText = null) {
    // Для сброса без новой задачи - запрашиваем подтверждение
    if (!newText) {
        const confirmed = await confirmDialog.show(
            'Все текущие голоса будут сброшены. Продолжить?',
            'СБРОС ГОЛОСОВ',
            'СБРОСИТЬ',
            'ОТМЕНА'
        );
        if (!confirmed) return;
    }
    
    const btn = document.querySelector('.btn-warning');
    if (btn) btn.disabled = true;
    
    try {
        const payload = { username: state.username };
        if (newText) payload.new_text = newText;
        const response = await fetch(`/api/sessions/${state.sessionId}/restart`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const err = await response.json();
            toast.error(err.error || 'Неизвестная ошибка', 'НЕ УДАЛОСЬ');
            return;
        }
        
        soundManager.playReset();
        toast.info('Голосование перезапущено');
        
        document.body.classList.remove('reveal-effect', 'reset-effect');
        void document.body.offsetWidth;
        document.body.classList.add('reset-effect');
        setTimeout(() => document.body.classList.remove('reset-effect'), 1400);
    } catch (error) { 
        toast.error(error.message, 'НЕТ СВЯЗИ');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function revealCards() {
    const btn = document.querySelector('.btn-success');
    btn.disabled = true;
    try {
        const response = await fetch(`/api/sessions/${state.sessionId}/reveal`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username: state.username })
        });
        if (!response.ok) {
            const err = await response.json();
            toast.error(err.error || 'Неизвестная ошибка', 'НЕ УДАЛОСЬ ОТКРЫТЬ');
        }
    } catch (error) { 
        toast.error(error.message, 'НЕТ СВЯЗИ');
    } finally {
        btn.disabled = false;
    }
}

function leaveSession() {
    if (state.ws) state.ws.close();
    state.sessionId = null; 
    state.isInitiator = false; 
    state.selectedPoint = null; 
    state.wasRevealed = false;
    
    document.getElementById('joinScreen').classList.remove('hidden');
    document.getElementById('sessionScreen').classList.add('hidden');
    document.getElementById('leaveBtn').classList.add('hidden');
    document.getElementById('newTaskForm').classList.remove('active');
    
    // ✅ НОВОЕ: Очищаем форму подключения
    document.getElementById('sessionId').value = '';
    document.getElementById('taskText').value = '';
    document.getElementById('taskGroup').style.display = 'block';
    
    // ✅ НОВОЕ: Обновляем историю комнат при возвращении
    renderRecentRooms();
    
    window.history.pushState({}, '', window.location.pathname);
    
    // Прокручиваем joinScreen наверх, чтобы было видно заголовок
    document.getElementById('joinScreen').scrollTop = 0;
    document.getElementById('username').focus();
}

function copySessionLink() {
    navigator.clipboard.writeText(`${window.location.origin}?session=${state.sessionId}`).then(() => {
        toast.success('Ссылка на комнату скопирована', 'ССЫЛКА');
    }).catch(() => toast.error('Не удалось скопировать ссылку'));
}

function copySessionId(event) {
    // ✅ Останавливаем всплытие, чтобы не сработал обработчик родителя
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    
    const sessionId = state.sessionId;
    if (!sessionId) return;
    
    navigator.clipboard.writeText(sessionId).then(() => {
        const el = document.getElementById('sessionIdDisplay');
        const original = el.textContent;
        el.textContent = '✓ СКОПИРОВАНО';
        el.classList.add('copied');
        toast.success('ID комнаты скопирован', 'КОМНАТА');
        setTimeout(() => { 
            el.textContent = original; 
            el.classList.remove('copied');
        }, 2000);
    }).catch(() => toast.error('Не удалось скопировать ID'));
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
        toast.success(`Оценка ${rounded} скопирована`, 'РЕЗУЛЬТАТ');
        setTimeout(() => { 
            label.textContent = original; 
            label.style.color = 'var(--text-secondary)';
        }, 2000);
    }).catch(() => toast.error('Не удалось скопировать результат'));
}