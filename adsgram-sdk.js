    (function() {
        var MAX_RETRIES = 3, retries = 0, TIMEOUT = 8000;
        window._adsgramLoadStatus = 'pending'; // pending | loaded | failed
        window._adsgramCallbacks = [];

        function onAdsgramReady() {
            window._adsgramLoadStatus = 'loaded';
            window._adsgramCallbacks.forEach(function(cb) { try { cb(); } catch(_) {} });
            window._adsgramCallbacks = [];
        }

        function loadSdk() {
            var s = document.createElement('script');
            s.src = 'https://sad.adsgram.ai/js/sad.min.js';
            s.async = true;
            var timer = setTimeout(function() {
                s.remove();
                retry();
            }, TIMEOUT);
            s.onload = function() {
                clearTimeout(timer);
                onAdsgramReady();
            };
            s.onerror = function() {
                clearTimeout(timer);
                retry();
            };
            document.head.appendChild(s);
        }

        function retry() {
            retries++;
            if (retries < MAX_RETRIES) {
                console.warn('[Adsgram] Load failed, retry ' + retries + '/' + MAX_RETRIES);
                setTimeout(loadSdk, 1500 * retries);
            } else {
                window._adsgramLoadStatus = 'failed';
                console.error('[Adsgram] SDK load failed after ' + MAX_RETRIES + ' retries');
                window._adsgramCallbacks.forEach(function(cb) { try { cb('failed'); } catch(_) {} });
                window._adsgramCallbacks = [];
            }
        }

        window.onAdsgramLoaded = function(cb) {
            if (window._adsgramLoadStatus === 'loaded') { cb(); return; }
            if (window._adsgramLoadStatus === 'failed') { cb('failed'); return; }
            window._adsgramCallbacks.push(cb);
        };

        loadSdk();
    })();