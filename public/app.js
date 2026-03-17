const chatListEl = document.getElementById('chatList');
const likesListEl = document.getElementById('likesList');
const followersCurrentEl = document.getElementById('followersCurrent');
const followersTargetEl = document.getElementById('followersTarget');
const giftToastEl = document.getElementById('giftToast');
const giftMessageEl = document.getElementById('giftMessage');
const connectionDotEl = document.getElementById('connectionDot');
const connectionTextEl = document.getElementById('connectionText');
const tachNeedleEl = document.getElementById('tachNeedle');
const tachLedsEl = document.getElementById('tachLeds');

let giftTimer = null;
let followerState = { start: 0, current: 0, target: 100 };
const ttsQueue = [];
let ttsVoice = null;
let ttsReady = false;
let ttsSpeaking = false;

const LED_COUNT = 16;
for (let i = 0; i < LED_COUNT; i += 1) {
    const led = document.createElement('div');
    led.className = 'tach-led';
    if (i >= 11 && i <= 13) led.classList.add('warn');
    if (i >= 14) led.classList.add('hot');
    tachLedsEl.appendChild(led);
}

const ledNodes = Array.from(tachLedsEl.children);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const loadVoices = () => {
    if (!('speechSynthesis' in window)) return;

    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;

    ttsVoice = voices.find((voice) => /es[-_]/i.test(voice.lang))
        || voices.find((voice) => /spanish/i.test(voice.name))
        || voices[0];

    ttsReady = true;
};

const speakNext = () => {
    if (!ttsReady || !ttsQueue.length || ttsSpeaking || !('speechSynthesis' in window)) return;

    const text = ttsQueue.shift();
    if (!text) return;

    const utterance = new SpeechSynthesisUtterance(text);
    if (ttsVoice) utterance.voice = ttsVoice;
    utterance.lang = ttsVoice?.lang || 'es-MX';
    utterance.rate = 1.02;
    utterance.pitch = 1;

    ttsSpeaking = true;
    utterance.onend = () => {
        ttsSpeaking = false;
        speakNext();
    };
    utterance.onerror = () => {
        ttsSpeaking = false;
        speakNext();
    };

    window.speechSynthesis.speak(utterance);
};

const enqueueTTS = (text) => {
    if (!text || !('speechSynthesis' in window)) return;

    ttsQueue.push(text);
    if (ttsQueue.length > 30) ttsQueue.shift();
    speakNext();
};

const renderChat = (messages = []) => {
    chatListEl.innerHTML = '';

    messages.forEach((item) => {
        const li = document.createElement('li');

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

    while (chatListEl.children.length < 4) {
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

const renderLikes = (topLikes = []) => {
    likesListEl.innerHTML = '';

    for (let i = 0; i < 5; i += 1) {
        const rowData = topLikes[i];
        const li = document.createElement('li');
        li.className = 'likes-row';

        const user = document.createElement('span');
        user.className = 'likes-user';
        user.textContent = rowData ? rowData.uniqueId : `slot ${i + 1}`;

        const count = document.createElement('span');
        count.className = 'likes-count';
        count.textContent = rowData ? rowData.likes : '--';

        li.appendChild(user);
        li.appendChild(count);
        likesListEl.appendChild(li);
    }
};

const renderFollowers = (goal) => {
    followerState = goal;
    followersCurrentEl.textContent = String(goal.current);
    followersTargetEl.textContent = String(goal.target);

    const totalRange = Math.max(goal.target - goal.start, 1);
    const progress = clamp((goal.current - goal.start) / totalRange, 0, 1);
    const activeLeds = Math.round(progress * LED_COUNT);
    const needleRotation = -110 + (220 * progress);

    tachNeedleEl.style.transform = `rotate(${needleRotation}deg)`;
    ledNodes.forEach((led, index) => {
        led.classList.toggle('active', index < activeLeds);
    });
};

const showGift = (gift) => {
    const count = gift.repeatCount > 1 ? ` x${gift.repeatCount}` : '';
    giftMessageEl.textContent = `${gift.uniqueId} envio ${gift.giftName}${count}`;
    giftToastEl.classList.remove('hidden');

    if (giftTimer) clearTimeout(giftTimer);
    giftTimer = setTimeout(() => {
        giftToastEl.classList.add('hidden');
    }, 4200);
};

const setConnectionStatus = (isLive, text) => {
    connectionDotEl.classList.toggle('live', Boolean(isLive));
    connectionTextEl.textContent = text;
};

const applyInitState = (state) => {
    renderChat(state.chat || []);
    renderLikes(state.topLikes || []);
    renderFollowers(state.followerGoal || followerState);

    if (state.lastGift) {
        showGift(state.lastGift);
    }

    const status = state.liveStatus || { connected: false };
    setConnectionStatus(status.connected, status.connected ? `LIVE room ${status.roomId || ''}`.trim() : 'Esperando LIVE...');
};

const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${protocol}://${window.location.host}`);

ws.addEventListener('open', () => {
    setConnectionStatus(false, 'Overlay conectado. Esperando LIVE...');
});

ws.addEventListener('close', () => {
    setConnectionStatus(false, 'Sin conexion al servidor');
});

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
    case 'likes':
        renderLikes(message.payload || []);
        break;
    case 'followGoal':
        renderFollowers(message.payload || followerState);
        break;
    case 'gift':
        if (message.payload) showGift(message.payload);
        break;
    case 'liveStatus': {
        const status = message.payload || {};
        setConnectionStatus(status.connected, status.connected ? `LIVE room ${status.roomId || ''}`.trim() : 'LIVE desconectado');
        break;
    }
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
renderLikes([]);
renderFollowers(followerState);
