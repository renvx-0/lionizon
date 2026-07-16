// HELLO!
// IMPORTANT: 
// SOME ENDPOINTS SEND YOUR ROBLOSECURITY COOKIE
// THIS IS FOR AUTHENTICATION, SUCH AS THE SERVER GEOLOCATION, WHICH NEEDS AUTHENTICATION
// IN THE PAST, IT USED ANOTHER SYSTEM THAT DIDNT REQUIRE YOUR COOKIE,
// BUT ROBLOX, AS ALWAYS, RELEASED A BREAKING CHANGE THAT BROKE EVERY COOKIE THAT I HAD FOR THAT ENDPOINT, MAKING IT NOT WORK
// IF I FIND A SOLUTION, I WILL CHANGE IT SO IT DOESNT SEND YOUR COOKIE

// ALSO, YOUR COOKIE IS NOT STORED ANYWHERE. THE API IS OPEN SOURCE IF YOU WANT TO CHECK IT

async function fetchWithXsrf(url, options = {}) {
    let response = await fetch(url, {
        ...options,
        credentials: "include"
    });
    
    if (response.status === 403) {
        const xsrfToken = response.headers.get("x-csrf-token");
        if (xsrfToken) {
            response = await fetch(url, {
                ...options,
                credentials: "include",
                headers: {
                    ...options.headers,
                    "x-csrf-token": xsrfToken
                }
            });
        }
    }
    
    return response;
}

async function getFriends(userId) {
    let friend_list = []
    let next_cursor = ""

    while (true) {
        let r = await fetch(`https://friends.roblox.com/v1/users/${userId}/friends/find?cursor=${next_cursor}&_extreq`, {
          "headers": {
            "accept": "application/json, text/plain, */*",
          },
          "method": "GET",
          "credentials": "include"
        })
        let data = await r.json()

        friend_list.push(...data["PageItems"] || [])

        next_cursor = data["NextCursor"]
        if (next_cursor == null) {
            break
        };
    }
    return friend_list
}

async function getPresences(userIds) {
    let presences = []

    let r = await fetch(`https://presence.roblox.com/v1/presence/users?_extreq`, {
        "headers": {
            "accept": "application/json, text/plain, */*",
        },
        "body": JSON.stringify({
            "userIds": userIds
        }),
        "method": "POST",
        "credentials": "include"
    })

    let data = await r.json()
    presences = data["userPresences"]
    return presences
}

async function getLoggedInUserId() {
    let r = await fetch("https://www.roblox.com/my/account/json?_extreq", {
        "headers": {
            "accept": "application/json, text/plain, */*",
        },
        "method": "GET",
        "credentials": "include"
    })
    let data = await r.json()
    return data["UserId"]
}

async function getLoggedInUserDisplay() {
    let r = await fetch("https://www.roblox.com/my/account/json?_extreq", {
        "headers": {
            "accept": "application/json, text/plain, */*",
        },
        "method": "GET",
        "credentials": "include"
    })
    let data = await r.json()
    return data["DisplayName"]
}

async function getUniverseId(placeId) {
    let r = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe?_extreq`, {
        "headers": {
            "accept": "application/json, text/plain, */*",
        },
        "method": "GET",
        "credentials": "include"
    })
    let data = await r.json()
    return data["universeId"]
}

async function getGameDetails(placeId, is_universe_id=false) {
    const universeId = is_universe_id ? placeId : await getUniverseId(placeId)

    let r = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}&_extreq`, {
        "headers": {
            "accept": "application/json, text/plain, */*",
        },
        "method": "GET",
        "credentials": "include"
    })
    let data = await r.json()
    return data["data"][0]
}

async function getGameVotes(placeId, is_universe_id=false) {
    const universeId = is_universe_id ? placeId : await getUniverseId(placeId)

    let r = await fetch(`https://games.roblox.com/v1/games/${universeId}/votes?_extreq`, {
        "headers": {
            "accept": "application/json, text/plain, */*",
        },
        "method": "GET",
        "credentials": "include"
    })
    let data = await r.json()
    return data
}

async function getSubplacesFromGame(placeId) {
    const universeId = await getUniverseId(placeId)

    let subplaces_list = []
    let next_cursor = ""

    while (true) {
        let r = await fetch(`https://develop.roblox.com/v1/universes/${universeId}/places?isUniverseCreation=false&limit=100&cursor=${next_cursor}&_extreq`, {
          "headers": {
            "accept": "application/json, text/plain, */*",
          },
          "method": "GET",
          "credentials": "include"
        })
        let data = await r.json()

        subplaces_list.push(...data["data"] || [])

        next_cursor = data["nextPageCursor"]
        if (next_cursor == null) {
            break
        };
    }

    return subplaces_list
}

async function getPlaceIdThumbnail(placeId, size="512x512", format="Png", isCircular=false) {
    let r = await fetch(`https://thumbnails.roblox.com/v1/places/gameicons?placeIds=${placeId}&returnPolicy=PlaceHolder&size=${size}&format=${format}&isCircular=${isCircular}&_extreq`, {
        "headers": {
            "accept": "application/json, text/plain, */*",
        },
        "method": "GET",
        "credentials": "include"
    })
    let data = await r.json()
    return data["data"][0]["imageUrl"]
}

async function getCSRFToken() {
    const res = await fetch("https://auth.roblox.com/v2/logout?_extreq", {
        method: "POST",
        credentials: "include"
    })
    return res.headers.get("x-csrf-token")
}

