history.scrollRestoration = 'manual';

document.addEventListener('DOMContentLoaded', () => {
    fetchData();
    updateAuthUI();
});

let conferenceData = null;
let savedSessionIds = new Set(JSON.parse(localStorage.getItem('dhd2026_saved_sessions')) || []);
let savedPosterIds = new Set(JSON.parse(localStorage.getItem('dhd2026_saved_posters')) || []);
let savedTalkIds = new Set(JSON.parse(localStorage.getItem('dhd2026_saved_talks')) || []);
let currentTab = 'all'; // 'all' or 'my'
let currentDay = null; // null means show all days, or index into conferenceData.days
let currentTimeSlot = null; // null means show all time slots, or a time slot string like "9:00-12:30"

// Time slots per day (keyed by date)
const TIME_SLOTS = {
    '2026-02-24': ['9:00\u201312:30', '9:00\u201317:30', '14:00\u201317:30', 'ab 18:00'],
    '2026-02-25': ['9:00\u201310:30', '11:00\u201312:30', '12:30\u201314:00', '14:00\u201315:30', '16:00\u201318:00'],
    '2026-02-26': ['9:00\u201310:30', '11:00\u201312:30', '12:30\u201314:00', '14:00\u201315:30', '16:00\u201317:30', 'ab 18:00'],
    '2026-02-27': ['9:00\u201310:30', '11:00\u201312:30', 'ab 14:00']
};
let currentUser = null; // username if logged in
let currentAuthMode = 'login'; // 'login' or 'register'

// --- Utility: escape HTML to prevent XSS ---
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

async function fetchData() {
    try {
        const response = await fetch('dhd2026_programm.json');
        const data = await response.json();
        conferenceData = data;
        buildDayFilterBar();
        buildTimeFilterBar();
        buildPersonIndex();
        render();

        // Validate server session if user was previously logged in
        const storedUser = localStorage.getItem('dhd2026_user');
        if (storedUser) {
            try {
                const meResp = await fetch('/api/me');
                if (meResp.ok) {
                    const meData = await meResp.json();
                    currentUser = meData.username;
                    // Merge server bookmarks with local bookmarks
                    if (meData.saved_sessions && meData.saved_sessions.length > 0) {
                        mergeBookmarks(meData.saved_sessions, meData.saved_posters, meData.saved_talks);
                    }
                    updateAuthUI();
                    render();
                } else {
                    // Session expired or invalid — clean up
                    localStorage.removeItem('dhd2026_user');
                }
            } catch (e) {
                // Server unreachable — keep local-only mode
                localStorage.removeItem('dhd2026_user');
            }
        }

        navigateToHash();

    } catch (error) {
        console.error('Error loading schedule:', error);
        const container = document.getElementById('app-content');
        if (container) container.innerHTML = '<p class="empty-state">Fehler beim Laden der Daten.</p>';
    }
}

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.main-nav .nav-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`btn-${tab}`).classList.add('active');

    // Show login hint only on "my" tab AND if not logged in
    const hint = document.getElementById('login-hint');
    if (tab === 'my' && !currentUser) {
        hint.classList.remove('hidden');
    } else {
        hint.classList.add('hidden');
    }

    render();
}

// --- Auth Functions ---

function openLoginModal() {
    document.getElementById('auth-modal').classList.remove('hidden');
    switchAuthMode('login');
}

function closeAuthModal() {
    document.getElementById('auth-modal').classList.add('hidden');
    document.getElementById('auth-error').textContent = '';
    document.getElementById('auth-error').className = 'error-msg';
    document.getElementById('auth-form').reset();
}

function switchAuthMode(mode) {
    currentAuthMode = mode;
    document.getElementById('tab-login').classList.toggle('active', mode === 'login');
    document.getElementById('tab-register').classList.toggle('active', mode === 'register');
    document.getElementById('auth-submit-btn').textContent = mode === 'login' ? 'Einloggen' : 'Registrieren';
    document.getElementById('auth-error').textContent = '';
    document.getElementById('auth-error').className = 'error-msg';
}

async function handleAuth(event) {
    event.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorMsg = document.getElementById('auth-error');

    const endpoint = currentAuthMode === 'login' ? '/api/login' : '/api/register';

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Ein Fehler ist aufgetreten.');
        }

        if (currentAuthMode === 'register') {
             switchAuthMode('login');
             errorMsg.textContent = 'Registrierung erfolgreich. Bitte einloggen.';
             errorMsg.className = 'error-msg success-msg';
        } else {
            // Login successful
            currentUser = username;
            localStorage.setItem('dhd2026_user', username);

            // Merge server bookmarks with local bookmarks (union of both)
            if (data.saved_sessions && Array.isArray(data.saved_sessions)) {
                mergeBookmarks(data.saved_sessions, data.saved_posters, data.saved_talks);
            } else {
                await syncProgram();
            }

            closeAuthModal();
            updateAuthUI();
            render();
        }
    } catch (err) {
        errorMsg.textContent = err.message;
        errorMsg.className = 'error-msg';
    }
}

async function logout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (e) {
        // Logout from UI regardless
    }
    currentUser = null;
    localStorage.removeItem('dhd2026_user');
    updateAuthUI();
    render();
}

function updateAuthUI() {
    const hint = document.getElementById('login-hint');
    const menuLogin = document.getElementById('menu-login');
    const menuUser = document.getElementById('menu-user');
    const menuLogout = document.getElementById('menu-logout');
    const menuUsername = document.getElementById('menu-username');

    if (currentUser) {
        menuLogin.classList.add('hidden');
        menuUser.classList.remove('hidden');
        menuLogout.classList.remove('hidden');
        menuUsername.textContent = currentUser;
        hint.classList.add('hidden');
    } else {
        menuLogin.classList.remove('hidden');
        menuUser.classList.add('hidden');
        menuLogout.classList.add('hidden');
    }
}

async function syncProgram() {
    if (!currentUser) return;
    try {
        const resp = await fetch('/api/save_program', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessions: [...savedSessionIds],
                posters: [...savedPosterIds],
                talks: [...savedTalkIds]
            })
        });
        if (!resp.ok) {
            showSyncError();
        }
    } catch (e) {
        console.error("Sync failed", e);
        showSyncError();
    }
}

function mergeBookmarks(serverSessions, serverPosters, serverTalks) {
    for (const id of serverSessions) {
        savedSessionIds.add(id);
    }
    localStorage.setItem('dhd2026_saved_sessions', JSON.stringify([...savedSessionIds]));
    if (serverPosters) {
        for (const id of serverPosters) {
            savedPosterIds.add(id);
        }
        localStorage.setItem('dhd2026_saved_posters', JSON.stringify([...savedPosterIds]));
    }
    if (serverTalks) {
        for (const id of serverTalks) {
            savedTalkIds.add(id);
        }
        localStorage.setItem('dhd2026_saved_talks', JSON.stringify([...savedTalkIds]));
    }
    syncProgram();
}

