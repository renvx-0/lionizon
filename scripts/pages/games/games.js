const gameDetailsUpdateSecs = 2.5

const IP_API_URL = "https://api-geolocation.juliozapatahernandez2006.workers.dev";

const locationCache = {};
const locationResolvers = {};

// -- DEBUG ONLY: collect every server IP we encounter (handy for checking which
// IP ranges show up vs what's in ServerList.json). Call `dumpServerIps()` in the
// devtools console to download them as a plain .txt. No effect on normal use. --
const __debugServerIps = new Set();
window.dumpServerIps = () => {
    const text = Array.from(__debugServerIps).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "server_ips.txt";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    log(`Dumped ${__debugServerIps.size} server IPs to server_ips.txt`);
};

// fires when server data found
function resolveLocation(serverId, value) {
    locationCache[serverId] = value;
    if (locationResolvers[serverId]) {
        locationResolvers[serverId].forEach(resolve => resolve(value));
        delete locationResolvers[serverId];
    }
}

// returns a promise that resolves when the location for this server is known
// if found, returns, if waits 10s and it isnt there, keep default full text
function waitForLocation(serverId, timeout = 5000) {
    if (locationCache.hasOwnProperty(serverId)) return Promise.resolve(locationCache[serverId]);

    return new Promise((resolve, reject) => {
        if (!locationResolvers[serverId]) locationResolvers[serverId] = [];
        locationResolvers[serverId].push(resolve);

        setTimeout(() => {
            if (!locationCache.hasOwnProperty(serverId)) {
                // Resolve as "not found" WITHOUT poisoning the cache, so a later
                // geolocation (e.g. a filter re-render) can still populate it.
                locationResolvers[serverId]?.forEach(r => r(null));
                delete locationResolvers[serverId];
            }
        }, timeout);
    });
}

const queueCache = {};
const queueResolvers = {};

function resolveQueue(serverId, value) {
    queueCache[serverId] = value;
    if (queueResolvers[serverId]) {
        queueResolvers[serverId].forEach(resolve => resolve(value));
        delete queueResolvers[serverId];
    }
}

// returns a promise that resolves when the location for this server is known
function waitForQueue(serverId, timeout = 5000) {
    if (queueCache[serverId] !== undefined) return Promise.resolve(queueCache[serverId]);

    return new Promise((resolve, reject) => {
        if (!queueResolvers[serverId]) queueResolvers[serverId] = [];
        queueResolvers[serverId].push(resolve);
        setTimeout(() => reject(`Timeout waiting for queue ${serverId}`), timeout);
    });
}

