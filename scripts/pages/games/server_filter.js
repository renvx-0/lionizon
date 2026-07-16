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
// optional region scope compose: the chosen sort runs over the servers in the
// selected region only. Region comes from the Region button (region_filter.js);
// it calls the window helpers below to set scope + re-apply the current sort.
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

// Cache the expensive "all servers" fetch per game page so the performant
// filter and the region selector don't each re-download the entire list.
//
// Before this fix, only an in-memory variable was kept, but applyServerFilter()
// cleared it back to null on every mode switch (default / performant / ping_*),
// so each filter change re-fetched the full server list. The cache is now kept
// in chrome.storage keyed by placeId, so it survives filter changes AND SPA
// navigations to other games (the script re-runs per /games/ load), and is only
// refreshed when it's missing or belongs to a different game.
const _serverCacheKey = "ext_server_cache";
let _cachedServers = null;
let _cachedServersGameId = null;

// Load the persisted cache (or start empty). Seeded once at module load.
const __serverCachePromise = loadData(_serverCacheKey, {}).then(
    data => { _serverCache = data; return data; }
);
let _serverCache = {};

async function getAllServersCached(pageGameId) {
    // In-memory hit for this page load.
    if (_cachedServers && _cachedServersGameId === pageGameId) return _cachedServers;

    // Persistent hit (survives filter changes + SPA nav to the same game).
    await __serverCachePromise;
    const stored = _serverCache[pageGameId];
    if (Array.isArray(stored?.server_list) && stored.server_list.length > 0) {
        _cachedServers = stored;
        _cachedServersGameId = pageGameId;
        return _cachedServers;
    }

    // Otherwise fetch from the API (only once) and persist it.
    _cachedServers = await getAllServers(pageGameId);
    _cachedServersGameId = pageGameId;

    _serverCache[pageGameId] = _cachedServers;
    saveData({ [_serverCacheKey]: _serverCache });

    return _cachedServers;
}

// Render an ordered list of servers into the server container, attaching the
// "load more" clone button and per-card geolocation. Shared by every filter
// mode so the performant sort and the region selector produce identical cards.
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

    loadNextBatch(); // first batch

    loadMoreBtnClone.addEventListener("click", loadNextBatch);
    container.after(loadMoreBtnClone);
}

