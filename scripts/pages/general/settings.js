const currencies_labels = [
    "AUD (Australian Dollar)",
    "BGN (Bulgarian Lev)",
    "BRL (Brazilian Real)",
    "CAD (Canadian Dollar)",
    "CHF (Swiss Franc)",
    "CNY (Chinese Yuan)",
    "CZK (Czech Koruna)",
    "DKK (Danish Krone)",
    "EUR (Euro)",
    "GBP (British Pound)",
    "HKD (Hong Kong Dollar)",
    "HUF (Hungarian Forint)",
    "IDR (Indonesian Rupiah)",
    "ILS (Israeli Shekel)",
    "INR (Indian Rupee)",
    "ISK (Icelandic Króna)",
    "JPY (Japanese Yen)",
    "KRW (South Korean Won)",
    "MXN (Mexican Peso)",
    "MYR (Malaysian Ringgit)",
    "NOK (Norwegian Krone)",
    "NZD (New Zealand Dollar)",
    "PHP (Philippine Peso)",
    "PLN (Polish Zloty)",
    "RON (Romanian Leu)",
    "SEK (Swedish Krona)",
    "SGD (Singapore Dollar)",
    "THB (Thai Baht)",
    "TRY (Turkish Lira)",
    "USD (US Dollar)",
    "ZAR (South African Rand)",
]
const currencies = currencies_labels.map(c => c.split(" (")[0])

