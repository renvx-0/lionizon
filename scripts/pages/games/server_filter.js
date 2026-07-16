function performantSort(servers, ascending = true) {
    const valid = servers.filter(s => s.fps != null && s.ping != null && !isNaN(s.fps) && !isNaN(s.ping));

    const maxFps  = valid.reduce((max, s) => Math.max(max, s.fps), -Infinity);
    const minPing = valid.reduce((min, s) => Math.min(min, s.ping), Infinity);
    const maxPing = valid.reduce((max, s) => Math.max(max, s.ping), -Infinity);

    const pingRange = maxPing - minPing;

    const score = s => {
        const fpsScore  = s.fps / maxFps;
        const pingScore = pingRange === 0 ? 1 : 1 - (s.ping - minPing) / pingRange;
        return (fpsScore + pingScore) / 2;
    };

    // Higher score = better, so "ascending" (Best first) must sort the highest
    // score to the top — i.e. descending by score.
    return [...valid].sort((a, b) => ascending ? score(b) - score(a) : score(a) - score(b));
}

// Sort by Roblox's own reported server ping (the value already on each server).
function serverPingSort(servers, ascending = true) {
    const valid = servers.filter(s => s.ping != null && !isNaN(s.ping));
    // ascending = best (lowest ping) first.
    const dir = ascending ? 1 : -1;
    return [...valid].sort((a, b) => dir * (a.ping - b.ping));
}

// Sort by the *estimated* client→server ping (distance-based), computed the
// same way the per-card client-ping cell is. Requires every server to be
// geolocated, plus the client's own location (fetched once via getClientLocation).
async function clientPingSort(servers, ascending = true) {
    const pageGameId = parseInt(window.location.href.split("games/")[1].split("/")[0]);

    // Make sure every server is geolocated and the client location is known.
    processServersLocationBatch(servers, pageGameId);
    const clientLoc = await getClientLocation();
    await Promise.all(servers.map(s => waitForLocation(s.id, 15000).catch(() => null)));

    const valid = servers.filter(s => {
        const loc = locationCache[s.id];
        return clientLoc && loc && loc.latitude != null && loc.longitude != null;
    });

    const withPing = valid.map(s => {
        const loc = locationCache[s.id];
        return { s, est: estimatePing(clientLoc.latitude, clientLoc.longitude, loc.latitude, loc.longitude) };
    });

    // ascending = best (lowest estimated ping) first.
    const dir = ascending ? 1 : -1;
    return withPing
        .sort((a, b) => dir * (a.est - b.est))
        .map(x => x.s);
}

let originalHTML = null;
let originalServerList = null;
let loadMoreBtnClone = null;

// --- Filter composition state -----------------------------------------------
// The sort mode (performant / ping_server / ping_client / default) and an
// optional region scope compose INDEPENDENTLY: the chosen sort runs over the
// servers in the selected region only. Region comes from the Region button
// (region_filter.js); it calls the window helpers below to set scope + re-apply
// the current sort. Neither dropdown resets the other, so a region selection
// survives a sort change (and vice-versa) and the two filters always stack.
let _filterRegion = null;          // country code, "__unknown__", or null
let _activeFilterMode = "default";
let _activeSortAscending = true;

// Set by the Region button; null clears the scope.
window.__setFilterRegion = (code) => { _filterRegion = code; };
// Re-apply the current sort (respecting region scope). Forces a re-render even
// if the sort mode itself didn't change (e.g. only the region changed).
window.__reapplyServerFilter = () => {
    window.__filter_active__ = false;
    window.__current_filter__ = null;
    applyServerFilter(_activeFilterMode, _activeSortAscending);
};

// --- In-memory server cache (page session only) -----------------------------
// The expensive "all servers" fetch is kept ONLY in memory for the life of the
// page/tab. We deliberately do NOT persist it to chrome.storage/localStorage:
// the first time a filter or the region picker needs the full list we download
// it once, and every subsequent filter/region change reuses the exact same
// array instead of re-fetching. The same applies to geolocation (see
// geolocateAllServersOnce) — once a server is placed, it is never relocated
// again for this page load.
let _cachedServers = null;
let _cachedServersGameId = null;

async function getAllServersCached(pageGameId) {
    // In-memory hit for this page load — never re-downloads.
    if (_cachedServers && _cachedServersGameId === pageGameId) return _cachedServers;

    // Different game (SPA navigation) or first load → fetch once.
    _cachedServers = await getAllServers(pageGameId);
    _cachedServersGameId = pageGameId;
    return _cachedServers;
}

