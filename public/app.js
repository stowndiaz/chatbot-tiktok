const widgetEl = document.getElementById('widget');
const chatListEl = document.getElementById('chatList');
const heartsLayerEl = document.getElementById('heartsLayer');
const progressFillEl = document.getElementById('progressFill');
const progressMetaEl = document.getElementById('progressMeta');
const specialNoticeEl = document.getElementById('specialNotice');
const specialNoticeTextEl = document.getElementById('specialNoticeText');

const ttsQueue = [];
const specialQueue = [];

let ttsVoice = null;
let ttsReady = false;
let ttsSpeaking = false;
let specialActive = false;
let lastTopChatKey = '';

const MAX_HEARTS_ON_SCREEN = 140;
const SPECIAL_DURATION_MS = 3200;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const getChatKey = (item = {}) => `${item.uniqueId || ''}|${item.comment || ''}|${item.createdAt || ''}`;

const formatNumber = (value) => new Intl.NumberFormat('es-MX').format(Number(value || 0));

const loadVoices = () => {
    if (!('speechSynthesis' in window)) return;

    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;

    ttsVoice = voices.find((voice) => /es[-_]/i.test(voice.lang))
        || voices.find((voice) => /spanish/i.test(voice.name))
        || voices[0];

    ttsReady = true;
};

const speakWithBrowserFallback = (text) => {
    return new Promise((resolve) => {
        if (!ttsReady || !text || !('speechSynthesis' in window)) {
            resolve();
            return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        if (ttsVoice) utterance.voice = ttsVoice;
        utterance.lang = ttsVoice?.lang || 'es-MX';
        utterance.rate = 0.98;
        utterance.pitch = 1;
        utterance.onend = resolve;
        utterance.onerror = resolve;
        window.speechSynthesis.speak(utterance);
    });
};

const playAudioBlob = (blob) => {
    return new Promise((resolve, reject) => {
        const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);

        audio.onended = () => {
            URL.revokeObjectURL(audioUrl);
            resolve();
        };
        audio.onerror = () => {
            URL.revokeObjectURL(audioUrl);
            reject(new Error('No se pudo reproducir audio TTS'));
        };

        audio.play().catch((error) => {
            URL.revokeObjectURL(audioUrl);
            reject(error);
        });
    });
};