async function getIPLocation(datacenters, placeId) {
    try {
        const res = await fetch(`${IP_API_URL}/geolocate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Origin": "https://www.roblox.com/" },
            body: JSON.stringify({ datacenters, placeId: placeId })
        });
        const data = await res.json();
        log("Got ip location", data);
        if (data.results) return data.results;
    } catch (e) {
        console.error("IP lookup failed", e);
    }
}

// Great-circle (haversine) distance in km between two lat/long points.
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Rough RTT estimate from physical distance. Light in fiber travels ~200 km/ms
// one-way, so a round trip is ~distance/100 ms, plus a fixed processing/router
// overhead. This is an estimate, not a real ICMP measurement.
function estimatePing(clientLat, clientLon, serverLat, serverLon) {
    const distanceKm = haversineKm(clientLat, clientLon, serverLat, serverLon);
    return Math.max(1, Math.round(distanceKm / 100 + 20));
}

// Resolve the client's own lat/long. Rather than fetching the IP from a
// third-party service (which Roblox's CSP can block), we hit our own worker's
// /me endpoint — Cloudflare gives it the caller's IP, and we geolocate that
// through the same bucket the servers use. Cached so it only runs once per page.
const __timeout = (promise, ms, label) =>
    Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms)),
    ]);

let __clientLocationPromise = null;
function getClientLocation() {
    if (__clientLocationPromise) return __clientLocationPromise;
    __clientLocationPromise = (async () => {
        try {
            const res = await __timeout(
                fetch(`${IP_API_URL}/me`, { headers: { Origin: "https://www.roblox.com/" } }),
                8000,
                "client /me"
            );
            const data = await res.json();
            if (data && data.latitude != null && data.longitude != null) {
                return { latitude: data.latitude, longitude: data.longitude };
            }
        } catch (e) {
            console.error("Client location lookup failed", e);
        }
        return null;
    })();
    return __clientLocationPromise;
}

async function processServersLocationBatch(serversInRequest, gameId) {
    const serverIds = serversInRequest.map(s => s.id);
    log("Processing batch of", serverIds.length, "servers");

    // get every server info
    const joinResults = await joinInstanceInfo(gameId, serverIds);
    if (!joinResults) return;

    let geo_db = await loadData("geo_db", { servers: {}, addresses: {} });
    const datacentersToFetch = {};

    for (let i = 0; i < serverIds.length; i++) {
        const id = serverIds[i];
        const apiData = joinResults[i]?.data;

        // resolve every server queue
        resolveQueue(id, apiData?.queuePosition ?? 0);

        // if its in cache then skip
        if (locationCache[id]) continue;

        // if its in storage then resolve with that saved data — but only trust it
        // if it carries coordinates (older cached entries predate the lat/long
        // fields and would break the client-ping estimate). Otherwise fall
        // through to a fresh lookup.
        if (geo_db.servers[id] && geo_db.servers[id].latitude != null && geo_db.servers[id].longitude != null) {
            resolveLocation(id, geo_db.servers[id]);
            continue;
        }

        // if not saved or cached, then get joinscript
        const joinScript = apiData?.joinScript;
        if (!joinScript) {
            continue; 
        }

        const ip = joinScript.UdmuxEndpoints[0]?.Address;
        const dc = String(joinScript.DataCenterId);
        if (!ip || !dc) continue;

        // check if ip exists — but only trust it if it has coordinates.
        if (geo_db.addresses[ip] && geo_db.addresses[ip].latitude != null && geo_db.addresses[ip].longitude != null) {
            const data = { ip, ...geo_db.addresses[ip] };
            geo_db.servers[id] = data;
            resolveLocation(id, data);
            continue;
        }

        // if it doesnt, push to table for fetching
        if (!datacentersToFetch[dc]) datacentersToFetch[dc] = {};
        if (!datacentersToFetch[dc][ip]) datacentersToFetch[dc][ip] = [];
        datacentersToFetch[dc][ip].push(id);
    }

    // just fetch the missing ones
    if (Object.keys(datacentersToFetch).length > 0) {
        const locations = await getIPLocation(datacentersToFetch, gameId);

        const attemptedIds = Object.values(datacentersToFetch).flatMap(ips => Object.values(ips)).flat();

        if (locations) {
            for (const [serverId, loc] of Object.entries(locations)) {
                const location = loc.city ? `${loc.city}, ${loc.country_name}` : loc.country_name;
                const info = {
                    country: loc.country, country_name: loc.country_name, city: loc.city,
                    region: loc.region, region_code: loc.region_code,
                    latitude: loc.latitude, longitude: loc.longitude,
                    timezone: loc.timezone, postal_code: loc.postal_code, continent: loc.continent,
                };
                const finalData = { ip: loc.ip, location, ...info };
                geo_db.servers[serverId] = finalData;
                geo_db.addresses[loc.ip] = { location, ...info };
                resolveLocation(serverId, finalData);
            }
            saveData({ geo_db });
        }

        attemptedIds.forEach(id => {
            if (!locationCache[id]) {
                resolveLocation(id, null); 
            }
        });
    }
}

// separate player and rating in game cards
//observeAdded(".game-card-info", (el) => {
//    if (el.dataset.grouped) return; // guard
//    el.dataset.grouped = "true";
//
//    const children = [...el.children];
//    if (children.length < 4) return; // safety check
//
//    const group1 = document.createElement("div");
//    group1.append(children[0], children[1]);
//
//    const group2 = document.createElement("div");
//    group2.append(children[2], children[3]);
//
//    el.setAttribute("style", "display: flex !important; justify-content: space-between; padding-top: 4px !important;")
//    group1.setAttribute("style", "display: inline-flex !important; align-items: center !important;")
//    group2.setAttribute("style", "display: inline-flex !important; align-items: center !important;")
//
//    el.append(group1, group2);
//})

if (window.location.href.includes("/games/")) { 
    const pageGameId = parseInt(window.location.href.split("games/")[1].split("/")[0])
    log(`User loaded game ${pageGameId}`)

    // Warm up the client's own location early (cached, requested only once). This
    // makes /me fire as soon as the page loads so client-ping cells can be filled
    // the moment each server's coordinates arrive — independent of any server's
    // geolocation success.
    getClientLocation();

    /* --------------------------- Server geolocation --------------------------- */

    // intercept servers request
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("scripts/pages/games/inject.js");
    document.documentElement.appendChild(script);

    // already captured servers
    window.server_list = []

    // when request appears
    window.addEventListener("message", async (event) => {
        if (window.__filter_active__) return;
        if (event.data.type === "ROBLOX_SERVERS") {
            let servers = event.data.data.data; // new servers

            const existingIds = new Set(server_list.map(s => s.id));
            const newServers = servers.filter(s => !existingIds.has(s.id));

            // full server lst
            server_list = [...server_list, ...newServers];
            log("Total shown servers:", server_list.length);

            // batch all servers
            processServersLocationBatch(servers, pageGameId);
        }
    })

    // download roblox dialog but in html for fast launch download
    download_roblox_dialog = `<div data-state="open" class="foundation-web-dialog-overlay padding-y-medium foundation-web-portal-zindex bg-common-backdrop" style="pointer-events: auto;"><div role="dialog" id="radix-3" aria-describedby="radix-5" aria-labelledby="radix-4" data-state="open" class="relative radius-large bg-surface-100 stroke-muted stroke-standard foundation-web-dialog-content shadow-transient-high install-dialog" data-size="Large" tabindex="-1" style="pointer-events: auto;"><div class="absolute foundation-web-dialog-close-container"><button type="button" class="foundation-web-close-affordance flex stroke-none bg-none cursor-pointer relative clip group/interactable focus-visible:outline-focus disabled:outline-none bg-over-media-100 padding-medium radius-circle" aria-label="Close"><div role="presentation" class="absolute inset-[0] transition-colors group-hover/interactable:bg-[var(--color-state-hover)] group-active/interactable:bg-[var(--color-state-press)] group-disabled/interactable:bg-none"></div><span role="presentation" class="grow-0 shrink-0 basis-auto icon icon-regular-x size-[var(--icon-size-large)]"></span></button></div><div class="padding-x-xlarge padding-top-xlarge padding-bottom-xlarge content-default"><div class="flex flex-col gap-xlarge padding-xlarge"><div class="flex flex-col gap-xsmall"><h2 id="radix-4" class="text-heading-medium content-emphasis padding-none">Thanks for downloading Roblox</h2><p class="text-body-large">Just follow the steps below to install Roblox. Download should start in a few seconds. If it doesn't, <a href="https://www.roblox.com/download/client?os=win" class="download-link-underline">restart the download</a>.</p></div><div></div> <div class="flex gap-xxlarge"><section class="flex flex-col gap-large grow basis-0"><h3 class="text-title-large content-emphasis padding-none">Install Instructions</h3><ol class="download-instructions-list flex flex-col gap-xlarge margin-none padding-left-large text-body-medium"><li class="padding-left-medium">Once downloaded, double-click the <b>RobloxPlayerInstaller.exe</b> file in your Downloads folder.</li><li class="padding-left-medium">Double-click the <b>RobloxPlayerInstaller</b> to install the app.</li><li class="padding-left-medium">Follow the instructions to install Roblox to your computer.</li><li class="padding-left-medium">Now that it’s installed, <a id="download-join-experience" class="download-link-underline">join the experience</a>.</li></ol></section><div></div> <div class="stroke-standard stroke-default"></div><div></div> <section class="flex flex-col grow basis-0 gap-xxlarge"><div class="flex flex-col gap-small"><h3 class="text-label-large content-emphasis padding-none">Don't forget the mobile app</h3><p class="text-body-medium">Scan this code with your phone's camera to get Roblox.</p></div><div class="flex grow justify-center items-center bg-shift-100 radius-medium padding-x-large"><div class="radius-medium padding-small bg-[white]"><img class="size-2100" src="https://images.rbxcdn.com/79852c254bf43f36.webp" alt=""></div></div></section></div></div></div></div></div>`

    function animateCounter(element, from, to, duration = 1000) {
        const start = performance.now();

        function update(now) {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);

            const eased = 1 - Math.pow(1 - progress, 3);

            const current = Math.round(from + (to - from) * eased);
            element.textContent = current.toLocaleString(); // format like: 200530 → "200,530"

            if (progress < 1) {
                requestAnimationFrame(update);
            }
        }

        requestAnimationFrame(update);
    }

    /* ------------------------------- Fast launch ------------------------------ */

    if (window.location.href.includes("#fast-join")) {
        history.replaceState(null, "", window.location.pathname)

        //<div class="app-icon-bluebg app-icon-windows size-1600" role="img" aria-label="App Icon"></div> roblox icon class
        // adds custom fast launch dialog
        document.addEventListener("DOMContentLoaded", () => {
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
                            Fast launching instance...
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

            const launchDialog = document.querySelector(".foundation-web-dialog-overlay")
            const launchDialogContent = launchDialog.querySelector(".foundation-web-dialog-content")

            const closeBtnLaunch = launchDialogContent.querySelector(".foundation-web-dialog-close-container button")
            closeBtnLaunch.addEventListener("click", () => {
                launchDialog.remove()
            })

            const dialogBtn = launchDialogContent.querySelector(".dialog-button-container button")
            setTimeout(() => {
                dialogBtn.innerHTML = "Download Roblox"
                dialogBtn.addEventListener("click", () => {
                    launchDialog.remove()
                    document.body.insertAdjacentHTML("beforeend", download_roblox_dialog)
                    
                    const installDialog = document.querySelector(".foundation-web-dialog-overlay .install-dialog")
                    const closeBtnInstall = installDialog.querySelector(".foundation-web-dialog-close-container button")
                    closeBtnInstall.addEventListener("click", () => {
                        installDialog.parentElement.remove()
                    })
                    
                    // download roblox
                    const dl = document.createElement("a")
                    dl.href = "https://www.roblox.com/download/client?os=win"
                    dl.style.display = "none"
                    document.body.appendChild(dl)
                    dl.click()
                    document.body.removeChild(dl)
                })
            }, 5000)


            // launch game
            const a = document.createElement("a")
            a.href = `roblox://experiences/start?placeId=${pageGameId}`
            a.style.display = "none"
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
        })
    }

    /* ------------------------------ Playtime map ------------------------------ */

    observeElement(".game-description-container", async () => {
        const container = document.querySelector(".game-description-container")
        
        let t = document.createElement("h3")
        t.textContent = "Playtime History"
        container.appendChild(t)

        // load data
        let playtime_data = await loadData("ext_playtime_data")
        playtime_data = playtime_data[pageGameId] || {}

        // playtime history, also formatted in the cal format
        let history = playtime_data["history"] || {}
        let formatted_history = Object.entries(history).map(([date, value]) => ({ date, value }))

        log(`Got playtime data`, playtime_data)

        const today = new Date();
        const timeOffset = new Date(today.getFullYear() - 1, today.getMonth() + 1,8);

        const wrapper = document.createElement("div");
        wrapper.style.cssText = "display: flex; align-items: flex-start;";

        // day labels on the left
        const dayLabels = document.createElement("div");
        const cellSize = 13.25 + 2;
        const labelTopPadding = 22;
        dayLabels.style.cssText = `
            display: flex;
            flex-direction: column;
            padding-top: ${labelTopPadding}px;
            margin-right: 4px;
            font-size: 10px;
            color: #8b949e;
            line-height: ${cellSize}px;
        `;
        dayLabels.innerHTML = `
            <span style="height:${cellSize}px"></span>
            <span style="height:${cellSize}px">Mon</span>
            <span style="height:${cellSize}px"></span>
            <span style="height:${cellSize}px">Wed</span>
            <span style="height:${cellSize}px"></span>
            <span style="height:${cellSize}px">Fri</span>
            <span style="height:${cellSize}px"></span>
        `;

        let heatmap = document.createElement("div");
        heatmap.id = "cal-heatmap";

        wrapper.appendChild(dayLabels);
        wrapper.appendChild(heatmap);
        container.appendChild(wrapper);

        let cal = new CalHeatmap();
        cal.paint(
            {
                theme: "dark",
                itemSelector: "#cal-heatmap",
                date: {
                    start: timeOffset,
                },
                range: 12,
                domain: {
                    type: "month",
                    gutter: 4,
                    label: {
                        text: "MMM",
                        position: "top",
                    }
                },
                subDomain: {
                    type: "day",
                    radius: 3,
                    width: 13,
                    height: 13,
                },
                data: {
                    source: formatted_history,
                    x: "date",
                    y: "value"
                },
                scale: {
                    color: {
                        type: 'linear',
                        range: ["#2d333b", "#335fff"],
                        domain: [0, 360]
                    }
                },
            },
            [[Tooltip, {
                text: (timestamp, value, dayjsDate) => {
                    return value
                        ? `${dayjsDate.format("MMM D, YYYY")}: ${(value / 60).toFixed(2)} hours`
                        : dayjsDate.format("MMM D, YYYY");
                }
            }]]
        );
    })

    /* ----------------------------- Live game stats ---------------------------- */

    async function updateGameDetails() {
        let details = await getGameDetails(pageGameId)

        let players = details["playing"]
        let visits = details["visits"]
        let favorites = details["favoritedCount"]

        let parseInner = (el) => parseInt(el.innerText.replace(/\D/g, '')) || 0

        const playingText = document.querySelector(".game-stat-container li:nth-child(1) .text-lead.font-caption-body")
        const favoritesText = document.querySelector(".game-stat-container li:nth-child(2) .text-lead.font-caption-body")
        const visitsText = document.querySelector(".game-stat-container li:nth-child(3) .text-lead.font-caption-body")

        if (visitsText) {
            animateCounter(visitsText, parseInner(visitsText), visits, gameDetailsUpdateSecs * 1000);
        }
        if (favoritesText) {
            animateCounter(favoritesText, parseInner(favoritesText), favorites, gameDetailsUpdateSecs * 1000);
        }
        if (playingText) {
            animateCounter(playingText, parseInner(playingText), players, gameDetailsUpdateSecs * 1000);
        }
    }

    setInterval(updateGameDetails, gameDetailsUpdateSecs * 1000)


    /* ------------------------- More server logic lmao ------------------------- */

    // wait for full server id in server_list
    function waitForServerId(id, timeout = 10000) {
        return new Promise((resolve, reject) => {
            if (server_list.find(s => s.id.includes(id))) return resolve(server_list.find(s => s.id.includes(id)));

            const start = Date.now();
            const interval = setInterval(() => {
                const found = server_list.find(s => s.id.includes(id));
                if (found) {
                    clearInterval(interval);
                    resolve(found);
                } else if (Date.now() - start > timeout) {
                    clearInterval(interval);
                    reject(`Timeout waiting for server ${id}`);
                }
            }, 100);
        });
    }

    // Build the gradient border around a public-server card based on which
    // ping(s) are known:
    //   - both server + client ping → left half server color, right half client
    //     color, merged by a soft gradient at the midline
    //   - only one of them           → that color used fully (no gradient needed)
    //   - neither                    → no border is added
    // Colors come from the ping-status palette already used for the pills. The
    // element is expected to carry the `card-item-public-server` class.
    function updatePingBorder(cardEl, serverColor, clientColor) {
        if (!cardEl) return;
        if (!serverColor && !clientColor) return; // nothing to draw

        cardEl.style.setProperty("--ping-border-server", serverColor || clientColor);
        cardEl.style.setProperty("--ping-border-client", clientColor || serverColor);
        cardEl.classList.add("ping-border");
    }

    // when server element appears
    window.handleServerElement = async function(el) {
        log("Server element added/changed:", el);

        // if id (text) changes, refetch
        const serverIdText = el.querySelector(".game-server-details .server-id-text");

        let lastText = serverIdText.textContent;

        const observer = new MutationObserver(() => {
            const newText = serverIdText.textContent;
            if (newText !== lastText) {
                lastText = newText;
                handleServerElement(el);
            }
        });

        observer.observe(serverIdText, { childList: true, subtree: true, characterData: true });

        let shortServerId = serverIdText.textContent.replace("ID:", "").trim()

        let serverInfo = await waitForServerId(shortServerId)
        const serverId = serverInfo["id"]
        const serverPing = serverInfo["ping"] || 80
        const serverPingColor = getPingStatus(serverPing).color;
        const serverFps = serverInfo["fps"]

        function getPingStatus(ping) {
            if (ping <= 40) return { color: "#59f6ff", text: "Elite" };
            if (ping <= 120) return { color: "#75ff74", text: "Good" };
            if (ping <= 200) return { color: "#ffe143", text: "Stable" };
            return { color: "#ff4c4c", text: "Lagging" };
        }

        serverIdText.textContent = `ID: ${serverId}`

        const serverDetails = el.querySelector(".game-server-details")

        let infoWrapper = serverDetails.querySelector(".info-wrapper")
        if (!infoWrapper) {
            infoWrapper = document.createElement("div")
            infoWrapper.classList.add("info-wrapper")
            infoWrapper.innerHTML = `
            <div class="flex items-center justify-center" style="gap:5px; margin-bottom:10px !important">
                <div class="horizontal-pill flex items-center" style="gap:5px" title="Server ping">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${getPingStatus(serverPing).color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-server-icon lucide-server"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>
                    <p class="server-ping" style="color: ${getPingStatus(serverPing).color} !important">${serverPing}ms</p>
                </div>
                <div class="horizontal-pill flex items-center" style="gap:5px" title="Your ping to this server">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="24" style="flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-laptop-minimal-icon lucide-laptop-minimal"><rect width="18" height="12" x="3" y="4" rx="2" ry="2"/><line x1="2" x2="22" y1="20" y2="20"/></svg>
                    <p class="client-ping">-</p>
                </div>
                <div class="horizontal-pill flex items-center" style="gap:5px">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="24" style="flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-gauge-icon lucide-gauge"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>
                    <p class="server-fps">${Math.round(serverFps)} fps</p>
                </div>
            </div>
            <div class="flex items-center" style="gap:8px;">
                <span class="location-flag-container">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-ban-icon lucide-ban"><circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/></svg>
                </span>
                <p class="server-location" style="width: 100%;">Full server</p>
            </div>

            <div class="rbx-divider" style="margin-top:10px;"></div>
            `
            serverDetails.querySelector("span").prepend(infoWrapper)
        }

        // location pin svg
        // <svg xmlns="http://www.w3.org/2000/svg" width="20" height="24" style="flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-map-pin-icon lucide-map-pin"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>

        const serverLocEl = infoWrapper.querySelector("div .server-location")

        try {
            const joinBtn = serverDetails.querySelector("span .game-server-join-btn")

            const server_queue = await waitForQueue(serverId)
            joinBtn.textContent = joinBtn.textContent.split(" (")[0].trim() + (server_queue > 0 ? ` (${server_queue} in queue)` : "")

            const serverLocation = await waitForLocation(serverId);
            serverLocEl.textContent = serverLocation.location ?? "Full server";

            let flagContainer = infoWrapper.querySelector("div .location-flag-container")
            flagContainer.innerHTML = `<img src="https://hatscripts.github.io/circle-flags/flags/${serverLocation.country.toLowerCase()}.svg">`
        } catch (e) {
            serverLocEl.textContent = "Full server";
        }

        // Client ping: distance between client and server lat/long. The client
        // location (/me) is fetched UNCONDITIONALLY here — it's cached so it only
        // hits the network once — and we only compute the number once the server's
        // coordinates are also known. This guarantees /me is always requested even
        // if a server can't be geolocated.
        // Holds the resolved client-ping color (null when the ping couldn't be
        // computed, e.g. client/server geolocation unavailable).
        let clientPingColor = null;
        const clientPingWrapper = infoWrapper.querySelector(".client-ping").parentElement;
        const clientPingText = clientPingWrapper.querySelector(".client-ping");
        const clientPingSvg = clientPingWrapper.querySelector("svg");
        const serverLocation = locationCache[serverId];
        if (clientPingWrapper) {
            try {
                const clientLoc = await getClientLocation();
                if (clientLoc && serverLocation && serverLocation.latitude != null && serverLocation.longitude != null) {
                    const clientPing = estimatePing(clientLoc.latitude, clientLoc.longitude, serverLocation.latitude, serverLocation.longitude);
                    const status = getPingStatus(clientPing);
                    clientPingColor = status.color;

                    clientPingText.textContent = `≈ ${clientPing}ms`;
                    clientPingText.style.setProperty("color", status.color, "important");
                    clientPingSvg.setAttribute("stroke", status.color);
                } else {
                    clientPingText.textContent = "-";
                }
            } catch (e) {
                clientPingText.textContent = "-";
            }
        }

        // Both pings are now settled (server known from the start, client either
        // resolved or left null). Add the gradient border around the public-server
        // card: half server color + half client color when both exist, or the
        // single known color if only one does. If neither exists, no border.
        updatePingBorder(el, serverPingColor, clientPingColor);
    }

    observeElement("#rbx-public-game-server-item-container", (container) => {
        container.querySelectorAll(".rbx-public-game-server-item .card-item").forEach(handleServerElement);
        observeAdded(".rbx-public-game-server-item .card-item", (el) => {
            handleServerElement(el)
        }, container);
    });

    /* ------------------------------ Subplaces tab ----------------------------- */

    // wait for nav tabs where about, server, etc is
    observeElement(".nav.nav-tabs", async () => {
        const navTabs = document.querySelector(".nav.nav-tabs")
        const tabContents = document.querySelector(".tab-content.rbx-tab-content")

        // add subplaces tab
        navTabs.insertAdjacentHTML("beforeend", `
            <li id="tab-game-subplaces" class="rbx-tab tab-game-subplaces">
                <a class="rbx-tab-heading" href="#game-subplaces">
                    <span class="text-lead">Subplaces</span>
                </a>
            </li>
        `)

        // the panel needed where subplaces appear
        tabContents.insertAdjacentHTML("beforeend", `
        <div class="tab-pane game-subplaces" id="game-subplaces">
        </div>
        `)
        
        let subplacesPane = tabContents.querySelector(".tab-pane.game-subplaces")
        subplacesPane.style.display="none !important"

        // get every subplace
        let subplaces_list = await getSubplacesFromGame(pageGameId)
        subplaces_list.forEach(async (subplace) => {
            let subplaceName = subplace["name"]
            let subplaceId = subplace["id"]
            let subplaceThumb = await getPlaceIdThumbnail(subplaceId)

            const panel = document.createElement("div")
            subplacesPane.appendChild(panel)
            panel.classList.add("subplace-panel")

            panel.innerHTML = `
                <img class="subplace-thumbnail" src="${subplaceThumb}">
                <p class="subplace-title" style="color: var(--color-content-emphasis) !important;">${subplaceName}</p>
                <p class="subplace-id info-label">${subplaceId}</p>
                <button type="button" class="mini-playbtn-subplace"><span class="icon-common-play"></span></button>
            `

            // play button, launch roblox
            const play_btn = panel.querySelector(".mini-playbtn-subplace")
            play_btn.addEventListener("click", () => {
                window.location.href = `roblox://experiences/start?placeId=${subplaceId}`
            })
        })

        // if init hash is
        if (window.location.hash === "#game-subplaces" || window.location.hash === "#!/game-subplaces") {
            tabContents.querySelectorAll(".tab-pane").forEach(tab => {
                tab.classList.remove("active")
            })
            subplacesPane.classList.add("active")
            subplacesPane.style.display = "grid !important"
        } else {
            subplacesPane.style.display = "none !important"
        }

        // if hash changes to
        window.addEventListener("hashchange", async () => {
            if (window.location.hash === "#game-subplaces" || window.location.hash === "#!/game-subplaces") {
                tabContents.querySelectorAll(".tab-pane").forEach(tab => {
                    tab.classList.remove("active")
                })
                subplacesPane.classList.add("active")
                subplacesPane.style.display = "grid !important"
            } else {
                subplacesPane.style.display = "none !important"
            }
        })
        
    })
}