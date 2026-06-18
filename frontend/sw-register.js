// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then((registration) => {
                console.log('ServiceWorker registration successful');

                // Check for updates
                registration.addEventListener('updatefound', () => {
                    console.log('New ServiceWorker found, updating...');
                    const newWorker = registration.installing;

                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed') {
                            console.log('New ServiceWorker installed');
                            // Check if there's an existing controller
                            if (navigator.serviceWorker.controller) {
                                console.log('New ServiceWorker available, reloading...');
                                // You might want to show a notification here
                                // window.location.reload();
                            }
                        }
                    });
                });
            })
            .catch((error) => {
                console.error('ServiceWorker registration failed:', error);
            });
    });
}

// Check if app was launched from home screen (PWA mode)
if (window.matchMedia('(display-mode: standalone)').matches) {
    console.log('Running in standalone mode (PWA)');
}

// Prevent default pull-to-refresh on mobile
window.addEventListener('touchmove', (e) => {
    if (window.scrollY <= 0) {
        e.preventDefault();
    }
}, { passive: false });