if (/roblox\.\w+\/my\/account/.test(window.location.href)) {
    observeElement("#settings-container .settings-left-navigation .menu-vertical", (el) => {
        el.insertAdjacentHTML("beforeend", `
            <li id="lionizon-settings" role="tab" class="menu-option">
                <a aria-current="page" class="menu-option-content" href="#!/lionizon-settings">
                    <span class="font-caption-header">Lionizon settings</span>
                    <span class="rbx-tab-subtitle"></span>
                </a>
            </li>
        `)
    })

    if (location.hash === "#!/lionizon-settings") {
        history.replaceState(null, "", "#!/lionizon-settings")
        showLionizonPanel()
    }

    function createDropdown(anchorEl, options, onSelect) {
        const theme = [...document.querySelector("#rbx-body").classList].find(c => c.includes("dark") || c.includes("light"))
        
        console.log("User theme:", theme)

        document.querySelector(".lionizon-dropdown")?.remove()

        const dropdown = document.createElement("div")
        dropdown.className = "lionizon-dropdown"
        dropdown.classList.add(theme, "stroke-contrast-alpha", "stroke-standard")

        const rect = anchorEl.getBoundingClientRect()

        Object.assign(dropdown.style, {
            position: "fixed",
            top: `${rect.bottom + 5}px`,
            left: `${rect.left}px`,
            zIndex: "999999",
            minWidth: `${rect.width}px`,
            padding: "10px",
            borderRadius: "20px",
            boxShadow: "0 15px 20px 0 var(--color-common-shadow)"
        })

        dropdown.style.setProperty("border-color", "color-mix(in srgb, var(--color-stroke-contrast-alpha) 30%, transparent)", "important")
        dropdown.style.setProperty("background-color", "var(--color-surface-100)", "important")

        options.forEach(opt => {
            const item = document.createElement("div")
            item.textContent = opt
            item.style.cssText = "padding: 8px 12px; cursor: pointer; border-radius: 10px; transition: background 0.25s ease"
            item.classList.add("foundation-web-menu-item-title", "text-no-wrap", "text-truncate-split", "content-emphasis", "text-body-medium")
            item.addEventListener("mouseenter", () => item.style.background = "var(--color-surface-300)")
            item.addEventListener("mouseleave", () => item.style.background = "")
            item.addEventListener("click", () => {
                onSelect(opt)
                dropdown.remove()
            })
            dropdown.appendChild(item)
        })

        document.body.appendChild(dropdown)

        // clamp to window edges + scroll if needed
        const dr = dropdown.getBoundingClientRect()
        const padding = 8

        if (dr.right > window.innerWidth - padding) {
            dropdown.style.left = `${window.innerWidth - dr.width - padding}px`
        }
        if (dr.bottom > window.innerHeight - padding) {
            dropdown.style.top = `${rect.top - dr.height - 4}px` // flip above if no room below
            const flipped = dropdown.getBoundingClientRect()
            if (flipped.top < padding) {
                // doesnt fit above either, just clamp and scroll
                dropdown.style.top = `${padding}px`
                dropdown.style.maxHeight = `${window.innerHeight - padding * 2}px`
                dropdown.style.overflowY = "auto"
            }
        }

        // close on click
        setTimeout(() => {
            document.addEventListener("click", (e) => {
                if (!dropdown.contains(e.target)) dropdown.remove()
            }, { once: true })
        }, 0)
    }

    async function dropdownBuilder(title, default_value, db, db_path, options) {
        function dbSet(db, db_path, val) {
            const keys = db_path.split("/")
            let current = db

            for (let i = 0; i < keys.length - 1; i++) {
                if (!current[keys[i]]) current[keys[i]] = {}
                current = current[keys[i]]
            }

            current[keys[keys.length - 1]] = val

            return db
        }

        function dbGet(db, db_path) {
            const keys = db_path.split("/")
            let current_nav = db

            for (let key of keys) {
                if (current_nav[key] == undefined) return undefined
                current_nav = current_nav[key]
            } 
            
            return current_nav
        }

        let val = dbGet(db, db_path)
        if (val === undefined) {
            dbSet(db, db_path, default_value)
            await saveData({ lionizon_settings: db })
            val = default_value
        }

        let tabPane = document.querySelector(".tab-content .tab-pane")

        let drop = `
        <div class="collapsible-user-input theme-update-container">
            <label class="text-title-large account-info-inline-label label-desktop">${title}</label>
            <div class="col-xs-12 col-sm-6 flex flex-col gap-small">
                <div class="settings-select relative clip focus-visible:outline-focus disabled:outline-none flex items-center justify-between width-full bg-none stroke-standard cursor-pointer radius-medium height-1000 padding-x-medium text-body-medium stroke-contrast-alpha content-default" id="${db_path.replace("/", "-")}"}>
                    <span class="grow-1 text-truncate-split text-align-x-left foundation-web-menu-item-title text-no-wrap text-truncate-split content-emphasis">${val}</span>
                </div>
                <span aria-hidden="true" class="settings-select-arrow size-500 icon icon-regular-chevron-large-down content-default">▼</span>
            </div>
        </div>
        `
        tabPane.insertAdjacentHTML("beforeend", drop)
        const anchorEl = document.querySelector(`#${db_path.replace("/", "-")}`)

        anchorEl.addEventListener("click", async () => {
            createDropdown(anchorEl, options, async (selected) => {
                anchorEl.querySelector("span").textContent = selected
                dbSet(db, db_path, selected)
                await saveData({ lionizon_settings: db })
            })
        })

        return anchorEl
    }

    async function showLionizonPanel() {
        const settings = await loadData("lionizon_settings")

        log("Showing panel.")

        const run = async (tabcontent) => {
            document.querySelectorAll("#settings-container .menu-vertical li a").forEach(tab => {
                tab.classList.remove("active")
            })
            document.querySelector("#settings-container .menu-vertical #lionizon-settings a")?.classList.add("active")

            tabcontent.innerHTML = ""

            tabcontent.insertAdjacentHTML("beforeend", `
            <div class="container-header">
                <h2 class="text-heading-small">General Settings</h2>
            </div>
            `)

            await dropdownBuilder("Home welcome banner", "Enabled", settings, "home_banner_enabled", ["Enabled", "Disabled"])
            await dropdownBuilder("User presence circles", "Enabled", settings, "user_presence_circles", ["Enabled", "Disabled"])
            await dropdownBuilder("User game presence thumbnail preview", "Enabled", settings, "game_presence_thumbnail_preview", ["Enabled", "Disabled"])

            tabcontent.insertAdjacentHTML("beforeend", `
            <div class="container-header">
                <h2 class="text-heading-small">Robux Settings</h2>
            </div>
            `)

            await dropdownBuilder("Convert robux to currency?", "Enabled", settings, "convert_rbx_to_currency", ["Enabled", "Disabled"])
            await dropdownBuilder("Currency", "USD", settings, "currency", currencies)
        }

        const existing = document.querySelector(".tab-content .tab-pane")
        if (existing) {
            await run(existing)
        } else {
            observeElement(".tab-content .tab-pane", run)
        }
    }

    function hideLionizonPanel() {
        log("Hiding panel.")

        const lionizonTab = document.querySelector("#settings-container .menu-vertical #lionizon-settings a")
        lionizonTab.classList.remove("active")
    }

    window.addEventListener("hashchange", (e) => {
        if (location.hash === "#!/lionizon-settings") {
            history.replaceState(null, "", "#!/lionizon-settings")
            e.stopImmediatePropagation()
            showLionizonPanel()
        } else {
            hideLionizonPanel()
        }
    }, true)
}