// Geolocate every server in the cached list exactly ONCE per page. Concurrent
// callers share the same pass (returns the same promise), and once it resolves
// the promise is reused so we never re-relocate servers that are already placed.
// This is what makes "click region → pick a sort → change region → change sort"
// feel instant after the first pass instead of relocating everything again.
let _allGeolocatePromise = null;
let _allGeolocated = false;

async function ensureAllServers(pageGameId) {
    if (_cachedServers && _cachedServersGameId === pageGameId) return _cachedServers;
    // Game changed (or first load): drop any stale single-pass geolocation so
    // the next geolocateAllServersOnce re-runs for the new game.
    _allGeolocatePromise = null;
    _allGeolocated = false;
    _cachedServers = await getAllServers(pageGameId);
    _cachedServersGameId = pageGameId;
    return _cachedServers;
}

// Listeners captured on the first (heavy) pass only. Subsequent calls return
// the already-running/instant promise and don't need progress updates.
let _geolocateProgressListeners = [];

// Geolocate every server in the cached list exactly ONCE per page. Concurrent
// callers share the same pass (returns the same promise), and once it resolves
// the promise is reused so we never re-relocate servers that are already placed.
// This is what makes "click region → pick a sort → change region → change sort"
// feel instant after the first pass instead of relocating everything again.
//
// Pass `onProgress({ phase, done, total })` to get live progress during the
// first (slow) pass — `phase` is "fetching" or "geolocating", `done`/`total`
// are the number of servers resolved / total. Used to show the user the work
// isn't stuck (the region button text + the inline list spinner both consume it).
function geolocateAllServersOnce(pageGameId, onProgress) {
    if (onProgress) _geolocateProgressListeners.push(onProgress);

    // Cached / already-resolved pass → nothing to report, just hand back the data.
    if (_allGeolocatePromise && _cachedServersGameId === pageGameId) return _allGeolocatePromise;

    _allGeolocated = false;
    const listeners = _geolocateProgressListeners;
    _geolocateProgressListeners = [];
    const emit = (phase, done, total) => listeners.forEach(cb => cb({ phase, done, total }));

    _allGeolocatePromise = (async () => {
        emit("fetching", 0, 0);
        const data = await ensureAllServers(pageGameId);
        const all = data.server_list ?? [];
        const total = all.length;

        // processServersLocationBatch skips any server already in locationCache,
        // so this only ever does real work the first time.
        processServersLocationBatch(all, pageGameId);

        let done = 0;
        emit("geolocating", done, total);
        // Resolve each server's location; the .then bumps the counter and emits
        // progress as servers come back (or time out after 15s). Counting every
        // resolution — success or timeout — keeps "done" marching toward "total"
        // so the bar never appears frozen even if a handful of servers fail.
        await Promise.all(all.map(s =>
            waitForLocation(s.id, 15000)
                .catch(() => null)
                .then(() => { done++; emit("geolocating", done, total); })
        ));

        _allGeolocated = true;
        return all;
    })();
    return _allGeolocatePromise;
}

// --- Inline loading feedback -------------------------------------------------
// A lightweight spinner dropped straight into the server list. The heavy
// fetch+geolocation only happens once (cached), but the *compute* between a
// click and the cards appearing (especially the client-ping distance sort) can
// take a couple of seconds on a cached load too. Showing this immediately means
// a click always gets instant visual feedback and never looks "dead". This
// replaces the old full-screen cat popup — the spinner lives in the list itself.
const SERVER_FILTER_SPINNER_SVG =
    '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M10 2.75C8.56609 2.75 7.16438 3.1752 5.97212 3.97185C4.77986 4.76849 3.85061 5.90078 3.30188 7.22554C2.75314 8.55031 2.60957 10.008 2.88931 11.4144C3.16905 12.8208 3.85955 14.1126 4.87348 15.1265C5.88741 16.1405 7.17924 16.831 8.5856 17.1107C9.99196 17.3904 11.4497 17.2469 12.7745 16.6981C14.0992 16.1494 15.2315 15.2201 16.0282 14.0279C16.8248 12.8356 17.25 11.4339 17.25 10C17.25 9.58579 17.5858 9.25 18 9.25C18.4142 9.25 18.75 9.58579 18.75 10C18.75 11.7306 18.2368 13.4223 17.2754 14.8612C16.3139 16.3002 14.9473 17.4217 13.3485 18.0839C11.7496 18.7462 9.9903 18.9195 8.29296 18.5819C6.59563 18.2443 5.03653 17.4109 3.81282 16.1872C2.58911 14.9635 1.75575 13.4044 1.41813 11.707C1.08051 10.0097 1.25379 8.25037 1.91606 6.65152C2.57832 5.05267 3.69983 3.6861 5.13876 2.72464C6.57769 1.76318 8.26942 1.25 10 1.25C10.4142 1.25 10.75 1.58579 10.75 2C10.75 2.41421 10.4142 2.75 10 2.75Z"></path></svg>';