async function getAuthTicket(csrf) {
    const res = await fetch("https://auth.roblox.com/v1/authentication-ticket?_extreq", {
        method: "POST",
        credentials: "include",
        headers: {
            "X-CSRF-TOKEN": csrf,
            "Referer": "https://www.roblox.com/",
            "Content-Type": "application/json"
        }
    })
    return res.headers.get("rbx-authentication-ticket")
}

let _cachedCookie = null

async function getCookie() {
    if (_cachedCookie) return _cachedCookie
    const { cookie } = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: "GET_COOKIE" }, resolve)
    )
    _cachedCookie = cookie
    return cookie
}

async function getUsersThumbnail(userIds, size="420x420", format="Png", isCircular=false) {
    const r = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join()}&size=${size}&format=${format}&isCircular=${isCircular}&_extreq`, { credentials: "include" })
    const data = await r.json()
    return data.data
}

async function getUsersThumbnailFromTokens(tokens) {
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 100)
        chunks.push(tokens.slice(i, i + 100));

    // Return a { [playerToken]: imageUrl } map instead of an ordered array.
    // The batch endpoint echoes each request's `token` back, so we can assign
    // thumbnails to the correct server without relying on response ordering
    // (which is the bug that made avatars disappear on filtered/region lists).
    const maps = await Promise.all(chunks.map(async chunk => {
        const map = {};
        let data;
        while (true) {
            const r = await fetch(`https://thumbnails.roblox.com/v1/batch`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(chunk.map(token => ({
                    "format": "png",
                    "requestId": `0:${token}:AvatarHeadshot:150x150:png:regular`,
                    "size": "150x150",
                    "targetId": 0,
                    "token": token,
                    "type": "AvatarHeadShot",
                }))),
                credentials: "include"
            });
            if (!r.ok) continue
            data = await r.json();
            break
        }
        for (const item of (data.data || [])) {
            const token = item.token ?? (item.requestId ? item.requestId.split(":")[1] : null);
            if (token != null && item.imageUrl) map[token] = item.imageUrl;
        }
        return map;
    }));

    return Object.assign({}, ...maps);
}

async function joinInstanceInfo(placeId, serverIds) {
    let cookie = await getCookie()
    const r = await fetch(`https://api-servers.juliozapatahernandez2006.workers.dev/join-game-instance?_extreq`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Origin": "https://www.roblox.com/"
        },
        body: JSON.stringify({
            "placeId": placeId,
            "serverIds": serverIds,
            "roblosecurity": cookie
        })
    })
    const data = await r.json()
    console.log(data)
    return data.data
}

async function getRobux() {
    let userId = await getLoggedInUserId()
    const r = await fetch(`https://economy.roblox.com/v1/users/${userId}/currency?_extreq`, { credentials: "include" })
    const data = await r.json()

    return data.robux
}

async function getAssetInfo(assetId) {
    let r = await fetch(`https://economy.roblox.com/v2/assets/${assetId}/details?_extreq`, { credentials: "include" })
    let data = await r.json()

    if (data.errors) {
        return null
    }

    return data
}

async function getBundleInfo(bundleId) {
    let r = await fetch(`https://catalog.roblox.com/v1/bundles/${bundleId}/details?_extreq`, { credentials: "include" })
    let data = await r.json()

    if (data.errors) {
        return null
    }

    return data
}

async function getGamepassInfo(gamepassId) {
    let r = await fetch(`https://apis.roblox.com/game-passes/v1/game-passes/${gamepassId}/product-info?_extreq`, { credentials: "include" })
    let data = await r.json()

    if (data.errors) {
        return null
    }

    return data
}

async function getAssetThumbnail(assetId) {
    let r = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&size=420x420&format=Png&isCircular=false&_extreq`, { credentials: "include" })
    let data = await r.json()

    return data.data
}

async function getGamepassThumbnail(gamepassId) {
    let r = await fetch(`https://thumbnails.roblox.com/v1/game-passes?gamePassIds=${gamepassId}&size=150x150&format=Png&isCircular=false&_extreq`, { credentials: "include" })
    let data = await r.json()

    return data.data
}

async function getBundleThumbnail(bundleId) {
    let r = await fetch(`https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=${bundleId}&size=420x420&format=Png&_extreq`, { credentials: "include" })
    let data = await r.json()

    return data.data
}

async function getAllServers(placeId) {
    const r = await fetch("https://api-servers.juliozapatahernandez2006.workers.dev/get-all-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placeId })
    });
    const data = await r.json();
    return data
}

async function getBadgesAwardDate(badgeIds) {
    const userId = await getLoggedInUserId()
    const r = await fetch(`https://badges.roblox.com/v1/users/${userId}/badges/awarded-dates?badgeIds=${badgeIds.join(",")}`, { credentials: "include" })
    const data = await r.json()

    return data.data
}

async function getProfileInsights(userIds) {
    const r = await fetchWithXsrf(`https://apis.roblox.com/profile-insights-api/v1/multiProfileInsights`, {
        method: "POST",
        headers: {
            "accept": "application/json",
            "content-type": "application/json"
        },
        body: JSON.stringify({
            "userIds": userIds,
            "rankingStrategy": "tc_info_boost"
        })
    });

    const data = await r.json();
    return data.userInsights[0]?.profileInsights
}