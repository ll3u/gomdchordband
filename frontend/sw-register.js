// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // KORRIGIERT: Der Zeitstempel bricht das Go-HTTP-Caching beim Registrieren auf
        navigator.serviceWorker.register(`/sw.js?t=${Date.now()}`)
            .then((registration) => {
                console.log('ServiceWorker registration successful');

                // NEU: Zwingt den Browser bei jedem App-Start, die sw.js im Hintergrund zu prüfen
                registration.update();

                // Check for updates (Deine originale Update-Logik, vollkommen unangetastet)
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