function showSyncError() {
    const existing = document.getElementById('sync-error-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'sync-error-toast';
    toast.className = 'toast';
    toast.innerHTML = '';

    const content = document.createElement('div');
    content.className = 'toast-content';

    const icon = document.createElement('span');
    icon.className = 'material-icons info-icon';
    icon.style.color = '#ff5252';
    icon.textContent = 'cloud_off';
    content.appendChild(icon);

    const p = document.createElement('p');
    p.textContent = 'Speichern fehlgeschlagen. Änderungen sind nur lokal gespeichert.';
    content.appendChild(p);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => toast.remove());
    content.appendChild(closeBtn);

    toast.appendChild(content);
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 5000);
}

function shareSession(title, time, location, anchor) {
    const url = anchor
        ? `${window.location.origin}${window.location.pathname}#${encodeURIComponent(anchor)}`
        : `${window.location.origin}${window.location.pathname}`;
    const textParts = [title];
    if (time) textParts.push(time);
    if (location) textParts.push(location);
    const text = textParts.join(' – ') + ' #DHd2026';

    if (navigator.share) {
        navigator.share({ title, text, url }).catch(() => {});
    } else {
        navigator.clipboard.writeText(url).then(() => {
            showCopyToast();
        }).catch(() => {
            showCopyToast(url);
        });
    }
}

function showCopyToast(fallbackUrl) {
    const existing = document.getElementById('copy-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'copy-toast';
    toast.className = 'toast';

    const content = document.createElement('div');
    content.className = 'toast-content';

    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.textContent = fallbackUrl ? 'info' : 'check_circle';
    content.appendChild(icon);

    const p = document.createElement('p');
    p.textContent = fallbackUrl
        ? `Link: ${fallbackUrl}`
        : 'Link in die Zwischenablage kopiert';
    content.appendChild(p);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => toast.remove());
    content.appendChild(closeBtn);

    toast.appendChild(content);
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function createShareButton(title, time, location, sid) {
    const btn = document.createElement('button');
    btn.className = 'btn-share';
    btn.title = 'Teilen';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        shareSession(title, time, location, sid);
    });
    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.textContent = 'share';
    btn.appendChild(icon);
    return btn;
}