async function applyServerFilter(filter_mode, ascending = true) {
    const container = document.querySelector("#rbx-public-game-server-item-container");
    if (!container) return;

    // Reset / default behaviour.
    if (filter_mode === "default") {
        // No region scoped → a true Roblox-default reset.
        if (!_filterRegion) {
            window.__filter_active__ = false;
            window.__current_filter__ = "default";
            window.server_list = originalServerList ?? [];
            container.innerHTML = originalHTML;
            loadMoreBtnClone?.remove();
            loadMoreBtnClone = null;
            document.querySelector(".rbx-public-running-games-footer")?.style.removeProperty("display");
            originalHTML = null;
            originalServerList = null;
            return;
        }
        // Default sort + a selected region → show region-filtered list, unsorted.
        window.__filter_active__ = true;
        window.__current_filter__ = "default";
    }

    // Track the active sort so the Region button can re-apply it with a new scope.
    _activeFilterMode = filter_mode;
    _activeSortAscending = ascending;

    // Already showing this exact mode – don't re-run the (expensive) search.
    if (window.__filter_active__ && window.__current_filter__ === filter_mode) return;

    // Switching from another active mode: restore the baseline list first so
    // the new render starts clean. originalHTML/originalServerList are kept so
    // a later "default" still works.
    if (window.__filter_active__) {
        window.__filter_active__ = false;
        container.innerHTML = originalHTML;
        loadMoreBtnClone?.remove();
        loadMoreBtnClone = null;
        document.querySelector(".rbx-public-running-games-footer")?.style.removeProperty("display");
        window.server_list = originalServerList ?? [];
    }

    window.__filter_active__ = true;
    window.__current_filter__ = filter_mode;

    const pageGameId = parseInt(window.location.href.split("games/")[1].split("/")[0]);

    const dialogLabel = filter_mode === "performant"
        ? "Fetching servers by performance, please be patient..."
        : filter_mode === "ping_server"
        ? "Sorting servers by server ping, please be patient..."
        : filter_mode === "ping_client"
        ? "Sorting servers by your ping, please be patient..."
        : "Filtering servers by region, please be patient...";

    document.body.insertAdjacentHTML("beforeend", `
    <div class="foundation-web-dialog-overlay padding-y-medium foundation-web-portal-zindex bg-common-backdrop">
        <div role="dialog" class="relative radius-large bg-surface-100 stroke-none foundation-web-dialog-content shadow-transient-high download-dialog" data-size="Medium">
            
            <!-- Close button -->
            <div class="absolute foundation-web-dialog-close-container">
                <button type="button" class="foundation-web-close-affordance flex bg-none cursor-pointer bg-over-media-100 padding-small radius-circle stroke-none" aria-label="Close">
                    <span class="icon icon-regular-x size-[var(--icon-size-medium)]"></span>
                </button>
            </div>

            <!-- Icon + Title -->
            <div class="dialog-main-container padding-x-xlarge padding-top-xlarge padding-bottom-xlarge flex flex-col items-center gap-xlarge">
                <img src="${chrome.runtime.getURL('assets/icons/cat128.png')}" class="app-icon-windows size-1600">
                <h2 class="text-heading-small padding-x-xxlarge text-align-x-center">
                    ${dialogLabel}
                </h2>
            </div>

            <div class="dialog-button-container padding-x-xlarge padding-bottom-xlarge flex">
                <button type="button" class="foundation-web-button cursor-pointer flex items-center justify-center radius-medium text-label-medium height-1000 padding-x-medium bg-action-emphasis content-action-emphasis grow stroke-none" style="background-color: #dfa834">
                    <div aria-hidden="true" class="absolute flex"><svg class="foundation-web-loading-spinner" width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M10 2.75C8.56609 2.75 7.16438 3.1752 5.97212 3.97185C4.77986 4.76849 3.85061 5.90078 3.30188 7.22554C2.75314 8.55031 2.60957 10.008 2.88931 11.4144C3.16905 12.8208 3.85955 14.1126 4.87348 15.1265C5.88741 16.1405 7.17924 16.831 8.5856 17.1107C9.99196 17.3904 11.4497 17.2469 12.7745 16.6981C14.0992 16.1494 15.2315 15.2201 16.0282 14.0279C16.8248 12.8356 17.25 11.4339 17.25 10C17.25 9.58579 17.5858 9.25 18 9.25C18.4142 9.25 18.75 9.58579 18.75 10C18.75 11.7306 18.2368 13.4223 17.2754 14.8612C16.3139 16.3002 14.9473 17.4217 13.3485 18.0839C11.7496 18.7462 9.9903 18.9195 8.29296 18.5819C6.59563 18.2443 5.03653 17.4109 3.81282 16.1872C2.58911 14.9635 1.75575 13.4044 1.41813 11.707C1.08051 10.0097 1.25379 8.25037 1.91606 6.65152C2.57832 5.05267 3.69983 3.6861 5.13876 2.72464C6.57769 1.76318 8.26942 1.25 10 1.25C10.4142 1.25 10.75 1.58579 10.75 2C10.75 2.41421 10.4142 2.75 10 2.75Z"></path></svg></div>
                </button>
            </div>

        </div>
    </div>
    `)
    const searchingDialog = document.querySelector(".foundation-web-dialog-overlay")

    if (!originalHTML) {
        originalHTML = container.innerHTML;
        originalServerList = [...window.server_list];
    }

    const data = await getAllServersCached(pageGameId)
    const all = data.server_list ?? [];

    // If a region is scoped, geolocate the whole list first so we can read each
    // server's country from locationCache.
    if (_filterRegion) {
        processServersLocationBatch(all, pageGameId);
        await Promise.all(all.map(s => waitForLocation(s.id, 15000).catch(() => null)));
    }

    // Candidate pool: all servers, or just those in the selected region.
    let base = all;
    if (_filterRegion) {
        base = _filterRegion === "__unknown__"
            ? all.filter(s => !locationCache[s.id] || !locationCache[s.id].country)
            : all.filter(s => locationCache[s.id]?.country === _filterRegion);
    }

    let sorted = [];
    if (filter_mode === "performant") {
        // Geolocate the whole pool first (so client-ping cells can fill in)
        // using the same 15s wait the other sort modes rely on.
        processServersLocationBatch(base, pageGameId);
        await Promise.all(base.map(s => waitForLocation(s.id, 15000).catch(() => null)));
        const seen = new Set();
        sorted = performantSort(base, ascending).filter(s => {
            if (seen.has(s.id)) return false;
            seen.add(s.id);
            return true;
        });
    } else if (filter_mode === "ping_server") {
        // Same pre-geolocation so client-ping estimates are available.
        processServersLocationBatch(base, pageGameId);
        await Promise.all(base.map(s => waitForLocation(s.id, 15000).catch(() => null)));
        sorted = serverPingSort(base, ascending);
    } else if (filter_mode === "ping_client") {
        sorted = await clientPingSort(base, ascending);
    } else {
        // "default" (optionally region-scoped) → no extra sort applied.
        sorted = base;
    }

    searchingDialog.remove()

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
            // Picking "Roblox Default" also drops any active region scope.
            if (filter_select.value === "default" && _filterRegion) {
                _filterRegion = null;
                if (typeof setRegionButtonLabel === "function") setRegionButtonLabel(null);
            }
            // Manual dropdown change resets to "Best first" so the button label
            // always matches the actual sort direction.
            sortAscending = true;
            sort_order_btn.textContent = "Best first";
            updateSortOrderVisibility();
            applyServerFilter(filter_select.value);
        });

        // Re-apply the current sort with the flipped direction.
        sort_order_btn.addEventListener("click", () => {
            if (!SORT_MODES.has(filter_select.value)) return;
            sortAscending = !sortAscending;
            sort_order_btn.textContent = sortAscending ? "Best first" : "Worst first";
            // Force a re-render (the "same mode" guard would otherwise skip it).
            window.__filter_active__ = false;
            window.__current_filter__ = null;
            applyServerFilter(filter_select.value);
        });

        sort_order_btn.textContent = "Best first";
        updateSortOrderVisibility();
    })
}