function showServerFilterSpinner(container, label = "Applying filter…") {
    container.innerHTML = `
        <div class="server-filter-inline-spinner">
            ${SERVER_FILTER_SPINNER_SVG}
            <span>${label}</span><span class="server-filter-spinner-count"></span>
        </div>
    `;
    return container.querySelector(".server-filter-spinner-count");
}

// Toggle the "Load more" control while a filter is (re)loading. We hide the
// original Roblox footer (we always manage the list via our cloned copy) and
// disable the .rbx-running-games-load-more button (plus the whole clone, so a
// click anywhere on it is ignored) so the user can't page through a stale list
// mid-sort. Called with `true` the instant a filter starts loading; the control
// is re-enabled inside renderServerCards once the new cards are ready.
function setLoadMoreDisabled(disabled) {
    const footer = document.querySelector(".rbx-public-running-games-footer");
    if (footer) footer.style.display = "none";

    if (loadMoreBtnClone) {
        loadMoreBtnClone.style.pointerEvents = disabled ? "none" : "";
        loadMoreBtnClone.style.display = disabled ? "none" : "";
        const cloneInner = loadMoreBtnClone.querySelector(".rbx-running-games-load-more");
        if (cloneInner) {
            cloneInner.disabled = disabled;
            cloneInner.style.pointerEvents = disabled ? "none" : "";
            cloneInner.style.opacity = disabled ? "0.5" : "";
        }
    }
}

// Render an ordered list of servers into the server container, attaching the
// "load more" clone button and per-card geolocation. Shared by every filter
// mode so the performant sort and the region selector produce identical cards.
// The load-more click handler is REPLACED (not stacked) on every render so
// repeated filtering doesn't accumulate listeners that each dump another 12
// servers when the button is clicked.
let _loadMoreHandler = null;

async function renderServerCards(sorted, pageGameId) {
    const container = document.querySelector("#rbx-public-game-server-item-container");

    // Map keyed by playerToken -> imageUrl. Avoids the positional-slice bug
    // where out-of-order/dropped batch results silently dropped avatars.
    const thumbByToken = await getUsersThumbnailFromTokens(sorted.flatMap(s => s.playerTokens || []));

    const serverThumbs = Object.fromEntries(sorted.map(s => {
        const thumbs = (s.playerTokens || []).map(t => thumbByToken[t]).filter(Boolean);
        return [s.id, thumbs];
    }));

    container.innerHTML = "";

    let loadMoreBtn = document.querySelector(".rbx-public-running-games-footer");
    if (!loadMoreBtnClone) {
        loadMoreBtnClone = loadMoreBtn.cloneNode(true);
        loadMoreBtnClone.classList.add("cloned-btn");
        container.after(loadMoreBtnClone);
    }
    loadMoreBtn.style.display = "none";

    let current_shown_idx = 0;

    function loadNextBatch() {
        const batch = sorted.slice(current_shown_idx, current_shown_idx + 12);
        if (batch.length === 0) return;

        window.server_list = [...(window.server_list ?? []), ...batch];

        batch.forEach(s => {
            let thumb_html = (serverThumbs[s.id] ?? []).reduce((html, url) => {
                return html + `
                    <span class="avatar avatar-headshot-md player-avatar">
                        <span class="thumbnail-2d-container avatar-card-image">
                            <img class="" src="${url}" alt="" title="">
                        </span>
                    </span>
                `;
            }, "");

            if (serverThumbs[s.id].length == 0 && s.playing != 0) {
                for (let i=0; i < 5; i++) {
                    thumb_html += `
                        <span class="avatar avatar-headshot-md player-avatar hidden-players-placeholder">
                            ?
                        </span>
                    `;
                }
            }

            if (s.playing > 5) {
                thumb_html += `<span class="avatar avatar-headshot-md player-avatar hidden-players-placeholder">+${s.playing - 5}</span>`
            }

            const li = document.createElement("li");
            li.className = "rbx-public-game-server-item col-md-3 col-sm-4 col-xs-6";
            li.innerHTML = `
                <div class="card-item card-item-public-server">
                    <div class="player-thumbnails-container">${thumb_html}</div>
                    <div class="rbx-public-game-server-details game-server-details">
                        <div class="text-info rbx-game-status rbx-public-game-server-status text-overflow">
                            ${s.playing} of ${s.maxPlayers} people max
                        </div>
                        <div class="server-player-count-gauge border">
                            <div class="gauge-inner-bar border" style="width: ${(s.playing / s.maxPlayers) * 100}%;"></div>
                        </div>
                        <span data-placeid="${pageGameId}">
                            <button type="button" class="btn-full-width btn-control-xs rbx-public-game-server-join game-server-join-btn btn-primary-md btn-min-width">Join</button>
                        </span>
                        <div class="server-id-text text-info xsmall">ID: ${s.id}</div>
                    </div>
                </div>
            `;
            container.appendChild(li);

            let joinBtn = li.querySelector(".card-item .game-server-details span .game-server-join-btn")
            joinBtn.addEventListener("click", () => {
                const a = document.createElement("a")
                a.href = `roblox://experiences/start?placeId=${pageGameId}&gameInstanceId=${s.id}`
                a.style.display = "none"
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
            })
            handleServerElement(li.querySelector(".card-item"));
        });

        processServersLocationBatch(batch, pageGameId);

        current_shown_idx += 12;
        if (current_shown_idx >= sorted.length) loadMoreBtnClone.style.display = "none";
    }

    // Re-enable "Load more" now that the freshly filtered cards are in the DOM
    // (clearing whatever disabled state was set while loading).
    setLoadMoreDisabled(false);

    // Replace the load-more handler (instead of adding a new one) so repeated
    // renders don't stack listeners. current_shown_idx belongs to this render's
    // closure, so the new handler always pages through the *current* `sorted`.
    if (_loadMoreHandler) loadMoreBtnClone.removeEventListener("click", _loadMoreHandler);
    _loadMoreHandler = loadNextBatch;
    loadMoreBtnClone.addEventListener("click", _loadMoreHandler);

    loadMoreBtnClone.style.display = "";

    loadNextBatch(); // first batch
}

