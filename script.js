class ClockApp {
    constructor() {
        this.timeDisplay = document.getElementById('timeDisplay');
        this.dateDisplay = document.getElementById('dateDisplay');
        this.eventSection = document.getElementById('eventSection');
        this.progressContainer = document.getElementById('progressContainer');
        this.contentWrapper = document.getElementById('contentWrapper');
        this.container = document.getElementById('container');
        
        this.events = [];
        this.secretTracks = [];
        this.isFullscreen = false;
        this.isMusicEngineInjected = false;
        this.idleTimer = null;

        this.init();
    }

    init() {
        this.setupCoreListeners();
        this.updateClock();
        this.loadEvents();
    }

    showDownloadProgressHUD(show, text = '', percent = 0) {
        let hud = document.getElementById('musicDownloadHUD');
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'musicDownloadHUD';
            hud.innerHTML = `
                <div id="hudText"></div>
                <div class="hud-progress-container">
                    <div id="hudProgressBar"></div>
                </div>
            `;
            document.body.appendChild(hud);
        }
        if (show) {
            document.getElementById('hudText').textContent = text;
            document.getElementById('hudProgressBar').style.width = `${percent}%`;
            hud.classList.add('show');
        } else {
            hud.classList.remove('show');
        }
    }

    forceFullscreen() {
        const elem = document.documentElement;
        if (!document.fullscreenElement) {
            if (elem.requestFullscreen) {
                elem.requestFullscreen().catch(err => console.log(err));
            } else if (elem.webkitRequestFullscreen) {
                elem.webkitRequestFullscreen();
            }
            this.isFullscreen = true;
        }
    }

    setupCoreListeners() {
        // Global screen taps (Blocks switching while jukebox modal is open)
        document.addEventListener('click', (e) => {
            const overlay = document.getElementById('musicOverlay');
            if (overlay && !overlay.classList.contains('hidden')) return;
            if (e.target === this.dateDisplay || this.dateDisplay.contains(e.target)) return;
            this.toggleFullscreen();
        });

        document.addEventListener('touchend', (e) => {
            const overlay = document.getElementById('musicOverlay');
            if (overlay && !overlay.classList.contains('hidden')) return;
            if (e.target === this.dateDisplay || this.dateDisplay.contains(e.target)) return;
            this.toggleFullscreen();
        }, { passive: true });

        // Lock to fullscreen immediately upon tapping date area
        this.dateDisplay.addEventListener('click', (e) => {
            e.stopPropagation();
            this.forceFullscreen();
            this.activateSecretMusicPlayer();
        });

        window.addEventListener('resize', () => this.recalculateLayout());
    }

    updateClock() {
        const now = new Date();
        const hours12 = now.getHours() % 12 || 12;
        this.timeDisplay.textContent = `${String(hours12).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        this.dateDisplay.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        
        this.updateEventState(now);

        // ----------------------------------------------------
        // 🔒 AUTOMATED FULLSCREEN ENFORCEMENT ENGINE
        // ----------------------------------------------------
        // Step 1: Check if DJ Services are running in memory
        if (this.isMusicEngineInjected) {
            const overlay = document.getElementById('musicOverlay');
            const globalAudio = document.getElementById('globalAudio');
            
            // Step 2: Determine if the UI modal is open OR if sound is actively playing
            const isUIWindowOpen = overlay && !overlay.classList.contains('hidden');
            const isMusicPlaying = globalAudio && !globalAudio.paused;

            // Step 3: If music is active, verify the current device viewport state
            if (isUIWindowOpen || isMusicPlaying) {
                // If the OS or browser dropped out of fullscreen, programmatically lock it back down
                if (!document.fullscreenElement) {
                    this.forceFullscreen();
                }
            }
        }
        // ----------------------------------------------------

        setTimeout(() => this.updateClock(), 1000);
    }

    // --- SECURE JUKEBOX HANDLER ---
    // --- SECURE JUKEBOX HANDLER (Updated for Continuous Playback) ---
    async activateSecretMusicPlayer() {
        try {
            const timestamp = Date.now();
            const response = await fetch(`tracks.json?t=${timestamp}`);
            if (response.ok) {
                const rawTracks = await response.json();
                // Explicitly sort the tracks array by sort_id ascending
                this.secretTracks = rawTracks.sort((a, b) => (a.sort_id || 0) - (b.sort_id || 0));
            }
        } catch (err) {
            console.log("App operating off network grid lines.");
        }

        if (this.isMusicEngineInjected) {
            const overlay = document.getElementById('musicOverlay');
            if (overlay) {
                overlay.classList.remove('hidden');
                this.resetIdleTimer();
            }
            if (navigator.onLine && this.secretTracks.length > 0) {
                this.verifyAndDownloadMediaAssets();
            }
            return;
        }

        this.isMusicEngineInjected = true;
        this.currentPlayingIndex = null; // Track the active position in queue

        const placeholder = document.getElementById('secretMusicModulePlaceholder');
        placeholder.innerHTML = `
            <div class="music-overlay hidden" id="musicOverlay">
                <div class="music-card">
                    <div class="music-header">
                        <h3>Ghanshyam DJ Services</h3>
                        <button class="close-btn" id="closeMusicBtn">×</button>
                    </div>
                    <div class="track-list" id="trackList"></div>
                    <div class="player-controls">
                        <audio id="globalAudio"></audio>
                        <div class="now-playing-bar">
                            <div class="artwork-frame" id="currentArtworkFrame">🎵</div>
                            <div class="now-playing-info">
                                <div id="currentTrackTitle">No track selected</div>
                                <div id="currentTrackArtist">Ready</div>
                            </div>
                        </div>
                        <div class="control-buttons">
                            <button id="playbackPlayPauseBtn" disabled>Play</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const overlay = document.getElementById('musicOverlay');
        const closeBtn = document.getElementById('closeMusicBtn');
        const playPauseBtn = document.getElementById('playbackPlayPauseBtn');
        const globalAudio = document.getElementById('globalAudio');

        overlay.classList.remove('hidden');

        // --- AUTOMATIC SEQUENCE ADVANCEMENT LOGIC ---
        globalAudio.addEventListener('ended', () => {
            // Check if there is another track left in the sorted array sequence
            if (this.currentPlayingIndex !== null && this.currentPlayingIndex + 1 < this.secretTracks.length) {
                const nextIndex = this.currentPlayingIndex + 1;
                this.playTrackAtIndex(nextIndex);
            } else {
                // End of the line: Playlist has completed, clean up structural player states
                playPauseBtn.textContent = 'Play';
                playPauseBtn.disabled = true;
                document.getElementById('currentTrackTitle').textContent = "No track selected";
                document.getElementById('currentTrackArtist').textContent = "Playlist Finished";
                document.getElementById('currentArtworkFrame').innerHTML = '🎵';
                document.querySelectorAll('.track-item').forEach(el => el.classList.remove('active'));
                this.currentPlayingIndex = null;
            }
        });

        playPauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (globalAudio.paused) {
                globalAudio.play();
                playPauseBtn.textContent = 'Pause';
            } else {
                globalAudio.pause();
                playPauseBtn.textContent = 'Play';
            }
        });

        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            overlay.classList.add('hidden');
            if (this.idleTimer) clearTimeout(this.idleTimer);
        });

        this.resetIdleTimer = () => {
            if (this.idleTimer) clearTimeout(this.idleTimer);
            this.idleTimer = setTimeout(() => overlay.classList.add('hidden'), 20000);
        };

        ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
            overlay.addEventListener(evt, () => this.resetIdleTimer(), { passive: true });
        });

        // Helper function encapsulated to safely call track loads via index pointers
        this.playTrackAtIndex = (index) => {
            const track = this.secretTracks[index];
            if (!track) return;

            this.currentPlayingIndex = index;
            const items = document.querySelectorAll('.track-item');
            
            // Highlight track row visibility status
            items.forEach(el => el.classList.remove('active'));
            if (items[index]) items[index].classList.add('active');

            if (globalAudio.src.includes(track.path)) {
                globalAudio.currentTime = 0;
            } else {
                globalAudio.src = track.path;
            }

            globalAudio.play().catch(err => console.log(err));

            document.getElementById('currentTrackTitle').textContent = track.title;
            document.getElementById('currentTrackArtist').textContent = track.author;
            
            const artFrame = document.getElementById('currentArtworkFrame');
            if (track.image) {
                artFrame.innerHTML = `<img src="${track.image}" style="width:100%;height:100%;object-fit:cover;border-radius:4px;">`;
            } else {
                artFrame.innerHTML = '🎵';
            }

            playPauseBtn.textContent = 'Pause';
            playPauseBtn.disabled = false;
            this.resetIdleTimer();
        };

        this.renderPlaylistDOM();
    }

    renderPlaylistDOM() {
        const trackListContainer = document.getElementById('trackList');
        trackListContainer.innerHTML = '';

        this.secretTracks.forEach((track, idx) => {
            const trackItem = document.createElement('div');
            trackItem.className = 'track-item';
            
            const artworkHTML = track.image 
                ? `<img src="${track.image}" alt="Cover" class="track-thumb" onerror="this.style.display='none'">`
                : `<div class="fallback-art">🎵</div>`;

            trackItem.innerHTML = `
                ${artworkHTML}
                <div class="track-details">
                    <div class="track-title">${track.title}</div>
                    <div class="track-artist">${track.author}</div>
                </div>
            `;

            trackItem.addEventListener('click', (e) => {
                e.stopPropagation();
                // Execute direct playback using unified single index configuration framework
                this.playTrackAtIndex(idx);
            });

            trackListContainer.appendChild(trackItem);
        });

        if (navigator.onLine && this.secretTracks.length > 0) {
            this.verifyAndDownloadMediaAssets();
        }
    }

    // --- FULL SERVICE WORKER AUDIO CACHE SYSTEM ---
    async verifyAndDownloadMediaAssets() {
        if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;

        try {
            const cache = await caches.open('ghanshyam-dj-v1');
            let missingAssets = [];

            // Compile the current list of media items that aren't cached yet
            for (const track of this.secretTracks) {
                const audioCached = await cache.match(track.path);
                if (!audioCached) missingAssets.push(track.path);

                if (track.image) {
                    const imgCached = await cache.match(track.image);
                    if (!imgCached) missingAssets.push(track.image);
                }
            }

            // Quietly exit if everything is fully cached
            if (missingAssets.length === 0) return;

            // Run the bottom-right progress bar for any remaining assets
            this.showDownloadProgressHUD(true, 'Calling DJ Ghanshyam on the deck..', 0);

            let completed = 0;
            const total = missingAssets.length;

            for (const url of missingAssets) {
                const response = await fetch(url);
                if (response.ok) {
                    await cache.put(url, response);
                }
                completed++;
                const progressPercent = Math.floor((completed / total) * 100);
                this.showDownloadProgressHUD(true, `Syncing tracks: ${completed}/${total}`, progressPercent);
            }

            this.showDownloadProgressHUD(true, 'System Cache Sync Complete!', 100);
            setTimeout(() => this.showDownloadProgressHUD(false), 2000);

        } catch (err) {
            console.log("Caching verification failure: ", err);
        }
    }

    // --- CSV EVENTS PARSER ---
    async loadEvents() {
        try {
            const timestamp = Date.now();
            const response = await fetch(`events.csv?t=${timestamp}`);
            if (!response.ok) return;
            const csv = await response.text();
            this.parseCSV(csv);
        } catch (error) {
            console.log('Operating fallback clock profiling.');
        }
    }

    parseCSV(csv) {
        const lines = csv.trim().split('\n');
        this.events = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(',');
            if (parts.length < 2) continue;
            try {
                this.events.push({
                    date: new Date(parts[0].replace(/^"|"$/g, '').trim()),
                    name: parts[1].replace(/^"|"$/g, '').trim(),
                    type: parts[2] ? parts[2].replace(/^"|"$/g, '').trim() : 'event'
                });
            } catch (e) {}
        }
        this.updateEventState(new Date());
    }

    getDateOnly(date) {
        const d = new Date(date); d.setHours(0, 0, 0, 0); return d.getTime();
    }

    getProgressBarCountdowns(now) {
        const today = this.getDateOnly(now);
        const countdowns = [];
        for (const event of this.events) {
            if (event.type && event.type.trim().toLowerCase() === 'progressbar') {
                const eventDate = this.getDateOnly(event.date);
                const daysUntil = Math.floor((eventDate - today) / (1000 * 60 * 60 * 24));
                const hoursUntil = Math.floor((event.date - now) / (1000 * 60 * 60));
                if (daysUntil === 0) {
                    countdowns.push({ type: 'progressbar-day', name: event.name, daysUntil: 0, hoursUntil: hoursUntil });
                } else if (daysUntil > 0 && daysUntil <= 7) {
                    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                    countdowns.push({
                        type: 'progressbar-countdown',
                        daysUntil: daysUntil,
                        hoursUntil: hoursUntil,
                        name: event.name,
                        weekday: weekdays[event.date.getDay()]
                    });
                }
            }
        }
        return countdowns.sort((a, b) => a.hoursUntil - b.hoursUntil);
    }

    updateEventState(now) {
        if (!this.events || !this.events.length) return;
        const today = this.getDateOnly(now);
        const countdowns = this.getProgressBarCountdowns(now);
        
        document.body.className = ''; 
        let eventHTML = '';
        let progressHTML = '';
        let displayedEventsCount = 0;

        for (const event of this.events) {
            const eventDate = this.getDateOnly(event.date);
            if (eventDate === today) {
                eventHTML += `<div>${event.name}</div>`;
                if (event.type.toLowerCase() === 'progressbar') document.body.classList.add('progressbar-day');
                displayedEventsCount++;
            }
        }

        for (const countdown of countdowns) {
            if (countdown.type === 'progressbar-countdown') {
                const days = countdown.daysUntil;
                const countdownText = `${days} day${days > 1 ? 's' : ''} until ${countdown.name} on ${countdown.weekday}`;
                const progress = Math.max(0, Math.min(100, ((7 * 24) - countdown.hoursUntil) / (7 * 24) * 100));
                
                progressHTML += `
                    <div class="countdown-item">
                        <div class="countdown-text">${countdownText}</div>
                        <div class="progress-bar">
                            <div class="progress-bar-fill" style="width: ${progress}%"></div>
                        </div>
                    </div>
                `;

                if (!document.body.classList.contains('progressbar-day')) {
                    if (days === 1) document.body.classList.add('progressbar-1day');
                    else if (days >= 4) document.body.classList.add('progressbar-4days');
                }
            }
        }

        this.eventSection.innerHTML = eventHTML;
        this.progressContainer.innerHTML = progressHTML;
        this.eventSection.style.fontSize = displayedEventsCount > 5 ? 'clamp(10px, 2vw, 24px)' : '';
    }

    toggleFullscreen() {
        const elem = document.documentElement;
        if (!document.fullscreenElement) {
            if (elem.requestFullscreen) elem.requestFullscreen();
            else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
            this.isFullscreen = true;
        } else {
            if (document.exitFullscreen) document.exitFullscreen();
            this.isFullscreen = false;
        }
    }

    recalculateLayout() {
        this.contentWrapper.style.height = 'auto';
        void this.contentWrapper.offsetHeight; 
        this.contentWrapper.style.height = '100%';
    }
}

// Global Service Worker Registrar
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('DJ Ghanshyam Network Worker Active Profile.'))
            .catch(err => console.log('Service Worker Failed: ', err));
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { const app = new ClockApp(); });
} else {
    const app = new ClockApp();
}