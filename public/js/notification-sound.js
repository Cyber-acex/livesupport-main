const notificationSocket = io();

function playNotificationSound() {
    // No-op: audio playback removed per request
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