async function applyServerFilter(filter_mode, ascending = true) {
    const container = document.querySelector("#rbx-public-game-server-item-container");
    if (!container) return;

    // Reset / default behaviour with NO region scoped → a true Roblox-default
    // reset (restore the original list exactly as Roblox rendered it).
    if (filter_mode === "default" && !_filterRegion) {
        window.__filter_active__ = false;
        window.__current_filter__ = "default";
        _activeFilterMode = "default";
        _activeSortAscending = true;
        window.server_list = originalServerList ?? [];
        container.innerHTML = originalHTML;
        loadMoreBtnClone?.remove();
        loadMoreBtnClone = null;
        _loadMoreHandler = null;
        document.querySelector(".rbx-public-running-games-footer")?.style.removeProperty("display");
        originalHTML = null;
        originalServerList = null;
        return;
    }

    // Track the active sort so the Region button can re-apply it with a new scope.
    _activeFilterMode = filter_mode;
    _activeSortAscending = ascending;

    // Already showing this exact mode with this exact region – don't re-run.
    // (Region changes go through __reapplyServerFilter, which clears these flags
    // first so the region re-render is never skipped.)
    if (window.__filter_active__ && window.__current_filter__ === filter_mode) return;

    // Snapshot the container baseline (Roblox default) the first time we ever
    // render a filtered view, so a later "default" reset can restore it. MUST
    // happen before we overwrite container.innerHTML with the spinner below.
    if (!originalHTML) {
        originalHTML = container.innerHTML;
        originalServerList = [...window.server_list];
    }

    const pageGameId = parseInt(window.location.href.split("games/")[1].split("/")[0]);

    // Fetch + geolocate everything EXACTLY ONCE. Both are cached in memory and
    // shared, so selecting a region, picking a sort, or changing either reuses
    // the already-loaded data instead of re-downloading or re-relocating every
    // server. The inline spinner (see showServerFilterSpinner) gives the user
    // feedback during this work.
    const dialogLabel = filter_mode === "performant"
        ? "Fetching servers by performance, please be patient..."
        : filter_mode === "ping_server"
        ? "Sorting servers by server ping, please be patient..."
        : filter_mode === "ping_client"
        ? "Sorting servers by your ping, please be patient..."
        : "Filtering servers by region, please be patient...";

    // Instant visual feedback: drop the spinner into the list right away so the
    // click never looks like it did nothing while we fetch/geolocate (first
    // time) or compute the (cached) sort. renderServerCards() clears it when the
    // cards are ready. Declaration order matters here: dialogLabel is defined
    // above so this lookup is safe.
    const loadingLabel = _filterRegion
        ? (filter_mode === "default" ? "Filtering servers by region, please be patient…"
                                      : "Sorting filtered servers, please be patient…")
        : dialogLabel;
    const countEl = showServerFilterSpinner(container, loadingLabel);

    // Disable "Load more" while loading (e.g. during the long client-ping
    // geolocation sort) so the user can't page a stale previous list. It's
    // re-enabled inside renderServerCards once the new cards are ready.
    setLoadMoreDisabled(true);

    const data = await getAllServersCached(pageGameId)
    const all = data.server_list ?? [];

    // Single geolocation pass over the whole list (cached after the first run).
    // On the first (slow) pass, mirror the live "N/M" progress into the spinner
    // so a long fetch+geolocate never looks frozen.
    await geolocateAllServersOnce(pageGameId, ({ phase, done, total }) => {
        if (countEl && total > 0) {
            countEl.textContent = phase === "fetching"
                ? " — fetching servers…"
                : ` — ${done}/${total}`;
        }
    });

    // Candidate pool: all servers, or just those in the selected region.
    // locationCache is already fully populated by geolocateAllServersOnce.
    let base = all;
    if (_filterRegion) {
        base = _filterRegion === "__unknown__"
            ? all.filter(s => !locationCache[s.id] || !locationCache[s.id].country)
            : all.filter(s => locationCache[s.id]?.country === _filterRegion);
    }

    let sorted = [];
    if (filter_mode === "performant") {
        const seen = new Set();
        sorted = performantSort(base, ascending).filter(s => {
            if (seen.has(s.id)) return false;
            seen.add(s.id);
            return true;
        });
    } else if (filter_mode === "ping_server") {
        sorted = serverPingSort(base, ascending);
    } else if (filter_mode === "ping_client") {
        sorted = await clientPingSort(base, ascending);
    } else {
        // "default" (optionally region-scoped) → no extra sort applied.
        sorted = base;
    }

    window.__filter_active__ = true;
    window.__current_filter__ = filter_mode;

    await renderServerCards(sorted, pageGameId);
}

