const notificationSocket = io();

function playNotificationSound() {
    // No-op: audio playback removed per request
}

function playHandoffAudio() {
    const audio = new Audio('/uploads/handoff.mp3');
    audio.volume = 0.7; // Set volume to 70%
    audio.play().catch(error => {
        console.log('Failed to play handoff audio:', error);
    });
}

function notifyDesktop(message, title = 'LiveSupport') {
    if (localStorage.getItem('msgAlert') !== 'true') return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(title, {
        body: message,
        icon: '/favicon.ico'
    });
}

notificationSocket.on('newMessage', msg => {
    if (localStorage.getItem('soundAlert') === 'true') {
        playNotificationSound();
    }

    if (msg && localStorage.getItem('msgAlert') === 'true' && !document.hasFocus()) {
        notifyDesktop(msg.message || 'You have a new customer message.', 'LiveSupport - New Message');
    }
});

notificationSocket.on('handoffAlert', () => {
    if (localStorage.getItem('msgAlert') === 'true' && !document.hasFocus()) {
        notifyDesktop('AI has handed off the chat to staff.', 'LiveSupport - Handoff Alert');
    }
});

notificationSocket.on('playHandoffAudio', (data) => {
    console.log('Playing handoff audio for conversation:', data.conversationId);
    playHandoffAudio();
});