function buildDayFilterBar() {
    const bar = document.getElementById('day-filter-bar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!conferenceData) return;

    conferenceData.days.forEach((day, idx) => {
        const btn = document.createElement('button');
        btn.className = 'day-btn' + (currentDay === idx ? ' active' : '');
        // Show short label like "Mo 23."
        const d = new Date(day.date + 'T00:00:00');
        const weekdays = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
        btn.textContent = `${weekdays[d.getDay()]} ${d.getDate()}.`;
        btn.addEventListener('click', () => {
            currentDay = (currentDay === idx) ? null : idx;
            currentTimeSlot = null;
            buildDayFilterBar();
            buildTimeFilterBar();
            render();
        });
        bar.appendChild(btn);
    });
}

function buildTimeFilterBar() {
    const bar = document.getElementById('time-filter-bar');
    const content = document.getElementById('app-content');
    if (!bar || !content) return;
    bar.innerHTML = '';

    if (currentDay === null || !conferenceData) {
        bar.classList.add('hidden');
        content.classList.remove('has-time-bar');
        return;
    }

    const dayDate = conferenceData.days[currentDay].date;
    const slots = TIME_SLOTS[dayDate];

    if (!slots) {
        bar.classList.add('hidden');
        content.classList.remove('has-time-bar');
        return;
    }

    bar.classList.remove('hidden');
    content.classList.add('has-time-bar');

    slots.forEach(slot => {
        const btn = document.createElement('button');
        btn.className = 'time-btn' + (currentTimeSlot === slot ? ' active' : '');
        btn.textContent = slot;
        btn.addEventListener('click', () => {
            currentTimeSlot = (currentTimeSlot === slot) ? null : slot;
            buildTimeFilterBar();
            render();
        });
        bar.appendChild(btn);
    });
}

function parseTime(str) {
    const [h, m] = str.split(':').map(Number);
    return h * 60 + m;
}

// Days where time filters should use exact match instead of overlap
const EXACT_MATCH_DAYS = new Set(['2026-02-24']);

function sessionMatchesTimeSlot(session, slot, dayDate) {
    if (!slot) return true;
    const sessionTime = session.time || '';
    const parts = sessionTime.split('\u2013');
    const sessionStart = parseTime(parts[0].trim());
    const sessionEnd = parts.length === 2 ? parseTime(parts[1].trim()) : sessionStart;

    if (slot.startsWith('ab ')) {
        const slotStart = parseTime(slot.substring(3));
        return sessionStart >= slotStart;
    }

    const slotParts = slot.split('\u2013');
    if (slotParts.length !== 2) return false;
    const slotStart = parseTime(slotParts[0].trim());
    const slotEnd = parseTime(slotParts[1].trim());

    if (dayDate && EXACT_MATCH_DAYS.has(dayDate)) {
        // Exact match: session time must equal slot time
        return sessionStart === slotStart && sessionEnd === slotEnd;
    }

    // Overlap: session overlaps if it starts before slot end and ends after slot start
    return sessionStart < slotEnd && sessionEnd > slotStart;
}

function hasAbstract(session) {
    if (session.abstract) return true;
    if (session.presentations) {
        return session.presentations.some(p => p.abstract);
    }
    return false;
}

function generateId(session, dayDate) {
    if (session.session_id) return session.session_id;
    const slug = `${dayDate}-${session.time}-${session.title}`.replace(/\s+/g, '-').toLowerCase();
    return slug;
}

function generatePosterId(session, dayDate, presIndex) {
    const base = generateId(session, dayDate);
    return `${base}::poster-${presIndex}`;
}

function generateTalkId(session, dayDate, presIndex) {
    const base = generateId(session, dayDate);
    return `${base}::talk-${presIndex}`;
}

function togglePosterBookmark(id) {
    if (savedPosterIds.has(id)) {
        savedPosterIds.delete(id);
    } else {
        savedPosterIds.add(id);
    }
    localStorage.setItem('dhd2026_saved_posters', JSON.stringify([...savedPosterIds]));

    if (currentUser) {
        syncProgram();
    }

    if (currentTab === 'my') {
        render();
    } else {
        updatePosterCardState(id);
    }
}

function updatePosterCardState(id) {
    const btn = document.querySelector(`.btn-poster-bookmark[data-id="${CSS.escape(id)}"]`);
    if (btn) {
        const isSaved = savedPosterIds.has(id);
        btn.classList.toggle('active', isSaved);
        const icon = btn.querySelector('.material-icons');
        if (icon) icon.textContent = isSaved ? 'bookmark' : 'bookmark_border';
    }
}

function toggleTalkBookmark(id) {
    if (savedTalkIds.has(id)) {
        savedTalkIds.delete(id);
    } else {
        savedTalkIds.add(id);
    }
    localStorage.setItem('dhd2026_saved_talks', JSON.stringify([...savedTalkIds]));

    if (currentUser) {
        syncProgram();
    }

    if (currentTab === 'my') {
        render();
    } else {
        updateTalkCardState(id);
    }
}

function updateTalkCardState(id) {
    const btn = document.querySelector(`.btn-talk-bookmark[data-id="${CSS.escape(id)}"]`);
    if (btn) {
        const isSaved = savedTalkIds.has(id);
        btn.classList.toggle('active', isSaved);
        const icon = btn.querySelector('.material-icons');
        if (icon) icon.textContent = isSaved ? 'bookmark' : 'bookmark_border';
    }
}

function toggleBookmark(id) {
    if (savedSessionIds.has(id)) {
        savedSessionIds.delete(id);
    } else {
        savedSessionIds.add(id);
    }
    localStorage.setItem('dhd2026_saved_sessions', JSON.stringify([...savedSessionIds]));

    if (currentUser) {
        syncProgram();
    }

    if (currentTab === 'my') {
        render();
    } else {
        updateCardState(id);
    }
}

function updateCardState(id) {
    const btn = document.querySelector(`.btn-bookmark[data-id="${CSS.escape(id)}"]`);
    if (btn) {
        const isSaved = savedSessionIds.has(id);
        btn.classList.toggle('active', isSaved);
        btn.innerHTML = isSaved ?
            '<span class="material-icons">bookmark</span>' :
            '<span class="material-icons">bookmark_border</span>';
    }
}

// Render a whole-session card for "Mein Programm"
function renderSessionCard(session, day, sid) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.id = `session-${sid}`;
    card.dataset.type = session.type || 'Other';

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'session-time';
    timeSpan.textContent = session.time;
    meta.appendChild(timeSpan);
    if ((session.type === 'Vortragssession' || session.type === 'Panel' || session.type === 'Doctoral Consortium') && session.session_id) {
        const sessionIdSpan = document.createElement('span');
        sessionIdSpan.className = 'session-id-label';
        sessionIdSpan.textContent = session.session_id;
        meta.appendChild(sessionIdSpan);
    }
    const typeSpan = document.createElement('span');
    typeSpan.className = 'session-type';
    typeSpan.textContent = session.type;
    meta.appendChild(typeSpan);
    card.appendChild(meta);

    const sessionHasAbstract = hasAbstract(session);
    const titleDiv = document.createElement('div');
    titleDiv.className = 'session-title';
    titleDiv.textContent = session.title;
    if (sessionHasAbstract) {
        titleDiv.classList.add('clickable');
        const expandIcon = document.createElement('span');
        expandIcon.className = 'material-icons expand-icon';
        expandIcon.textContent = 'expand_more';
        titleDiv.appendChild(expandIcon);
    }
    card.appendChild(titleDiv);

    if (session.authors && session.authors.length > 0) {
        const authorsDiv = document.createElement('div');
        authorsDiv.className = 'session-authors';
        session.authors.forEach((a, i) => {
            if (i > 0) authorsDiv.appendChild(document.createTextNode(', '));
            const nameSpan = document.createElement('span');
            nameSpan.className = 'clickable-name';
            nameSpan.textContent = a.name;
            nameSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                openPersonIndexFor(a.name);
            });
            authorsDiv.appendChild(nameSpan);
        });
        card.appendChild(authorsDiv);
    }

    if (session.chair) {
        const chairDiv = document.createElement('div');
        chairDiv.className = 'session-chair';
        const chairIcon = document.createElement('span');
        chairIcon.className = 'material-icons';
        chairIcon.style.fontSize = '16px';
        chairIcon.textContent = 'person';
        chairDiv.appendChild(chairIcon);
        chairDiv.appendChild(document.createTextNode('Chair: '));
        const chairNameSpan = document.createElement('span');
        chairNameSpan.className = 'clickable-name';
        chairNameSpan.textContent = session.chair;
        chairNameSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            openPersonIndexFor(session.chair);
        });
        chairDiv.appendChild(chairNameSpan);
        card.appendChild(chairDiv);
    }

    if (session.location) {
        const locDiv = document.createElement('div');
        locDiv.className = 'session-location';
        const locIcon = document.createElement('span');
        locIcon.className = 'material-icons';
        locIcon.style.fontSize = '16px';
        locIcon.textContent = 'place';
        locDiv.appendChild(locIcon);
        locDiv.appendChild(document.createTextNode(session.location));
        card.appendChild(locDiv);
    }

    if (sessionHasAbstract) {
        const abstractSection = document.createElement('div');
        abstractSection.className = 'session-abstract hidden';
        if (session.abstract) {
            const p = document.createElement('p');
            p.textContent = session.abstract;
            abstractSection.appendChild(p);
        }
        if (session.presentations) {
            session.presentations.forEach(pres => {
                if (!pres.abstract) return;
                const presBlock = document.createElement('div');
                presBlock.className = 'presentation-abstract';
                const presTitle = document.createElement('div');
                presTitle.className = 'presentation-title';
                presTitle.textContent = pres.title;
                presBlock.appendChild(presTitle);
                const presAuthors = document.createElement('div');
                presAuthors.className = 'presentation-authors';
                const authorNames = pres.authors || (pres.author ? [pres.author] : []);
                if (authorNames.length > 0) {
                    authorNames.forEach((name, i) => {
                        if (i > 0) presAuthors.appendChild(document.createTextNode(', '));
                        const nameSpan = document.createElement('span');
                        nameSpan.className = 'clickable-name';
                        nameSpan.textContent = name;
                        nameSpan.addEventListener('click', (e) => {
                            e.stopPropagation();
                            openPersonIndexFor(name);
                        });
                        presAuthors.appendChild(nameSpan);
                    });
                    presBlock.appendChild(presAuthors);
                }
                const presAbstract = document.createElement('p');
                presAbstract.textContent = pres.abstract;
                presBlock.appendChild(presAbstract);
                abstractSection.appendChild(presBlock);
            });
        }
        card.appendChild(abstractSection);
        titleDiv.addEventListener('click', () => {
            abstractSection.classList.toggle('hidden');
            const icon = titleDiv.querySelector('.expand-icon');
            icon.textContent = abstractSection.classList.contains('hidden') ? 'expand_more' : 'expand_less';
        });
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.appendChild(createShareButton(session.title, session.time, session.location, 'session-' + sid));
    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.className = 'btn-bookmark active';
    bookmarkBtn.addEventListener('click', () => toggleBookmark(sid));
    const bookmarkIcon = document.createElement('span');
    bookmarkIcon.className = 'material-icons';
    bookmarkIcon.textContent = 'bookmark';
    bookmarkBtn.appendChild(bookmarkIcon);
    actions.appendChild(bookmarkBtn);
    card.appendChild(actions);

    return card;
}

