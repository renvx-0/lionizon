function performantSort(servers, ascending = false) {
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

    return [...valid].sort((a, b) => ascending ? score(a) - score(b) : score(b) - score(a));
}

let originalHTML = null;
let originalServerList = null;
let loadMoreBtnClone = null;

// Cache the expensive "all servers" fetch per game page so the performant
// filter and the region selector don't each re-download the entire list.
let _cachedServers = null;
let _cachedServersGameId = null;

async function getAllServersCached(pageGameId) {
    if (_cachedServers && _cachedServersGameId === pageGameId) return _cachedServers;
    _cachedServers = await getAllServers(pageGameId);
    _cachedServersGameId = pageGameId;
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

async function applyServerFilter(filter_mode) {
    const container = document.querySelector("#rbx-public-game-server-item-container");
    if (!container) return;

    // Reset to Roblox's default behaviour.
    if (filter_mode === "default") {
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

    let sorted = [];
    if (filter_mode === "performant") {
        const seen = new Set();
        sorted = performantSort(data.server_list ?? []).filter(s => {
            if (seen.has(s.id)) return false;
            seen.add(s.id);
            return true;
        });
    } else if (filter_mode.startsWith("region:")) {
        const raw = filter_mode.split(":")[1];
        const all = data.server_list ?? [];
        // Make sure every server is geolocated before we can read its country.
        processServersLocationBatch(all, pageGameId);
        await Promise.all(all.map(s => waitForLocation(s.id, 15000).catch(() => null)));
        if (raw === "__unknown__") {
            sorted = all.filter(s => !locationCache[s.id] || !locationCache[s.id].country);
        } else {
            sorted = all.filter(s => locationCache[s.id]?.country === raw);
        }
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
                <option value="performant">Most performant</option>
            </select>
            <span class="icon-arrow icon-down-16x16"></span>
        </div>
        `)

        const filter_select = el.querySelector("div #filter-select")
        filter_select.addEventListener("change", () => {
            applyServerFilter(filter_select.value);
        });
    })
}
