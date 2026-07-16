// ---------------------------------------------------------------------------
// Region selector
//
// Adds a "Region" button next to the existing server filter (<select>). The
// button opens a dropdown listing every region that currently has servers for
// this game (grouped by continent, with a live server count). Picking one
// re-renders the server list filtered to that country via applyServerFilter().
//
// All of the heavy lifting (fetching every server, geolocating, caching) is
// already provided by the shared globals from server_filter.js / games.js:
//   getAllServersCached(), processServersLocationBatch(), waitForLocation(),
//   locationCache, applyServerFilter().
// ---------------------------------------------------------------------------

const REGION_CONTINENT_ORDER = ["NA", "SA", "EU", "AS", "AF", "OC", "AN"];
const REGION_CONTINENT_LABELS = {
    NA: "North America",
    SA: "South America",
    EU: "Europe",
    AS: "Asia",
    AF: "Africa",
    OC: "Oceania",
    AN: "Antarctica",
    "??": "Unknown"
};

let currentRegionCode = null;
let regionDropdownEl = null;

// Build { continent: { countryCode: { name, count } } } from the (already
// geolocated) full server list for the current game.
async function buildRegionTree(pageGameId, onProgress) {
    const data = await getAllServersCached(pageGameId);
    const all = data.server_list ?? [];

    // Single geolocation pass over the whole list (cached after the first run,
    // shared with the sort filters in server_filter.js). Subsequent region
    // opens reuse the already-placed servers instead of re-locating everything.
    // onProgress (first open only) feeds the live "Loading regions… N/M" text.
    await geolocateAllServersOnce(pageGameId, onProgress);

    const tree = {};
    let unknownCount = 0;

    for (const s of all) {
        const loc = locationCache[s.id];
        if (!loc || !loc.country) {
            unknownCount++;
            continue;
        }
        const continent = loc.continent || "??";
        if (!tree[continent]) tree[continent] = {};
        if (!tree[continent][loc.country]) {
            tree[continent][loc.country] = { name: loc.country_name || loc.country, count: 0 };
        }
        tree[continent][loc.country].count++;
    }

    return { tree, unknownCount };
}

function closeRegionDropdown() {
    regionDropdownEl?.remove();
    regionDropdownEl = null;
    document.removeEventListener("click", onRegionOutsideClick, true);
    document.removeEventListener("keydown", onRegionKeydown, true);
}

function onRegionOutsideClick(e) {
    if (regionDropdownEl && !regionDropdownEl.contains(e.target) && !e.target.closest("#region-filter-btn")) {
        closeRegionDropdown();
    }
}

function onRegionKeydown(e) {
    if (e.key === "Escape") closeRegionDropdown();
}