// Render an individual talk/poster card for "Mein Programm"
function renderPresentationCard(item) {
    const { type, session, pres, bookmarkId } = item;
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.type = type === 'poster' ? 'Poster Session' : session.type;

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'session-time';
    timeSpan.textContent = `${session.time} \u2013 ${session.title}`;
    meta.appendChild(timeSpan);
    if (type === 'talk' && session.session_id) {
        const sessionIdSpan = document.createElement('span');
        sessionIdSpan.className = 'session-id-label';
        sessionIdSpan.textContent = session.session_id;
        meta.appendChild(sessionIdSpan);
    }
    const typeSpan = document.createElement('span');
    typeSpan.className = 'session-type';
    typeSpan.textContent = type === 'poster' ? 'Poster' : (session.type === 'Doctoral Consortium' ? 'DC-Beitrag' : 'Vortrag');
    meta.appendChild(typeSpan);
    card.appendChild(meta);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'session-title';
    titleDiv.textContent = pres.title;
    if (pres.abstract) {
        titleDiv.classList.add('clickable');
        const expandIcon = document.createElement('span');
        expandIcon.className = 'material-icons expand-icon';
        expandIcon.textContent = 'expand_more';
        titleDiv.appendChild(expandIcon);
    }
    card.appendChild(titleDiv);

    const authorNames = pres.authors || (pres.author ? [pres.author] : []);
    if (authorNames.length > 0) {
        const authorsDiv = document.createElement('div');
        authorsDiv.className = 'session-authors';
        authorNames.forEach((name, i) => {
            if (i > 0) authorsDiv.appendChild(document.createTextNode(', '));
            const nameSpan = document.createElement('span');
            nameSpan.className = 'clickable-name';
            nameSpan.textContent = name;
            nameSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                openPersonIndexFor(name);
            });
            authorsDiv.appendChild(nameSpan);
        });
        card.appendChild(authorsDiv);
    }

    if (session.location) {
        const locDiv = document.createElement('div');
        locDiv.className = 'session-location';
        const locIcon = document.createElement('span');
        locIcon.className = 'material-icons';
        locIcon.style.fontSize = '16px';
        locIcon.textContent = 'place';
        locDiv.appendChild(locIcon);
        locDiv.appendChild(document.createTextNode(session.location));
        card.appendChild(locDiv);
    }

    if (pres.abstract) {
        const abstractDiv = document.createElement('div');
        abstractDiv.className = 'session-abstract hidden';
        const p = document.createElement('p');
        p.textContent = pres.abstract;
        abstractDiv.appendChild(p);
        card.appendChild(abstractDiv);
        titleDiv.addEventListener('click', () => {
            abstractDiv.classList.toggle('hidden');
            const icon = titleDiv.querySelector('.expand-icon');
            icon.textContent = abstractDiv.classList.contains('hidden') ? 'expand_more' : 'expand_less';
        });
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const presAnchorMatch = bookmarkId.match(/^(.+)::(talk|poster)-(\d+)$/);
    const presAnchor = presAnchorMatch ? `pres-${presAnchorMatch[1]}-${presAnchorMatch[3]}` : null;
    actions.appendChild(createShareButton(pres.title, session.time, session.location, presAnchor));
    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.className = 'btn-bookmark active';
    const toggleFn = type === 'talk' ? toggleTalkBookmark : togglePosterBookmark;
    bookmarkBtn.addEventListener('click', () => toggleFn(bookmarkId));
    const bookmarkIcon = document.createElement('span');
    bookmarkIcon.className = 'material-icons';
    bookmarkIcon.textContent = 'bookmark';
    bookmarkBtn.appendChild(bookmarkIcon);
    actions.appendChild(bookmarkBtn);
    card.appendChild(actions);

    return card;
}