const requestAzureTTS = async (text) => {
    const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    });

    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Azure TTS fallo: ${response.status} ${details.slice(0, 120)}`);
    }

    return response.blob();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const processTTSQueue = async () => {
    if (ttsSpeaking || !ttsQueue.length) return;
    ttsSpeaking = true;

    while (ttsQueue.length) {
        const text = ttsQueue.shift();
        if (!text) continue;

        try {
            const audioBlob = await requestAzureTTS(text);
            await playAudioBlob(audioBlob);
        } catch (error) {
            console.warn(`Azure TTS intento 1 fallo: ${error.message}`);
            try {
                await sleep(220);
                const retryAudioBlob = await requestAzureTTS(text);
                await playAudioBlob(retryAudioBlob);
            } catch (retryError) {
                console.warn(`Azure TTS intento 2 fallo, usando fallback: ${retryError.message}`);
                await speakWithBrowserFallback(text);
            }
        }
    }

    ttsSpeaking = false;
};

const enqueueTTS = (text) => {
    if (!text) return;
    ttsQueue.push(text);
    if (ttsQueue.length > 30) ttsQueue.shift();
    processTTSQueue();
};

const renderChat = (messages = []) => {
    const topMessage = messages[0] || null;
    const topKey = topMessage ? getChatKey(topMessage) : '';
    const isNewTopMessage = Boolean(topKey && topKey !== lastTopChatKey);
    lastTopChatKey = topKey;

    chatListEl.innerHTML = '';

    messages.forEach((item, index) => {
        const li = document.createElement('li');
        if (index === 0 && isNewTopMessage) {
            li.classList.add('chat-new');
        } else if (index > 0) {
            li.classList.add('chat-shift');
        }

        const user = document.createElement('span');
        user.className = 'chat-user';
        user.textContent = item.uniqueId || 'viewer';

        const message = document.createElement('span');
        message.className = 'chat-message';
        message.textContent = item.comment || '';

        li.appendChild(user);
        li.appendChild(message);
        chatListEl.appendChild(li);
    });

    while (chatListEl.children.length < 12) {
        const li = document.createElement('li');
        li.textContent = '';
        chatListEl.appendChild(li);
    }
};

const updateLikeProgress = (payload = {}) => {
    const current = Number(payload.current || 0);
    const target = Math.max(Number(payload.target || 5000), 1);
    const pct = clamp((current / target) * 100, 0, 100);

    progressFillEl.style.width = `${pct}%`;
    progressMetaEl.textContent = `${formatNumber(current)} / ${formatNumber(target)}`;
};

const trimHeartNodes = () => {
    const hearts = heartsLayerEl.querySelectorAll('.heart-burst');
    if (hearts.length <= MAX_HEARTS_ON_SCREEN) return;

    const extra = hearts.length - MAX_HEARTS_ON_SCREEN;
    for (let i = 0; i < extra; i += 1) {
        hearts[i].remove();
    }
};

const spawnLikeHearts = (burst = {}) => {
    const total = clamp(Number(burst.count || 1), 1, 80);

    for (let i = 0; i < total; i += 1) {
        const heart = document.createElement('span');
        heart.className = 'heart-burst';

        const drift = (Math.random() - 0.5) * 280;
        const x = `${Math.round(30 + (Math.random() * 40))}%`;
        const travel = Math.round(500 + (Math.random() * 360));
        const duration = Math.round(1450 + (Math.random() * 1100));
        const delay = i * 34;

        heart.style.left = x;
        heart.style.fontSize = `${Math.round(44 + (Math.random() * 40))}px`;
        heart.style.setProperty('--travel', `${travel}px`);
        heart.style.setProperty('--drift', `${drift}px`);
        heart.style.animationDuration = `${duration}ms`;
        heart.style.animationDelay = `${delay}ms`;

        heart.addEventListener('animationend', () => {
            heart.remove();
        });

        heartsLayerEl.appendChild(heart);
    }

    trimHeartNodes();
};

const processSpecialQueue = async () => {
    if (specialActive || !specialQueue.length) return;

    specialActive = true;
    const event = specialQueue.shift();

    specialNoticeTextEl.textContent = event.message || 'Evento especial';
    specialNoticeEl.hidden = false;

    if (event.color) {
        widgetEl.style.setProperty('--event-color', event.color);
    }

    widgetEl.classList.add('event-active');
    chatListEl.style.opacity = '0.2';

    await sleep(SPECIAL_DURATION_MS);

    specialNoticeEl.hidden = true;
    widgetEl.classList.remove('event-active');
    chatListEl.style.opacity = '';

    specialActive = false;

    if (specialQueue.length) {
        processSpecialQueue();
    }
};

const enqueueSpecialEvent = (event = {}) => {
    if (!event.message) return;
    specialQueue.push(event);
    if (specialQueue.length > 8) {
        specialQueue.shift();
    }
    processSpecialQueue();
};

const applyInitState = (state) => {
    renderChat(state.chat || []);
    updateLikeProgress(state.likeProgress || {});
};

const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${protocol}://${window.location.host}`);

ws.addEventListener('message', (event) => {
    let message;
    try {
        message = JSON.parse(event.data);
    } catch {
        return;
    }

    switch (message.type) {
    case 'init':
        applyInitState(message.payload || {});
        break;
    case 'chat':
        renderChat(message.payload || []);
        break;
    case 'likeBurst':
        spawnLikeHearts(message.payload || {});
        break;
    case 'likeProgress':
        updateLikeProgress(message.payload || {});
        break;
    case 'specialEvent':
        enqueueSpecialEvent(message.payload || {});
        break;
    case 'tts':
        enqueueTTS(message.payload?.text || '');
        break;
    default:
        break;
    }
});

if ('speechSynthesis' in window) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
}

renderChat([]);
updateLikeProgress({ current: 0, target: 5000 });

