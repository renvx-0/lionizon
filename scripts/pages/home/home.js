(async () => {
    function formatNumber(n) {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M+`;
        if (n >= 1_000) return `${Math.floor(n / 1_000)}K+`;
        return n.toString();
    }

    const saved_settings = await loadData("lionizon_settings", { home_banner_enabled: "Enabled", user_presence_circles: "Enabled", game_presence_thumbnail_preview: "Enabled" })
    await saveData({ lionizon_settings: saved_settings })

    if (window.location.href.includes("/home") || window.location.href.includes("/friends") || (window.location.href.includes("/users"))) {

        const previousStates = new Map() // userId -> currentGame
        const observedTiles = new Set()

        const status_observer = new MutationObserver(() => {
            const friend_cards = document.querySelectorAll(
                ".friends-carousel-list-container .avatar.avatar-card-fullbody, " +
                ".avatar-card-content .avatar.avatar-card-fullbody"
            )
            
            friend_cards.forEach(async card => {
                const profileLink = card.querySelector(".avatar-card-link")?.href
                if (!profileLink) return;

                const userId = profileLink.split("/users/")[1].split("/")[0]
                const presenceIcon = card.querySelector("[data-testid='presence-icon']")
                const currentGame = presenceIcon ? presenceIcon.getAttribute("title") : null
                const previousGame = previousStates.get(userId)
                const user_status = presenceIcon ? presenceIcon.classList[0] : null

                if (previousGame !== currentGame) {
                    previousStates.set(userId, currentGame)

                    const image_card = card.querySelector(".avatar-card-image")
                    if (saved_settings.user_presence_circles === "Enabled") {
                        if (image_card) {
                            if (user_status == "game") image_card.style.border = "solid 3px #02b757"
                            else if (user_status == "online") image_card.style.border = "solid 3px #00a2ff"
                            else if (user_status == "studio") image_card.style.border = "solid 3px #f68802"
                            else image_card.style.border = "none"
                        }
                    }

                    if (user_status !== "game") return;

                    let presence = null;
                    let attempts = 0;
                    while (!presence && attempts++ < 5) {
                        presence = (await getPresences([userId]))?.[0]
                    }
                    if (!presence || !presence.gameId) return;

                    let serverId = presence.gameId
                    let placeId = presence.placeId
                    let universeId = presence.universeId
 
                    if (saved_settings.game_presence_thumbnail_preview === "Enabled" && placeId) {
                        let placeThumbnail = await getPlaceIdThumbnail(placeId)
                        const avatar_status = card.querySelector(".avatar-status")
                        avatar_status.insertAdjacentHTML("afterend", `
                            <img src="${placeThumbnail}" class=".game-presence-preview" style="position: absolute; height: 28px; right: 0; bottom: 0; border-radius: 7px;">
                        `)
                    }

                    const tile = card.closest(".friends-carousel-tile") ?? card.closest(".avatar-card-content")
                    if (tile && !observedTiles.has(tile)) {
                        observedTiles.add(tile)
                        
                        observeAdded("div", async (el) => {
                            if (el.querySelector(".friend-tile-dropdown")) {
                                if (el.querySelector(".lionizon-info")) return;

                                processServersLocationBatch([{ id: serverId }], placeId);

                                const [game_details, votes] = await Promise.all([
                                    getGameDetails(universeId, true),
                                    getGameVotes(universeId, true),
                                ]);

                                let playing = formatNumber(game_details.playing)
                                let vote_percentage = Math.round((votes.upVotes / (votes.upVotes + votes.downVotes)) * 100);

                                let gamedetailsEl = el.querySelector(".friend-presence-info")
                                //let joinBtn = popup_info.querySelector(".btn-full-width")
//
                                //if (!joinBtn.dataset.originalText) {
                                //    joinBtn.dataset.originalText = joinBtn.textContent.split(" (")[0].trim();
                                //}

                                gamedetailsEl.insertAdjacentHTML("beforeend",`
                                    <div class="flex items-center full-white-text lionizon-info" style="gap:5px; margin-top:5px; margin-bottom:5px !important;">
                                        <div class="horizontal-pill flex items-center small-pill" style="gap:5px">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>
                                            <p>${playing}</p>
                                        </div>
                                        <div class="horizontal-pill flex items-center small-pill" style="gap:5px">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/><path d="M7 10v12"/></svg>
                                            <p>${vote_percentage}%</p>
                                        </div>
                                    </div>
                                `);

                                gamedetailsEl.parentElement.insertAdjacentHTML("afterend", `
                                    <div class="rbx-divider" style="width:100%"></div>
                                    <div class="flex items-center full-white-text lionizon-info location-data" style="gap:8px;">
                                        <div class="location-flag-container">
                                            <div aria-hidden="true" class="flex"><svg class="foundation-web-loading-spinner" width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M10 2.75C8.56609 2.75 7.16438 3.1752 5.97212 3.97185C4.77986 4.76849 3.85061 5.90078 3.30188 7.22554C2.75314 8.55031 2.60957 10.008 2.88931 11.4144C3.16905 12.8208 3.85955 14.1126 4.87348 15.1265C5.88741 16.1405 7.17924 16.831 8.5856 17.1107C9.99196 17.3904 11.4497 17.2469 12.7745 16.6981C14.0992 16.1494 15.2315 15.2201 16.0282 14.0279C16.8248 12.8356 17.25 11.4339 17.25 10C17.25 9.58579 17.5858 9.25 18 9.25C18.4142 9.25 18.75 9.58579 18.75 10C18.75 11.7306 18.2368 13.4223 17.2754 14.8612C16.3139 16.3002 14.9473 17.4217 13.3485 18.0839C11.7496 18.7462 9.9903 18.9195 8.29296 18.5819C6.59563 18.2443 5.03653 17.4109 3.81282 16.1872C2.58911 14.9635 1.75575 13.4044 1.41813 11.707C1.08051 10.0097 1.25379 8.25037 1.91606 6.65152C2.57832 5.05267 3.69983 3.6861 5.13876 2.72464C6.57769 1.76318 8.26942 1.25 10 1.25C10.4142 1.25 10.75 1.58579 10.75 2C10.75 2.41421 10.4142 2.75 10 2.75Z"></path></svg></div>
                                        </div>
                                        <p style="font-size: 14px">Fetching location...</p>
                                    </div>
                                `)

                                let locationDataEl = gamedetailsEl.parentElement.parentElement.querySelector(".location-data");

                                waitForLocation(serverId).then(async location_data => {
                                    if (!locationDataEl) return;

                                    let queue = await waitForQueue(serverId)

                                    if (location_data && location_data.location) {
                                        locationDataEl.innerHTML = `
                                            <div class="location-flag-container">
                                                <img src="https://hatscripts.github.io/circle-flags/flags/${location_data.country.toLowerCase()}.svg" width="20">
                                            </div>
                                            <p style="font-size: 14px">${location_data.location}</p>
                                        `;
                                    } else if (queue > 0) {
                                        locationDataEl.innerHTML = `
                                            <div class="location-flag-container">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/></svg>
                                            </div>
                                            <p style="font-size: 14px">Full server</p>
                                        `;
                                    } else {
                                        locationDataEl.innerHTML = `
                                            <div class="location-flag-container">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/></svg>
                                            </div>
                                            <p style="font-size: 14px">Reserved server</p>
                                        `;
                                    }
                                });
                            }
                        }, tile)
                    }
                }
            })
        })

        status_observer.observe(document, { childList: true, subtree: true })
    }

    // Welcome banner
    if (window.location.href.includes("/home") || window.location.href.includes("/users")) {
        observeElement(".rbx-left-col", (el) => el.classList.add("nav-show"));

        let banner_created = false;
        const banner_observer = new MutationObserver(async () => {
            const content = document.querySelector("#HomeContainer");
            if (content && !content.querySelector("#profile-view-banner") && !banner_created && saved_settings.home_banner_enabled === "Enabled") {
                banner_created = true;
                const userId = await getLoggedInUserId();
                const displayName = await getLoggedInUserDisplay();
                const presence = await getPresences([userId]);
                const presenceType = presence[0]?.userPresenceType;

                const main_frame = document.createElement("div");
                main_frame.id = "profile-view-banner";
                Object.assign(main_frame.style, {
                    background: "#191a1f", height: "215px", width: "100%", display: "flex", 
                    alignItems: "center", gap: "35px", borderRadius: "20px", padding: "25px", marginBottom: "20px"
                });
                content.prepend(main_frame);

                const thumb_span = document.createElement("span");
                thumb_span.className = "thumbnail-2d-container avatar-card-image";
                Object.assign(thumb_span.style, { width: "165px", height: "165px", borderRadius: "100%" });
                
                if (presenceType == 2) thumb_span.style.border = "solid 3px #02b757";
                else if (presenceType == 1) thumb_span.style.border = "solid 3px #00a2ff";
                else if (presenceType == 3) thumb_span.style.border = "solid 3px #f68802";

                const userThumb = await getUsersThumbnail([userId]);
                const img = document.createElement("img");
                img.src = userThumb[0].imageUrl;
                thumb_span.appendChild(img);
                main_frame.appendChild(thumb_span);

                const text = document.createElement("h1");
                text.innerText = `Hello, ${displayName}!`;
                text.style.fontSize = "50px";
                main_frame.appendChild(text);
            }
        });
        banner_observer.observe(document, { childList: true, subtree: true });
    }
})();