function render() {
    const container = document.getElementById('app-content');
    if (!container) return;
    container.innerHTML = '';

    if (!conferenceData) return;

    let hasContent = false;

    const daysToShow = currentDay !== null ? [conferenceData.days[currentDay]] : conferenceData.days;

    // For "Mein Programm", collect all bookmarked items (sessions + individual talks + posters)
    // into a unified per-day list sorted by time.
    if (currentTab === 'my') {
        const myItemsByDay = []; // { day, items: [{ type, session, pres?, bookmarkId, sortTime }] }

        daysToShow.forEach(day => {
            const items = [];

            day.sessions.forEach(session => {
                if (currentTimeSlot && !sessionMatchesTimeSlot(session, currentTimeSlot, day.date)) return;
                const sessionStart = session.time ? parseTime(session.time.split('\u2013')[0].trim()) : 0;

                if ((session.type === 'Vortragssession' || session.type === 'Doctoral Consortium') && session.presentations) {
                    // Individual talk bookmarks
                    session.presentations.forEach((pres, presIdx) => {
                        const talkId = generateTalkId(session, day.date, presIdx);
                        if (savedTalkIds.has(talkId)) {
                            items.push({ type: 'talk', session, pres, bookmarkId: talkId, sortTime: sessionStart });
                        }
                    });
                } else if (session.type === 'Poster Session' && session.presentations) {
                    // Individual poster bookmarks
                    session.presentations.forEach((pres, presIdx) => {
                        const posterId = generatePosterId(session, day.date, presIdx);
                        if (savedPosterIds.has(posterId)) {
                            items.push({ type: 'poster', session, pres, bookmarkId: posterId, sortTime: sessionStart });
                        }
                    });
                } else {
                    // Session-level bookmarks
                    const id = generateId(session, day.date);
                    if (savedSessionIds.has(id)) {
                        items.push({ type: 'session', session, bookmarkId: id, sortTime: sessionStart });
                    }
                }
            });

            items.sort((a, b) => a.sortTime - b.sortTime);
            if (items.length > 0) myItemsByDay.push({ day, items });
        });

        myItemsByDay.forEach(({ day, items }) => {
            hasContent = true;
            const daySection = document.createElement('div');
            daySection.className = 'day-section';

            const dayHeader = document.createElement('div');
            dayHeader.className = 'day-header';
            dayHeader.textContent = day.day_label;
            daySection.appendChild(dayHeader);

            const sessionList = document.createElement('div');
            sessionList.className = 'session-list';

            items.forEach(item => {
                if (item.type === 'session') {
                    sessionList.appendChild(renderSessionCard(item.session, day, item.bookmarkId));
                } else {
                    sessionList.appendChild(renderPresentationCard(item));
                }
            });

            daySection.appendChild(sessionList);
            container.appendChild(daySection);
        });
    }

    // For "Übersicht", render all sessions normally
    if (currentTab !== 'my') {
    daysToShow.forEach(day => {
        const daySessions = day.sessions.filter(session => {
            if (currentTimeSlot) {
                if (!sessionMatchesTimeSlot(session, currentTimeSlot, day.date)) return false;
            }
            return true;
        });

        if (daySessions.length === 0) return;
        hasContent = true;

        const daySection = document.createElement('div');
        daySection.className = 'day-section';

        const dayHeader = document.createElement('div');
        dayHeader.className = 'day-header';
        dayHeader.textContent = day.day_label;
        daySection.appendChild(dayHeader);

        const sessionList = document.createElement('div');
        sessionList.className = 'session-list';

        daySessions.forEach(session => {
            const sid = generateId(session, day.date);
            const isSaved = savedSessionIds.has(sid);

            const card = document.createElement('div');
            card.className = 'session-card';
            card.id = `session-${sid}`;
            card.dataset.type = session.type || 'Other';

            // Build card content safely using DOM methods
            const meta = document.createElement('div');
            meta.className = 'session-meta';

            const timeSpan = document.createElement('span');
            timeSpan.className = 'session-time';
            timeSpan.textContent = session.time;
            meta.appendChild(timeSpan);

            if ((session.type === 'Vortragssession' || session.type === 'Panel' || session.type === 'Doctoral Consortium') && session.session_id) {
                const sessionIdSpan = document.createElement('span');
                sessionIdSpan.className = 'session-id-label';
                sessionIdSpan.textContent = session.session_id;
                meta.appendChild(sessionIdSpan);
            }

            const typeSpan = document.createElement('span');
            typeSpan.className = 'session-type';
            typeSpan.textContent = session.type;
            meta.appendChild(typeSpan);

            card.appendChild(meta);

            const sessionHasAbstract = hasAbstract(session);

            const titleDiv = document.createElement('div');
            titleDiv.className = 'session-title';
            titleDiv.textContent = session.title;
            if (sessionHasAbstract) {
                titleDiv.classList.add('clickable');
                const expandIcon = document.createElement('span');
                expandIcon.className = 'material-icons expand-icon';
                expandIcon.textContent = 'expand_more';
                titleDiv.appendChild(expandIcon);
            }
            card.appendChild(titleDiv);

            // Authors
            if (session.authors && session.authors.length > 0) {
                const authorsDiv = document.createElement('div');
                authorsDiv.className = 'session-authors';
                session.authors.forEach((a, i) => {
                    if (i > 0) authorsDiv.appendChild(document.createTextNode(', '));
                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'clickable-name';
                    nameSpan.textContent = a.name;
                    nameSpan.addEventListener('click', (e) => {
                        e.stopPropagation();
                        openPersonIndexFor(a.name);
                    });
                    authorsDiv.appendChild(nameSpan);
                });
                card.appendChild(authorsDiv);
            }

            // Chair
            if (session.chair) {
                const chairDiv = document.createElement('div');
                chairDiv.className = 'session-chair';

                const chairIcon = document.createElement('span');
                chairIcon.className = 'material-icons';
                chairIcon.style.fontSize = '16px';
                chairIcon.textContent = 'person';
                chairDiv.appendChild(chairIcon);

                chairDiv.appendChild(document.createTextNode('Chair: '));
                const chairNameSpan = document.createElement('span');
                chairNameSpan.className = 'clickable-name';
                chairNameSpan.textContent = session.chair;
                chairNameSpan.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openPersonIndexFor(session.chair);
                });
                chairDiv.appendChild(chairNameSpan);

                card.appendChild(chairDiv);
            }

            // Location (plain text)
            if (session.location) {
                const locDiv = document.createElement('div');
                locDiv.className = 'session-location';

                const locIcon = document.createElement('span');
                locIcon.className = 'material-icons';
                locIcon.style.fontSize = '16px';
                locIcon.textContent = 'place';
                locDiv.appendChild(locIcon);

                const locText = document.createTextNode(session.location);
                locDiv.appendChild(locText);

                card.appendChild(locDiv);
            }

            // Abstract section (hidden by default)
            if (sessionHasAbstract) {
                const abstractSection = document.createElement('div');
                abstractSection.className = 'session-abstract hidden';

                if (session.abstract) {
                    const p = document.createElement('p');
                    p.textContent = session.abstract;
                    abstractSection.appendChild(p);
                }

                const isPosterSession = session.type === 'Poster Session';
                if (session.presentations) {
                    session.presentations.forEach((pres, presIdx) => {
                        if (!pres.abstract) return;
                        const presBlock = document.createElement('div');
                        presBlock.className = 'presentation-abstract';
                        presBlock.id = `pres-${sid}-${presIdx}`;

                        const presHeader = document.createElement('div');
                        presHeader.className = 'presentation-header';

                        const presTitle = document.createElement('div');
                        presTitle.className = 'presentation-title';
                        presTitle.textContent = pres.title;
                        presHeader.appendChild(presTitle);

                        presHeader.appendChild(createShareButton(pres.title, session.time, session.location, `pres-${sid}-${presIdx}`));

                        if (isPosterSession) {
                            const posterId = generatePosterId(session, day.date, presIdx);
                            const posterSaved = savedPosterIds.has(posterId);
                            const posterBtn = document.createElement('button');
                            posterBtn.className = `btn-poster-bookmark ${posterSaved ? 'active' : ''}`;
                            posterBtn.dataset.id = posterId;
                            posterBtn.title = posterSaved ? 'Aus Mein Programm entfernen' : 'Zu Mein Programm hinzufügen';
                            posterBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                togglePosterBookmark(posterId);
                            });
                            const pIcon = document.createElement('span');
                            pIcon.className = 'material-icons';
                            pIcon.textContent = posterSaved ? 'bookmark' : 'bookmark_border';
                            posterBtn.appendChild(pIcon);
                            presHeader.appendChild(posterBtn);
                        } else if (session.type === 'Vortragssession' || session.type === 'Doctoral Consortium') {
                            const talkId = generateTalkId(session, day.date, presIdx);
                            const talkSaved = savedTalkIds.has(talkId);
                            const talkBtn = document.createElement('button');
                            talkBtn.className = `btn-talk-bookmark ${talkSaved ? 'active' : ''}`;
                            talkBtn.dataset.id = talkId;
                            talkBtn.title = talkSaved ? 'Aus Mein Programm entfernen' : 'Zu Mein Programm hinzufügen';
                            talkBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                toggleTalkBookmark(talkId);
                            });
                            const tIcon = document.createElement('span');
                            tIcon.className = 'material-icons';
                            tIcon.textContent = talkSaved ? 'bookmark' : 'bookmark_border';
                            talkBtn.appendChild(tIcon);
                            presHeader.appendChild(talkBtn);
                        }

                        presBlock.appendChild(presHeader);

                        const presAuthors = document.createElement('div');
                        presAuthors.className = 'presentation-authors';
                        const authorNames = pres.authors || (pres.author ? [pres.author] : []);
                        if (authorNames.length > 0) {
                            authorNames.forEach((name, i) => {
                                if (i > 0) presAuthors.appendChild(document.createTextNode(', '));
                                const nameSpan = document.createElement('span');
                                nameSpan.className = 'clickable-name';
                                nameSpan.textContent = name;
                                nameSpan.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    openPersonIndexFor(name);
                                });
                                presAuthors.appendChild(nameSpan);
                            });
                            presBlock.appendChild(presAuthors);
                        }

                        const presAbstract = document.createElement('p');
                        presAbstract.textContent = pres.abstract;
                        presBlock.appendChild(presAbstract);

                        abstractSection.appendChild(presBlock);
                    });
                }

                card.appendChild(abstractSection);

                titleDiv.addEventListener('click', () => {
                    abstractSection.classList.toggle('hidden');
                    const icon = titleDiv.querySelector('.expand-icon');
                    icon.textContent = abstractSection.classList.contains('hidden') ? 'expand_more' : 'expand_less';
                });
            }

            // Actions bar (share + bookmark) — only for sessions without sub-events
            if (!(session.presentations && session.presentations.length > 0)) {
                const actions = document.createElement('div');
                actions.className = 'card-actions';

                actions.appendChild(createShareButton(session.title, session.time, session.location, 'session-' + sid));

                const bookmarkBtn = document.createElement('button');
                bookmarkBtn.className = `btn-bookmark ${isSaved ? 'active' : ''}`;
                bookmarkBtn.dataset.id = sid;
                bookmarkBtn.addEventListener('click', () => toggleBookmark(sid));

                const bookmarkIcon = document.createElement('span');
                bookmarkIcon.className = 'material-icons';
                bookmarkIcon.textContent = isSaved ? 'bookmark' : 'bookmark_border';
                bookmarkBtn.appendChild(bookmarkIcon);

                actions.appendChild(bookmarkBtn);
                card.appendChild(actions);
            }

            sessionList.appendChild(card);
        });

        daySection.appendChild(sessionList);
        container.appendChild(daySection);
    });
    } // end if (currentTab !== 'my')

    if (!hasContent) {
        if (currentTab === 'my') {
            const empty = document.createElement('div');
            empty.className = 'empty-state';

            const icon = document.createElement('span');
            icon.className = 'material-icons';
            icon.style.fontSize = '48px';
            icon.style.marginBottom = '20px';
            icon.textContent = 'event_busy';
            empty.appendChild(icon);

            const p1 = document.createElement('p');
            p1.textContent = 'Dein Programm ist noch leer.';
            empty.appendChild(p1);

            const p2 = document.createElement('p');
            p2.textContent = 'Gehe zur Übersicht, um Veranstaltungen hinzuzufügen.';
            empty.appendChild(p2);

            const btn = document.createElement('button');
            btn.className = 'btn-primary';
            btn.textContent = 'Zur Übersicht';
            btn.addEventListener('click', () => switchTab('all'));
            empty.appendChild(btn);

            container.appendChild(empty);
        } else {
            container.innerHTML = '<p class="empty-state">Keine Programmpunkte gefunden.</p>';
        }
    }
}