// Render the dropdown anchored under `anchorBtn`.
function showRegionDropdown(anchorBtn, { tree, unknownCount }, onSelect) {
    closeRegionDropdown();

    const theme = [...document.querySelector("#rbx-body").classList].find(c => c.includes("dark") || c.includes("light"));

    const dropdown = document.createElement("div");
    dropdown.className = "lionizon-region-dropdown";
    dropdown.classList.add(theme || "dark", "stroke-contrast-alpha", "stroke-standard");

    const rect = anchorBtn.getBoundingClientRect();
    Object.assign(dropdown.style, {
        position: "fixed",
        top: `${rect.bottom + 6}px`,
        left: `${rect.left}px`,
        zIndex: "999999",
        minWidth: "260px",
        maxWidth: "320px",
        padding: "10px",
        borderRadius: "12px",
        boxShadow: "0 15px 20px 0 var(--color-common-shadow)"
    });
    dropdown.style.setProperty("border-color", "color-mix(in srgb, var(--color-stroke-contrast-alpha) 30%, transparent)", "important");
    dropdown.style.setProperty("background-color", "var(--color-surface-100)", "important");

    // ----- search header -----
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Search region...";
    search.className = "lionizon-region-search";
    dropdown.appendChild(search);

    // ----- "All regions" reset -----
    const allRow = document.createElement("div");
    allRow.className = "lionizon-region-item";
    if (!currentRegionCode) allRow.classList.add("selected");
    const allLabel = document.createElement("span");
    allLabel.textContent = "All regions";
    allLabel.style.fontWeight = "600";
    allRow.appendChild(allLabel);
    allRow.addEventListener("click", () => { closeRegionDropdown(); onSelect(null); });
    dropdown.appendChild(allRow);

    if (unknownCount > 0) {
        const unkRow = document.createElement("div");
        unkRow.className = "lionizon-region-item";
        if (currentRegionCode === "__unknown__") unkRow.classList.add("selected");
        const unkLabel = document.createElement("span");
        unkLabel.textContent = "Unknown region";
        unkRow.appendChild(unkLabel);
        const unkCount = document.createElement("span");
        unkCount.className = "lionizon-region-count";
        unkCount.textContent = unknownCount;
        unkRow.appendChild(unkCount);
        unkRow.addEventListener("click", () => { closeRegionDropdown(); onSelect("__unknown__"); });
        dropdown.appendChild(unkRow);
    }

    // ----- grouped country list -----
    const listWrap = document.createElement("div");
    listWrap.className = "lionizon-region-list";
    dropdown.appendChild(listWrap);

    function rebuildList(filterText = "") {
        listWrap.innerHTML = "";
        const ft = filterText.trim().toLowerCase();

        const continents = REGION_CONTINENT_ORDER.filter(c => tree[c]).concat(
            Object.keys(tree).filter(c => !REGION_CONTINENT_ORDER.includes(c))
        );

        let any = false;

        for (const continent of continents) {
            const countries = tree[continent];
            const entries = Object.entries(countries).sort((a, b) => a[1].name.localeCompare(b[1].name));

            const visible = entries.filter(([code, info]) => !ft || info.name.toLowerCase().includes(ft) || code.toLowerCase() === ft);
            if (visible.length === 0) continue;
            any = true;

            const header = document.createElement("div");
            header.className = "lionizon-region-group-header";
            header.textContent = REGION_CONTINENT_LABELS[continent] || continent;
            listWrap.appendChild(header);

            for (const [code, info] of visible) {
                const row = document.createElement("div");
                row.className = "lionizon-region-item";
                if (currentRegionCode === code) row.classList.add("selected");

                if (code.length === 2) {
                    const flag = document.createElement("img");
                    flag.className = "lionizon-region-flag";
                    flag.src = `https://hatscripts.github.io/circle-flags/flags/${code.toLowerCase()}.svg`;
                    flag.alt = "";
                    row.appendChild(flag);
                }

                const label = document.createElement("span");
                label.textContent = info.name;
                label.className = "lionizon-region-name";
                row.appendChild(label);

                const count = document.createElement("span");
                count.className = "lionizon-region-count";
                count.textContent = info.count;
                row.appendChild(count);

                row.addEventListener("click", () => { closeRegionDropdown(); onSelect(code); });
                listWrap.appendChild(row);
            }
        }

        if (!any) {
            const empty = document.createElement("div");
            empty.className = "lionizon-region-empty";
            empty.textContent = "No matching regions";
            listWrap.appendChild(empty);
        }
    }

    rebuildList();
    search.addEventListener("input", () => rebuildList(search.value));

    document.body.appendChild(dropdown);
    regionDropdownEl = dropdown;
    search.focus();

    // clamp inside the viewport
    const dr = dropdown.getBoundingClientRect();
    const pad = 8;
    if (dr.right > window.innerWidth - pad) {
        dropdown.style.left = `${Math.max(pad, window.innerWidth - dr.width - pad)}px`;
    }
    if (dr.bottom > window.innerHeight - pad) {
        dropdown.style.top = `${Math.max(pad, window.innerHeight - dr.height - pad)}px`;
    }

    setTimeout(() => {
        document.addEventListener("click", onRegionOutsideClick, true);
        document.addEventListener("keydown", onRegionKeydown, true);
    }, 0);
}

function setRegionButtonLabel(code) {
    const btn = document.querySelector("#region-filter-btn");
    if (!btn) return;
    if (!code) {
        btn.textContent = "Region: All";
    } else if (code === "__unknown__") {
        btn.textContent = "Region: Unknown";
    } else {
        const name = (locationCache && Object.values(locationCache).find(l => l && l.country === code)?.country_name) || code;
        btn.textContent = `Region: ${name}`;
    }
}

if (window.location.href.includes("/games/")) {
    observeElement(".server-list-options", async (el) => {
        el.insertAdjacentHTML("beforeend", `
            <button id="region-filter-btn" type="button" class="btn-control-xs btn-secondary-md" style="margin-left:10px">
                Region: All
            </button>
        `);

        const btn = el.querySelector("#region-filter-btn");

        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (regionDropdownEl) { closeRegionDropdown(); return; }

            const originalText = btn.textContent;
            btn.textContent = "Loading regions…";
            btn.disabled = true;

            try {
                const pageGameId = parseInt(window.location.href.split("games/")[1].split("/")[0]);

                // Show live progress while we fetch + geolocate every server for
                // the first time, so the button doesn't look frozen on big games.
                // If the data is already cached, buildRegionTree resolves fast and
                // the text is only ever "Loading regions…" for a split second.
                const tree = await buildRegionTree(pageGameId, ({ phase, done, total }) => {
                    btn.textContent = phase === "fetching"
                        ? "Loading regions…"
                        : `Loading regions… ${done}/${total}`;
                });
                btn.textContent = originalText;
                btn.disabled = false;

                showRegionDropdown(btn, tree, (code) => {
                    currentRegionCode = code;
                    setRegionButtonLabel(code);
                    // Scope the current sort to this region (or clear the scope
                    // when "All regions" is chosen) and re-apply. Falls back to
                    // the legacy region mode if the sort helper isn't present.
                    if (typeof window.__setFilterRegion === "function") {
                        window.__setFilterRegion(code);
                        window.__reapplyServerFilter();
                    } else {
                        applyServerFilter(code ? `region:${code}` : "default");
                    }
                });
            } catch (err) {
                console.error("Region fetch failed", err);
                btn.textContent = "Region: All";
                btn.disabled = false;
            }
        });
    });

    // NOTE: The region filter and the sort filter are deliberately INDEPENDENT.
    // Selecting a sort no longer wipes the active region (and vice-versa), so the
    // two always compose. We therefore intentionally do NOT listen for sort
    // changes here — the region button label is only changed by the user picking
    // a region from the dropdown below.
}
