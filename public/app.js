const chatListEl = document.getElementById('chatList');
const heartsLayerEl = document.getElementById('heartsLayer');

const ttsQueue = [];
let ttsVoice = null;
let ttsReady = false;
let ttsSpeaking = false;
let lastTopChatKey = '';

const MAX_HEARTS_ON_SCREEN = 140;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const getChatKey = (item = {}) => `${item.uniqueId || ''}|${item.comment || ''}|${item.createdAt || ''}`;

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
        const user = document.createElement('span');
        user.className = 'chat-user';
        user.textContent = '---';
        const message = document.createElement('span');
        message.className = 'chat-message';
        message.textContent = '';
        li.appendChild(user);
        li.appendChild(message);
        chatListEl.appendChild(li);
    }
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
    const source = burst.source === 'youtube' ? 'youtube' : 'tiktok';
    const total = clamp(Number(burst.count || 1), 1, 80);
    const travelMin = source === 'youtube' ? 700 : 540;
    const travelMax = source === 'youtube' ? 1020 : 800;
    const heartSize = source === 'youtube' ? 120 : 76;
    const durationMin = source === 'youtube' ? 2400 : 1700;
    const durationMax = source === 'youtube' ? 3400 : 2500;
    const lane = source === 'youtube' ? 0.35 : 0.68;

    for (let i = 0; i < total; i += 1) {
        const heart = document.createElement('span');
        heart.className = `heart-burst ${source}`;

        const drift = (Math.random() - 0.5) * 260;
        const spread = (Math.random() - 0.5) * 160;
        const x = `${(lane * 100) + spread / 10}%`;
        const travel = Math.round(travelMin + (Math.random() * (travelMax - travelMin)));
        const duration = Math.round(durationMin + (Math.random() * (durationMax - durationMin)));
        const delay = i * (source === 'youtube' ? 55 : 40);

        heart.style.left = x;
        heart.style.fontSize = `${Math.round(heartSize + ((Math.random() - 0.5) * 16))}px`;
        heart.style.setProperty('--travel', `${travel}px`);
        heart.style.setProperty('--drift', `${drift}px`);
        heart.style.animationDuration = `${duration}ms`;
        heart.style.animationDelay = `${delay}ms`;

        if (i === 0 && burst.avatarUrl) {
            const avatar = document.createElement('img');
            avatar.className = 'heart-avatar';
            avatar.src = burst.avatarUrl;
            avatar.alt = burst.uniqueId || source;
            avatar.loading = 'lazy';
            heart.appendChild(avatar);
        }

        heart.addEventListener('animationend', () => {
            heart.remove();
        });

        heartsLayerEl.appendChild(heart);
    }

    trimHeartNodes();
};

const applyInitState = (state) => {
    renderChat(state.chat || []);
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