function navigateToHash() {
    let hash;
    try {
        hash = decodeURIComponent(window.location.hash.slice(1));
    } catch (e) {
        hash = window.location.hash.slice(1);
    }
    if (!hash) return;
    if (hash.startsWith('session-')) {
        navigateToSession(hash.slice('session-'.length), null, true);
    } else if (hash.startsWith('pres-')) {
        const m = hash.match(/^pres-(.+)-(\d+)$/);
        if (m) navigateToSession(m[1], parseInt(m[2], 10), true);
    }
}

function navigateToSession(bookmarkId, presIndex, instant) {
    // On pages without the program view (e.g. Lageplan), jump to the overview instead
    if (!document.getElementById('app-content')) {
        const anchor = presIndex != null ? `pres-${bookmarkId}-${presIndex}` : `session-${bookmarkId}`;
        window.location.href = `index.html#${encodeURIComponent(anchor)}`;
        return;
    }

    closePersonModal();
    // Switch to Übersicht tab
    currentTab = 'all';
    document.querySelectorAll('.main-nav .nav-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('btn-all').classList.add('active');
    const loginHint = document.getElementById('login-hint');
    if (loginHint) loginHint.classList.add('hidden');
    // Reset filters so the session is visible
    currentDay = null;
    currentTimeSlot = null;
    buildDayFilterBar();
    buildTimeFilterBar();
    render();
    setTimeout(() => {
        const sessionEl = document.getElementById(`session-${bookmarkId}`);
        if (!sessionEl) return;

        // Always expand the abstract section
        const abstractSection = sessionEl.querySelector('.session-abstract');
        if (abstractSection && abstractSection.classList.contains('hidden')) {
            abstractSection.classList.remove('hidden');
            const icon = sessionEl.querySelector('.expand-icon');
            if (icon) icon.textContent = 'expand_less';
        }

        if (presIndex != null) {
            // Scroll to the specific presentation
            const presEl = document.getElementById(`pres-${bookmarkId}-${presIndex}`);
            if (presEl) {
                presEl.scrollIntoView({ behavior: instant ? 'instant' : 'smooth', block: 'center' });
                presEl.classList.add('highlight');
                setTimeout(() => presEl.classList.remove('highlight'), 2000);
                return;
            }
        }

        sessionEl.scrollIntoView({ behavior: instant ? 'instant' : 'smooth', block: 'center' });
        sessionEl.classList.add('highlight');
        setTimeout(() => sessionEl.classList.remove('highlight'), 2000);
    }, 100);
}

function openPersonIndexFor(name) {
    if (personIndex.length === 0) {
        buildPersonIndex();
    }
    const searchInput = document.getElementById('person-search');
    searchInput.value = name;
    const filtered = personIndex.filter(p => p.name.toLowerCase().includes(name.toLowerCase()));
    renderPersonList(filtered);
    document.getElementById('person-modal').classList.remove('hidden');
    // Auto-expand the first matching person
    setTimeout(() => {
        const firstHeader = document.querySelector('#person-list .person-item .person-header');
        if (firstHeader) {
            firstHeader.click();
        }
    }, 50);
}

function closeToast() {
    document.getElementById('login-hint').classList.add('hidden');
}

function openMap(locationName) {
    const modal = document.getElementById('map-modal');
    document.getElementById('target-location').textContent = locationName;
    document.getElementById('map-location-name').textContent = locationName;

    const conferenceLocation = conferenceData?.conference?.location || "Wien";
    const query = encodeURIComponent(`${locationName}, ${conferenceLocation}`);

    document.getElementById('ext-map-link').href = `https://www.google.com/maps/search/?api=1&query=${query}`;

    modal.classList.remove('hidden');
}

function closeMap() {
    document.getElementById('map-modal').classList.add('hidden');
}

// --- Hamburger Menu & Info Pages ---

const INFO_PAGES = {
    about: {
        title: 'Über die App',
        html: `
            <p>Diese App begleitet Sie durch das Programm der <strong>DHd 2026</strong> – der Jahrestagung des Verbands „Digital Humanities im deutschsprachigen Raum" in Wien.</p>
            <p>Das Konferenzprogramm umfasst eine Vielzahl an Sessions, Workshops und Postern. Mit dieser App können Sie sich gezielt Ihren eigenen Konferenzfahrplan zusammenstellen und den Überblick behalten.</p>
            <p>Funktionen:</p>
            <ul>
                <li>Gesamtes Programm durchsuchen und nach Tag oder Zeitfenster filtern</li>
                <li>Einzelne Sessions und Poster als Lesezeichen vormerken</li>
                <li>Unter „Mein Programm" alle vorgemerkten Beiträge auf einen Blick sehen</li>
                <li>Mit einem Konto Ihre Auswahl dauerhaft und geräteübergreifend speichern</li>
            </ul>
            <p style="margin-top:1em;">Die in dieser App enthaltenen Informationen wurden von der offiziellen Konferenzwebsite <strong>Hier Link der 2027er Webseite einfügen, sobald verfügbar</strong> entnommen.</p>
            `
    },
    help: {
        title: 'Hilfe',
        html: `
            <p><strong>Tagesübersicht:</strong> Nutzen Sie die Tages-Buttons oben, um nach einzelnen Konferenztagen zu filtern. Ein zweiter Klick zeigt wieder alle Tage.</p>
            <p><strong>Zeitfilter:</strong> Nach Auswahl eines Tages erscheinen Zeitfenster-Buttons zur weiteren Eingrenzung.</p>
            <p><strong>Lesezeichen:</strong> Tippen Sie auf das Lesezeichen-Symbol einer Session, um sie zu „Mein Programm" hinzuzufügen.</p>
            <p><strong>Mein Programm:</strong> Wechseln Sie zum Tab „Mein Programm", um nur Ihre gespeicherten Sessions zu sehen.</p>
            <p><strong>Login:</strong> Erstellen Sie ein Konto, um Ihr Programm geräteübergreifend zu speichern. Ohne Login werden Lesezeichen nur lokal im Browser gespeichert.</p>
            <p><strong>Abstracts:</strong> Klicken Sie auf den Titel einer Session, um Abstracts und Einzelvorträge ein- oder auszublenden.</p>
        `
    },
    imprint: {
        title: 'Impressum',
        html: `
            <p>Diese App ist ein Fork der <a href="https://github.com/grid-creators/mydhd-app" target="_blank" rel="noopener">My DHd App</a> von <abbr title="admin@grid-creators.com · www.grid-creators.com">Grid Creators / Tinghui Duan</abbr>.
            Sie wurde für die DHd Konferenz 2027 in Marburg vom Team des <strong><a href="https://www.uni-marburg.de/de/mcdci" target="_blank" rel="noopener">Marburg Center for Digital Culture and Infrastructure</a></strong> weiterentwickelt.</p>
            <p>Diese App steht unter der <a href="https://github.com/grid-creators/mydhd-app/blob/main/LICENSE" target="_blank" rel="noopener">MIT-Lizenz</a> und kann frei genutzt und weiterentwickelt werden.</p>
        `
    }
};

function toggleMenu() {
    const overlay = document.getElementById('menu-overlay');
    overlay.classList.toggle('hidden');
}

function showInfoPage(page) {
    toggleMenu();
    const info = INFO_PAGES[page];
    if (!info) return;
    document.getElementById('info-modal-title').textContent = info.title;
    document.getElementById('info-modal-body').innerHTML = info.html;
    document.getElementById('info-modal').classList.remove('hidden');
}

function closeInfoModal() {
    document.getElementById('info-modal').classList.add('hidden');
}

// --- Person Index ---

let personIndex = []; // sorted array of { name, affiliation, sessions: [{title, day_label, time, session_id}] }

function buildPersonIndex() {
    if (!conferenceData) return;
    const personMap = new Map(); // key: normalized name, value: { name, affiliations: Set, sessions: [] }

    function addPerson(name, affiliation, sessionRef) {
        if (!name || !name.trim()) return;
        name = name.trim();
        const key = name.toLowerCase();
        if (!personMap.has(key)) {
            personMap.set(key, { name, affiliations: new Set(), sessions: [] });
        }
        const entry = personMap.get(key);
        if (affiliation && affiliation.trim()) {
            entry.affiliations.add(affiliation.trim());
        }
        // Avoid duplicate session references
        const refKey = `${sessionRef.day_label}|${sessionRef.time}|${sessionRef.title}|${sessionRef.pres_title || ''}`;
        if (!entry.sessions.some(s => `${s.day_label}|${s.time}|${s.title}|${s.pres_title || ''}` === refKey)) {
            entry.sessions.push(sessionRef);
        }
    }

    conferenceData.days.forEach(day => {
        day.sessions.forEach(session => {
            const bookmarkId = generateId(session, day.date);
            const sessionRef = {
                title: session.title,
                day_label: day.day_label,
                time: session.time,
                session_id: session.session_id || null,
                bookmark_id: bookmarkId,
                type: session.type || ''
            };

            // Session-level authors
            if (session.authors) {
                session.authors.forEach(a => {
                    addPerson(a.name, a.affiliation, sessionRef);
                });
            }

            // Chair
            if (session.chair) {
                addPerson(session.chair, null, sessionRef);
            }

            // Presentation-level authors
            if (session.presentations) {
                session.presentations.forEach((pres, presIdx) => {
                    // For Poster Sessions and Vortragssessions, use individual presentation title
                    let presRef = sessionRef;
                    if ((session.type === 'Poster Session' || session.type === 'Vortragssession' || session.type === 'Doctoral Consortium') && pres.title) {
                        presRef = {
                            ...sessionRef,
                            pres_title: pres.title,
                            pres_index: presIdx
                        };
                    }
                    if (pres.authors && Array.isArray(pres.authors)) {
                        pres.authors.forEach(authorName => {
                            addPerson(authorName, pres.affiliation || null, presRef);
                        });
                    } else if (pres.author) {
                        addPerson(pres.author, pres.affiliation || null, presRef);
                    }
                });
            }
        });
    });

    personIndex = Array.from(personMap.values())
        .map(p => ({
            name: p.name,
            affiliation: Array.from(p.affiliations).join('; '),
            sessions: p.sessions
        }))
        .sort((a, b) => {
            const surnameA = a.name.split(/\s+/).pop();
            const surnameB = b.name.split(/\s+/).pop();
            return surnameA.localeCompare(surnameB, 'de') || a.name.localeCompare(b.name, 'de');
        });
}

function showPersonIndex() {
    toggleMenu();
    if (personIndex.length === 0) {
        buildPersonIndex();
    }
    const searchInput = document.getElementById('person-search');
    searchInput.value = '';
    renderPersonList(personIndex);
    document.getElementById('person-modal').classList.remove('hidden');
    searchInput.focus();
}

function closePersonModal() {
    document.getElementById('person-modal').classList.add('hidden');
}

function filterPersons() {
    const query = document.getElementById('person-search').value.trim().toLowerCase();
    if (!query) {
        renderPersonList(personIndex);
        return;
    }
    const filtered = personIndex.filter(p => p.name.toLowerCase().includes(query));
    renderPersonList(filtered);
}

function renderPersonList(persons) {
    const container = document.getElementById('person-list');
    const countEl = document.getElementById('person-count');
    container.innerHTML = '';
    countEl.textContent = `${persons.length} Person${persons.length !== 1 ? 'en' : ''}`;

    persons.forEach(person => {
        const item = document.createElement('div');
        item.className = 'person-item';

        const header = document.createElement('div');
        header.className = 'person-header';

        const nameEl = document.createElement('div');
        nameEl.className = 'person-name';
        nameEl.textContent = person.name;
        header.appendChild(nameEl);

        const toggleIcon = document.createElement('span');
        toggleIcon.className = 'material-icons person-expand-icon';
        toggleIcon.textContent = 'expand_more';
        header.appendChild(toggleIcon);

        item.appendChild(header);

        const sessionsList = document.createElement('div');
        sessionsList.className = 'person-sessions hidden';

        person.sessions.forEach(ref => {
            const refEl = document.createElement('div');
            refEl.className = 'person-session-ref';

            const refInfo = document.createElement('div');
            refInfo.className = 'person-session-info';

            const refTime = document.createElement('span');
            refTime.className = 'person-session-time';
            const dayShort = ref.day_label.split(',')[0];
            refTime.textContent = `${dayShort}, ${ref.time}`;
            refInfo.appendChild(refTime);

            const refTitle = document.createElement('span');
            refTitle.className = 'person-session-title';
            if (ref.pres_title && ref.type === 'Poster Session') {
                refTitle.textContent = 'Poster: ' + ref.pres_title;
            } else if (ref.pres_title && ref.type === 'Vortragssession') {
                refTitle.textContent = 'Vortrag: ' + ref.pres_title;
            } else {
                refTitle.textContent = ref.title;
            }
            refInfo.appendChild(refTitle);

            refInfo.classList.add('clickable-session-ref');
            refInfo.addEventListener('click', () => {
                navigateToSession(ref.bookmark_id, ref.pres_index != null ? ref.pres_index : null);
            });

            refEl.appendChild(refInfo);

            // Determine bookmark type and state
            let isSaved, toggleFn, checkFn;
            if ((ref.type === 'Vortragssession' || ref.type === 'Doctoral Consortium') && ref.pres_index != null) {
                const talkId = `${ref.bookmark_id}::talk-${ref.pres_index}`;
                isSaved = savedTalkIds.has(talkId);
                toggleFn = () => toggleTalkBookmark(talkId);
                checkFn = () => savedTalkIds.has(talkId);
            } else if (ref.type === 'Poster Session' && ref.pres_index != null) {
                const posterId = `${ref.bookmark_id}::poster-${ref.pres_index}`;
                isSaved = savedPosterIds.has(posterId);
                toggleFn = () => togglePosterBookmark(posterId);
                checkFn = () => savedPosterIds.has(posterId);
            } else {
                isSaved = savedSessionIds.has(ref.bookmark_id);
                toggleFn = () => toggleBookmark(ref.bookmark_id);
                checkFn = () => savedSessionIds.has(ref.bookmark_id);
            }

            const bmBtn = document.createElement('button');
            bmBtn.className = `person-session-bookmark${isSaved ? ' active' : ''}`;
            bmBtn.title = isSaved ? 'Aus Mein Programm entfernen' : 'Zu Mein Programm hinzufügen';
            bmBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFn();
                const nowSaved = checkFn();
                bmBtn.classList.toggle('active', nowSaved);
                const icon = bmBtn.querySelector('.material-icons');
                icon.textContent = nowSaved ? 'bookmark' : 'bookmark_border';
                bmBtn.title = nowSaved ? 'Aus Mein Programm entfernen' : 'Zu Mein Programm hinzufügen';
            });
            const bmIcon = document.createElement('span');
            bmIcon.className = 'material-icons';
            bmIcon.textContent = isSaved ? 'bookmark' : 'bookmark_border';
            bmBtn.appendChild(bmIcon);
            refEl.appendChild(bmBtn);

            sessionsList.appendChild(refEl);
        });

        item.appendChild(sessionsList);

        header.addEventListener('click', () => {
            sessionsList.classList.toggle('hidden');
            toggleIcon.textContent = sessionsList.classList.contains('hidden') ? 'expand_more' : 'expand_less';
        });

        container.appendChild(item);
    });
}

// Close modals when clicking outside
window.addEventListener('click', function(event) {
    const mapModal = document.getElementById('map-modal');
    const authModal = document.getElementById('auth-modal');
    const infoModal = document.getElementById('info-modal');
    const personModal = document.getElementById('person-modal');
    if (event.target === mapModal) {
        mapModal.classList.add('hidden');
    }
    if (event.target === authModal) {
        closeAuthModal();
    }
    if (event.target === infoModal) {
        closeInfoModal();
    }
    if (event.target === personModal) {
        closePersonModal();
    }
});
