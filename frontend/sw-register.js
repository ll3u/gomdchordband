// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then((registration) => {
                console.log('ServiceWorker registration successful');
                registration.update();

                registration.addEventListener('updatefound', () => {
                    console.log('New ServiceWorker found, updating...');
                    const newWorker = registration.installing;

                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            console.log('New ServiceWorker available, activating...');
                            // 1. Tell the waiting SW to activate now
                            newWorker.postMessage({ type: 'SKIP_WAITING' });
                        }
                    });
                });
            })
            .catch((error) => {
                console.error('ServiceWorker registration failed:', error);
            });

        // 2. When the new SW takes control, reload the page
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return;
            refreshing = true;
            location.reload();
        });
    });
}

// Check if app was launched from home screen (PWA mode) (Unverändert)
if (window.matchMedia('(display-mode: standalone)').matches) {
    console.log('Running in standalone mode (PWA)');
}

// Prevent default pull-to-refresh on mobile (Deine originale Touch-Sperre, Unverändert)
window.addEventListener('touchmove', (e) => {
    if (window.scrollY <= 0) {
        e.preventDefault();
    }
}, { passive: false });
