(() => {
    const INSTANCE = 'https://fedihum.org';
    const ACCOUNT = 'DHdKonferenz@fedihum.org';
    // Hashtags to include (with or without #), e.g. ['Dhd2027', 'marburg'].
    const HASHTAGS = ['Dhd2027', 'dhd2027'];
    const feedElement = document.getElementById('mastodon-feed');
    const statusElement = document.getElementById('news-feed-status');
    const refreshButton = document.getElementById('news-feed-refresh');
    const loadMoreButton = document.getElementById('news-feed-load-more');
    const hashtagsElement = document.getElementById('news-feed-hashtags');

    if (!feedElement || !statusElement || !refreshButton || !loadMoreButton) return;

    const HASHTAG_PAGE_SIZE = 40;
    const configuredHashtags = HASHTAGS
        .map(tag => String(tag).trim().replace(/^#+/, ''))
        .filter(Boolean);
    const seenHashtags = new Set();
    const hashtags = configuredHashtags.filter(tag => {
        const normalized = tag.toLocaleLowerCase();
        if (seenHashtags.has(normalized)) return false;
        seenHashtags.add(normalized);
        return true;
    });
    const hashtagFeeds = new Map(hashtags.map(tag => [tag, { maxId: null, canLoadMore: true }]));
    const posts = new Map();

    if (hashtagsElement) {
        hashtagsElement.textContent = hashtags.length ? hashtags.map(tag => `#${tag}`).join(', ') : 'keine';
    }

    async function fetchJson(url) {
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(data?.error || `Mastodon antwortet mit HTTP ${response.status}.`);
        }
        return data;
    }

    async function fetchAccountPosts() {
        const lookupUrl = new URL('/api/v1/accounts/lookup', INSTANCE);
        lookupUrl.searchParams.set('acct', ACCOUNT);
        const account = await fetchJson(lookupUrl);

        const statusesUrl = new URL(`/api/v1/accounts/${encodeURIComponent(account.id)}/statuses`, INSTANCE);
        statusesUrl.searchParams.set('limit', '20');
        statusesUrl.searchParams.set('exclude_reblogs', 'false');
        const statuses = await fetchJson(statusesUrl);

        return statuses.map(status => ({ status: status.reblog || status, source: ACCOUNT }));
    }

    async function fetchHashtagPosts(hashtag, maxId = null) {
        const url = new URL(`/api/mastodon/timelines/tag/${encodeURIComponent(hashtag)}`, window.location.origin);
        if (maxId) url.searchParams.set('max_id', maxId);
        const statuses = await fetchJson(url);
        return statuses.map(status => ({ status, source: `#${hashtag}` }));
    }

    function getPlainText(html) {
        const parsed = new DOMParser().parseFromString(html || '', 'text/html');
        const blockTags = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE']);

        function readNode(node) {
            if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            if (node.tagName === 'BR') return '\n';

            const text = Array.from(node.childNodes, readNode).join('');
            return blockTags.has(node.tagName) ? `${text}\n` : text;
        }

        return readNode(parsed.body).replace(/\n{3,}/g, '\n\n').trim();
    }

    function getHttpsUrl(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' ? url.href : null;
        } catch {
            return null;
        }
    }

    function createMediaGallery(attachments) {
        const images = (Array.isArray(attachments) ? attachments : [])
            .filter(media => media.type === 'image')
            .map(media => ({
                preview: getHttpsUrl(media.preview_url || media.url),
                original: getHttpsUrl(media.url || media.preview_url),
                description: media.description || 'Bild aus dem Mastodon-Beitrag'
            }))
            .filter(media => media.preview);

        if (images.length === 0) return null;

        const gallery = document.createElement('div');
        gallery.className = 'mastodon-post-media';

        images.forEach(media => {
            const image = document.createElement('img');
            image.src = media.preview;
            image.alt = media.description;
            image.loading = 'lazy';
            image.decoding = 'async';

            if (media.original) {
                const link = document.createElement('a');
                link.className = 'mastodon-post-media-link';
                link.href = media.original;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.appendChild(image);
                gallery.appendChild(link);
            } else {
                gallery.appendChild(image);
            }
        });

        return gallery;
    }

    function createPostCard(status, sources) {
        const card = document.createElement('article');
        card.className = 'mastodon-post';

        const header = document.createElement('div');
        header.className = 'mastodon-post-header';

        const authorLink = document.createElement('a');
        authorLink.href = status.account.url;
        authorLink.target = '_blank';
        authorLink.rel = 'noopener noreferrer';
        authorLink.textContent = status.account.display_name || `@${status.account.acct}`;
        header.appendChild(authorLink);

        const date = document.createElement('time');
        date.className = 'mastodon-post-date';
        date.dateTime = status.created_at;
        date.textContent = new Date(status.created_at).toLocaleString('de-DE');
        header.appendChild(date);
        card.appendChild(header);

        const content = document.createElement('p');
        content.className = 'mastodon-post-content';
        content.textContent = getPlainText(status.content);
        card.appendChild(content);

        const mediaGallery = createMediaGallery(status.media_attachments);
        if (mediaGallery) card.appendChild(mediaGallery);

        const footer = document.createElement('div');
        footer.className = 'mastodon-post-footer';
        const source = document.createElement('span');
        source.className = 'mastodon-post-source';
        source.textContent = sources.join(' · ');
        footer.appendChild(source);

        const postLink = document.createElement('a');
        postLink.href = status.url;
        postLink.target = '_blank';
        postLink.rel = 'noopener noreferrer';
        postLink.textContent = 'Auf Mastodon ansehen ↗';
        footer.appendChild(postLink);
        card.appendChild(footer);

        return card;
    }

    function mergePosts(entries) {
        entries.forEach(({ status, source }) => {
            if (!status || !status.id) return;
            const existing = posts.get(status.id);
            if (existing) {
                if (!existing.sources.includes(source)) existing.sources.push(source);
            } else {
                posts.set(status.id, { status, sources: [source] });
            }
        });
    }

    function renderPosts() {
        const sortedPosts = Array.from(posts.values()).sort(
            (a, b) => new Date(b.status.created_at) - new Date(a.status.created_at)
        );
        feedElement.replaceChildren();

        if (sortedPosts.length === 0) {
            const emptyMessage = document.createElement('p');
            emptyMessage.className = 'mastodon-empty-state';
            emptyMessage.textContent = 'Aktuell wurden keine Beiträge gefunden.';
            feedElement.appendChild(emptyMessage);
            return;
        }

        sortedPosts.forEach(({ status, sources }) => {
            feedElement.appendChild(createPostCard(status, sources));
        });
    }

    async function loadFeed() {
        refreshButton.disabled = true;
        loadMoreButton.disabled = true;
        loadMoreButton.hidden = true;
        statusElement.textContent = 'Feed wird geladen …';
        feedElement.replaceChildren();
        posts.clear();
        hashtagFeeds.forEach(feed => {
            feed.maxId = null;
            feed.canLoadMore = true;
        });

        const sources = [fetchAccountPosts(), ...hashtags.map(tag => fetchHashtagPosts(tag))];
        const results = await Promise.allSettled(sources);
        const errors = results.filter(result => result.status === 'rejected');

        results.forEach(result => {
            if (result.status !== 'fulfilled') return;
            mergePosts(result.value);
        });

        hashtags.forEach((tag, index) => {
            const result = results[index + 1];
            if (result.status !== 'fulfilled') return;
            const feed = hashtagFeeds.get(tag);
            const statuses = result.value;
            feed.canLoadMore = statuses.length === HASHTAG_PAGE_SIZE;
            feed.maxId = statuses.at(-1)?.status.id || null;
        });
        renderPosts();

        statusElement.textContent = errors.length === results.length
            ? `Die Mastodon-Quellen konnten nicht geladen werden: ${errors[0].reason.message}`
            : errors.length > 0
                ? `Ein Teil der Feed-Quellen konnte nicht geladen werden: ${errors.map(result => result.reason.message).join(' ')}`
                : `${posts.size} Beiträge geladen.`;
        refreshButton.disabled = false;
        loadMoreButton.hidden = ![...hashtagFeeds.values()].some(feed => feed.canLoadMore && feed.maxId);
        loadMoreButton.disabled = false;
    }

    async function loadMoreHashtagPosts() {
        const feedsToLoad = [...hashtagFeeds.entries()]
            .filter(([, feed]) => feed.canLoadMore && feed.maxId);
        if (!feedsToLoad.length) return;

        loadMoreButton.disabled = true;
        statusElement.textContent = 'Ältere Hashtag-Beiträge werden geladen …';
        const results = await Promise.allSettled(feedsToLoad.map(([tag, feed]) => fetchHashtagPosts(tag, feed.maxId)));
        const errors = [];

        results.forEach((result, index) => {
            const [tag, feed] = feedsToLoad[index];
            if (result.status === 'rejected') {
                errors.push(result.reason.message);
                console.error(`Hashtag #${tag} konnte nicht geladen werden:`, result.reason);
                return;
            }

            const entries = result.value;
            const nextMaxId = entries.at(-1)?.status.id || null;
            if (!entries.length || nextMaxId === feed.maxId) {
                feed.canLoadMore = false;
                return;
            }

            feed.maxId = nextMaxId;
            feed.canLoadMore = entries.length === HASHTAG_PAGE_SIZE;
            mergePosts(entries);
        });

        renderPosts();
        statusElement.textContent = errors.length
            ? `Einige Hashtag-Quellen konnten nicht geladen werden: ${errors.join(' ')} ${posts.size} Beiträge geladen.`
            : `${posts.size} Beiträge geladen.`;
        loadMoreButton.hidden = ![...hashtagFeeds.values()].some(feed => feed.canLoadMore && feed.maxId);
        loadMoreButton.disabled = false;
    }

    refreshButton.addEventListener('click', loadFeed);
    loadMoreButton.addEventListener('click', loadMoreHashtagPosts);
    loadFeed();
})();