if (window.location.href.includes("/games/")) {
    observeElement(".server-list-options", (el) => {
        el.insertAdjacentHTML("beforeend", `
        <div class="rbx-select-group select-group">
            <select id="filter-select" class="input-field rbx-select select-option" style="margin-left:20px">
                <option value="default">Roblox Default</option>
                <optgroup label="Sort by ping">
                    <option value="performant">Most performant</option>
                    <option value="ping_server">Server ping</option>
                    <option value="ping_client">Client ping</option>
                </optgroup>
            </select>
            <span class="icon-arrow icon-down-16x16"></span>
        </div>
        <button id="sort-order-btn" type="button" class="btn-control-xs btn-secondary-md" style="margin-left:10px; display:none" title="Toggle sort direction">Best first</button>
        `)

        const filter_select = el.querySelector("div #filter-select")
        const sort_order_btn = el.querySelector("#sort-order-btn")

        // true = lowest ping / highest performance first ("Best first").
        let sortAscending = true;

        const SORT_MODES = new Set(["performant", "ping_server", "ping_client"]);

        function updateSortOrderVisibility() {
            sort_order_btn.style.display = SORT_MODES.has(filter_select.value) ? "" : "none";
        }

        filter_select.addEventListener("change", () => {
            // NOTE: changing the sort mode intentionally does NOT touch the
            // active region scope — region and sort are independent filters
            // that always compose (see _filterRegion in applyServerFilter).
            sortAscending = true;
            sort_order_btn.textContent = "Best first";
            updateSortOrderVisibility();
            // Pass the current direction so the sort actually honours it.
            applyServerFilter(filter_select.value, sortAscending);
        });

        // Re-apply the current sort with the flipped direction.
        sort_order_btn.addEventListener("click", () => {
            if (!SORT_MODES.has(filter_select.value)) return;
            sortAscending = !sortAscending;
            sort_order_btn.textContent = sortAscending ? "Best first" : "Worst first";
            // Force a re-render (the "same mode" guard would otherwise skip it).
            window.__filter_active__ = false;
            window.__current_filter__ = null;
            // Pass the (now flipped) direction so the sort actually reverses.
            applyServerFilter(filter_select.value, sortAscending);
        });

        sort_order_btn.textContent = "Best first";
        updateSortOrderVisibility();
    })
}
