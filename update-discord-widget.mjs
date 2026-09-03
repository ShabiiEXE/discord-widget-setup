import { writeFile } from "node:fs/promises";

const DISCORD_API_BASE = "https://discord.com/api";
const DEFAULT_BASE_URL = "https://gamelist.shabii.workers.dev";
const BASE_URL = normalizeBaseUrl(
  process.env.GAMELIST_BASE_URL
  || process.env.WIDGET_BASE_URL
  || process.env.PUBLIC_BASE_URL
  || process.env.SITE_URL
  || process.env.URL
  || DEFAULT_BASE_URL
);
const BOT_TOKEN = cleanEnv("DISCORD_BOT_TOKEN");
const ACCESS_TOKEN = cleanEnv("DISCORD_ACCESS_TOKEN");
const USER_ID_OVERRIDE = cleanEnv("DISCORD_USER_ID");
const APP_ID_OVERRIDE = cleanEnv("DISCORD_APP_ID");
const FALLBACK_SYNC_DATA = {
  games: [
    {
      title: "Baldur's Gate III",
      platform: "PS5",
      section: "backlog",
      playing: true,
      startedAt: "2026-07-01",
      cover: "https://images.igdb.com/igdb/image/upload/t_cover_big/co670h.jpg",
    },
    {
      title: "Digimon Story: Time Stranger",
      platform: "Switch 2",
      section: "backlog",
      playing: true,
      startedAt: "2026-07-11",
      cover: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/coakzr.jpg",
    },
    {
      title: "Hi-Fi Rush",
      platform: "PS5",
      section: "backlog",
      playing: true,
      startedAt: "2026-07-21",
      cover: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co6219.jpg",
    },
  ],
};
const DRY_RUN = process.argv.includes("--dry-run");
const FALLBACK_IMAGE = `${BASE_URL}/assets/Icon.png`;
const STAT_IMAGES = {
  completed: `${BASE_URL}/assets/discord/completed_games.png`,
  finished: `${BASE_URL}/assets/discord/finished_games.png`,
  backlog: `${BASE_URL}/assets/app-Icon.png`,
  shelf: `${BASE_URL}/assets/discord/shelf.png`,
};
const PLATFORM_IMAGES = {
  playstation: `${BASE_URL}/assets/platforms/playstation.png`,
  steam: `${BASE_URL}/assets/platforms/steam.png`,
  switch: `${BASE_URL}/assets/platforms/switch.png`,
  xbox: `${BASE_URL}/assets/platforms/xbox.png`,
  xbox360: `${BASE_URL}/assets/platforms/xbox360.png`,
  xboxRetro: `${BASE_URL}/assets/platforms/xbox_retro.png`,
  wii: `${BASE_URL}/assets/platforms/wii.png`,
  wiiu: `${BASE_URL}/assets/platforms/wiiu.png`,
  gamecube: `${BASE_URL}/assets/platforms/gc.png`,
  n64: `${BASE_URL}/assets/platforms/n64.png`,
  snes: `${BASE_URL}/assets/platforms/snes.png`,
  nes: `${BASE_URL}/assets/platforms/nes.png`,
  ds: `${BASE_URL}/assets/platforms/nds.png`,
  threeDs: `${BASE_URL}/assets/platforms/3ds.png`,
  gba: `${BASE_URL}/assets/platforms/gba.png`,
  gbc: `${BASE_URL}/assets/platforms/gbc.png`,
  gb: `${BASE_URL}/assets/platforms/gb.png`,
  gamegear: `${BASE_URL}/assets/platforms/gamegear.png`,
  dreamcast: `${BASE_URL}/assets/platforms/dreamcast.png`,
  sega: `${BASE_URL}/assets/platforms/sega.png`,
};

if (!BOT_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN.");
  console.error("PowerShell example:");
  console.error('$env:DISCORD_BOT_TOKEN = "paste-your-reset-bot-token-here"');
  console.error('$env:DISCORD_USER_ID = "your-discord-user-id"');
  console.error('$env:GAMELIST_BASE_URL = "https://your-gamelist-site.example"');
  console.error("node .\\update-discord-widget.mjs");
  process.exit(1);
}

console.log(`Using Gamelist base URL: ${BASE_URL}`);
const widgetData = await buildWidgetData();
await writeFile("widget-data.json", JSON.stringify(widgetData, null, 2), "utf8");
console.log("Built widget-data.json");

const application = await discordJson("GET", "/v10/oauth2/applications/@me");
const appId = APP_ID_OVERRIDE || application.id;
const inferredOwnerId = ownerIdFromApplication(application);
const userId = USER_ID_OVERRIDE || inferredOwnerId;
if (!appId || !userId) {
  throw new Error("Could not infer the Discord application or user. Set DISCORD_APP_ID and DISCORD_USER_ID, then run again.");
}

console.log(`Application: ${application.name || "(unnamed)"} (${appId})`);
console.log(`Identity user: ${userId}${USER_ID_OVERRIDE ? " (from DISCORD_USER_ID)" : " (inferred from app owner)"}`);
if (USER_ID_OVERRIDE && inferredOwnerId && USER_ID_OVERRIDE !== inferredOwnerId) {
  console.warn(`App owner from Discord is ${inferredOwnerId}, but DISCORD_USER_ID is ${USER_ID_OVERRIDE}.`);
  console.warn("That is fine only if you authorized the app while logged into DISCORD_USER_ID.");
}

await validateAgainstWidgetConfig(appId, widgetData);

if (DRY_RUN) {
  console.log("Dry run complete. Discord was not updated.");
  process.exit(0);
}

try {
  await discordJson("PATCH", `/v9/applications/${appId}/users/${userId}/identities/0/profile`, widgetData);
  console.log("Discord widget identity updated successfully.");
} catch (error) {
  if (String(error.message || "").includes("50025") || /Invalid OAuth2 access token/i.test(error.body || "")) {
    if (ACCESS_TOKEN) {
      console.warn("Bot-token identity update returned 50025. Trying DISCORD_ACCESS_TOKEN as a Bearer token...");
      try {
        await discordJson("PATCH", `/v9/applications/${appId}/users/${userId}/identities/0/profile`, widgetData, { accessToken: ACCESS_TOKEN });
        console.log("Discord widget identity updated successfully with DISCORD_ACCESS_TOKEN.");
        process.exit(0);
      } catch (bearerError) {
        console.error(`Bearer fallback also failed: ${bearerError.message}`);
        if (bearerError.body) console.error(bearerError.body);
      }
    }
    console.error("Discord returned 50025: Invalid OAuth2 access token.");
    console.error("Authorize the application identity while logged into the same Discord account as DISCORD_USER_ID, then run this script again.");
    console.error("Try these URLs in order:");
    authUrls(appId).forEach((url) => console.error(url));
    console.error("If Discord redirects with an access_token in the URL, you can also test the Bearer fallback:");
    console.error('$env:DISCORD_ACCESS_TOKEN = "paste-access-token-from-redirect-url"');
    console.error("node .\\update-discord-widget.mjs");
    console.error("Also confirm the Social SDK form is completed in the Discord Developer Portal.");
    process.exit(1);
  }
  throw error;
}

async function buildWidgetData() {
  const [lists, finished, achievementCompletions, shelf, sync, activity] = await Promise.all([
    maybeGetJson("/api/gamelist-games-by-list"),
    maybeGetJson("/api/completed-games-by-year"),
    waitForAchievementCompletions(),
    maybeGetJson("/api/shelf"),
    maybeGetJson("/api/sync"),
    maybeGetJson("/api/achievements"),
  ]);

  const syncData = sync || FALLBACK_SYNC_DATA;
  const providerCompletions = await providerCompletionSummary(syncData, achievementCompletions, activity);
  const playing = playingGames(syncData);
  const selectedGames = rotatePlayingGames(playing, 3);
  const coverGame = selectedGames.find((game) => game?.cover) || null;
  const trophyRows = sync ? await Promise.all(selectedGames.map((game) => trophyProgressForGame(game, activity || {}))) : [];
  const displayRows = [0, 1, 2].map((index) => gameDisplayRow(selectedGames[index], trophyRows[index]));
  if (playing.length > 3) displayRows[2] = withAndMore(displayRows[2]);
  const subtitles = displayRows.map((row) => row.subtitle);
  const subtitleTrophies = displayRows.map((row) => row.trophies);
  const subtitleIcons = [0, 1, 2].map((index) => platformIconUrl(selectedGames[index]?.platform));

  return {
    data: {
      dynamic: [
        imageField("game_cover_image", squareCoverUrl(coverGame?.cover || latestCompletedCover(finished, syncData) || FALLBACK_IMAGE)),
        textField("game_title", "Currently Playing"),
        imageField("platform_icon_image", subtitleIcons[0]),
        imageField("game_subtitle_1_image", subtitleIcons[0]),
        textField("game_subtitle_1", subtitles[0]),
        textField("game_subtitle_1_trophies", subtitleTrophies[0]),
        imageField("game_subtitle_2_image", subtitleIcons[1]),
        textField("game_subtitle_2", subtitles[1]),
        textField("game_subtitle_2_trophies", subtitleTrophies[1]),
        imageField("game_subtitle_3_image", subtitleIcons[2]),
        textField("game_subtitle_3", subtitles[2]),
        textField("game_subtitle_3_trophies", subtitleTrophies[2]),
        textField("total_completed_count", achievementCompletionSummary(providerCompletions)),
        imageField("total_completed_count_image", STAT_IMAGES.completed),
        textField("finished_this_year", finishedThisYear(finished, syncData)),
        imageField("finished_image", STAT_IMAGES.finished),
        textField("backlog_games", backlogCount(lists, syncData)),
        imageField("backlog_image", STAT_IMAGES.backlog),
        textField("shelf_games", shelfCount(shelf, syncData)),
        imageField("shelf_image", STAT_IMAGES.shelf),
        numberField("completed_games", achievementCompletionCount(providerCompletions)),
        textField("rotation_note", sync ? (playing.length > 1 ? `Randomized from ${playing.length} games on each update` : "") : "Using fallback data"),
      ],
    },
    username: "Shabii",
  };
}

async function getJson(path) {
  const targetUrl = `${BASE_URL}${path}`;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(targetUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "gamelist-discord-widget/1.0",
      },
    });
    if (response.ok) return response.json();

    const text = await response.text().catch(() => "");
    const excerpt = text ? `: ${text.slice(0, 200)}` : "";
    lastError = new Error(`${targetUrl} returned ${response.status}${excerpt}`);

    if (attempt < 3) await sleep(attempt * 1000);
  }

  throw lastError;
}

async function maybeGetJson(path) {
  try {
    return await getJson(path);
  } catch {
    return null;
  }
}

async function waitForAchievementCompletions() {
  let best = null;
  const requiredSources = new Set(["psn", "steam", "xbox"]);

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const data = await maybeGetJson("/api/achievement-completions-by-year");
    if (data) {
      if (!best || achievementCompletionCount(data) >= achievementCompletionCount(best)) {
        best = data;
      }

      const hasRequiredSources = [...requiredSources].every((source) => sourceHasCompletionData(data, source));
      const hasNoErrors = !Array.isArray(data.errors) || data.errors.length === 0;

      if (hasRequiredSources && hasNoErrors && attempt >= 3) return best;
    }

    if (attempt < 8) await sleep(2000);
  }

  return best;
}

function playingGames(syncData) {
  return activeGames(syncData)
    .filter((game) => game.playing)
    .sort((a, b) => startedSortValue(a) - startedSortValue(b) || String(a.title || "").localeCompare(String(b.title || "")));
}

function activeGames(syncData) {
  return (syncData?.games || []).filter((game) => !game.deletedAt);
}

function randomGames(games, count = games.length) {
  return [...games]
    .map((game) => ({ game, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .slice(0, count)
    .map(({ game }) => game);
}

function rotatePlayingGames(games, count) {
  const candidates = games.filter((game) => game.cover);
  const firstGame = randomGames(candidates.length ? candidates : games, 1)[0];
  if (!firstGame) return [];
  const firstKey = coverKey(firstGame);
  const rest = games.filter((game) => coverKey(game) !== firstKey);
  return [firstGame, ...randomGames(rest, count - 1)].slice(0, count);
}

function coverKey(game) {
  return [game?.id, game?.title, game?.platform, game?.cover].filter(Boolean).join("|");
}

function startedSortValue(game) {
  return game.startedAt ? new Date(`${game.startedAt}T00:00:00Z`).getTime() : Number.POSITIVE_INFINITY;
}

function backlogCount(listsData, syncData) {
  const backlogList = (listsData?.lists || []).find((item) => item.list === "backlog");
  if (Array.isArray(backlogList?.games)) return backlogList.games.filter(isUncompletedGame).length;
  return activeGames(syncData).filter((game) => game.section === "backlog" && isUncompletedGame(game)).length;
}

function isUncompletedGame(game) {
  return !String(game?.completedAt || "").trim();
}

function shelfCount(shelfData, syncData) {
  const shelfGames = mergedShelfGames(shelfData);
  if (shelfGames) return shelfGames.filter((game) => !game.deletedAt).length;
  const shelfTotal = Number(shelfData?.totalGames || 0);
  if (shelfTotal) return shelfTotal;
  return Array.isArray(syncData?.games) ? syncData.games.filter((game) => !game.deletedAt).length : 0;
}

function mergedShelfGames(shelfData) {
  if (!Array.isArray(shelfData?.sourceGames) && !Array.isArray(shelfData?.games)) return null;
  const overrides = shelfData?.overrides || {};
  return [
    ...(shelfData.sourceGames || []).map((game) => ({ ...game, ...(overrides[game.id] || {}) })),
    ...(shelfData.games || []),
  ];
}

function completedCount(completedData) {
  return Number(completedData.totalCompleted || 0)
    || (completedData.years || []).reduce((sum, year) => sum + Number(year.count || 0), 0);
}

async function providerCompletionSummary(syncData, summaryData, psnActivity) {
  const settings = syncData?.settings || {};
  const [psn, steam, xbox] = await Promise.all([
    psnCompletionData(settings, psnActivity),
    steamCompletionData(settings),
    xboxCompletionData(settings),
  ]);

  const summaryPlatforms = (summaryData?.platforms || [])
    .filter((platform) => ["psn", "steam", "xbox"].includes(String(platform.source || "").toLowerCase()));
  const directBySource = new Map([psn, steam, xbox].map((platform) => [platform.source, platform]));
  const platforms = ["psn", "steam", "xbox"].map((source) => {
    const direct = directBySource.get(source);
    const summary = summaryPlatforms.find((platform) => String(platform.source || "").toLowerCase() === source);
    return Number(direct.totalCompletedGames || 0) || !summary ? direct : normalizeCompletionPlatform(summary, source);
  });

  const completedGamesByYear = countByYear(platforms.flatMap((platform) => platform.completedGames || []));
  return {
    source: "provider-completions",
    platforms,
    providerTotals: Object.fromEntries(platforms.map((platform) => [platform.source, platform.totalCompletedGames])),
    completedGames: platforms.flatMap((platform) => platform.completedGames || []),
    completedGamesByYear,
    totalCompletedGames: platforms.reduce((sum, platform) => sum + Number(platform.totalCompletedGames || 0), 0),
  };
}

async function psnCompletionData(settings, existingData) {
  const user = String(settings.psnUser || "").trim();
  const params = new URLSearchParams({ schema: "3" });
  if (user) params.set("user", user);
  const data = existingData || await maybeGetJson(`/api/achievements?${params}`);
  const completedGames = (data?.platinums || []).map((item) => ({
    title: item.title || item.game || "",
    rawEarnedAt: item.rawEarnedAt || item.earnedAt || "",
    source: "psn",
  }));
  return {
    source: "psn",
    platform: "PlayStation",
    completedGames,
    completedGamesByYear: countByYear(completedGames),
    totalCompletedGames: completedGames.length,
  };
}

async function steamCompletionData(settings) {
  const user = String(settings.steamUser || "").trim();
  if (!user) return emptyCompletionPlatform("steam", "Steam");

  const completedGames = [];
  let cursor = 0;
  for (let page = 0; page < 20 && cursor !== null; page += 1) {
    const params = new URLSearchParams({ activity: "1", limit: "20", debug: "1", user, cursor: String(cursor) });
    const data = await maybeGetJson(`/api/steam-achievements?${params}`);
    if (!data || data.needsSetup || data.authError || data.error) break;

    for (const game of data.games || []) {
      if (isCompletedAchievementGame(game)) {
        completedGames.push({
          title: game.name || game.title || "",
          rawEarnedAt: latestEarnedAt(game.achievements || []),
          source: "steam",
        });
      }
    }

    cursor = data.nextCursor !== null && Number.isFinite(Number(data.nextCursor)) ? Number(data.nextCursor) : null;
  }

  return {
    source: "steam",
    platform: "Steam",
    completedGames,
    completedGamesByYear: countByYear(completedGames),
    totalCompletedGames: completedGames.length,
  };
}

async function xboxCompletionData(settings) {
  const user = String(settings.microsoftUser || "").trim();
  const params = new URLSearchParams({ schema: "2" });
  if (user) params.set("user", user);
  const data = await maybeGetJson(`/api/xbox-achievements?${params}`);
  const completedGames = [
    ...(data?.completed || []),
    ...(data?.games || []).filter((game) => Number(game.total || 0) > 0 && Number(game.earned || 0) >= Number(game.total || 0)),
  ].map((item) => ({
    title: item.title || item.name || "",
    rawEarnedAt: item.rawEarnedAt || item.earnedAt || "",
    source: "xbox",
  }));
  return {
    source: "xbox",
    platform: "Xbox",
    completedGames,
    completedGamesByYear: countByYear(completedGames),
    totalCompletedGames: completedGames.length,
  };
}

function normalizeCompletionPlatform(platform, source) {
  const completedGames = (platform.completedGames || []).map((item) => ({ ...item, source }));
  return {
    source,
    platform: platform.platform || source,
    completedGames,
    completedGamesByYear: platform.completedGamesByYear || countByYear(completedGames),
    totalCompletedGames: Number(platform.totalCompletedGames || completedGames.length || 0),
  };
}

function emptyCompletionPlatform(source, platform) {
  return { source, platform, completedGames: [], completedGamesByYear: [], totalCompletedGames: 0 };
}

function isCompletedAchievementGame(game) {
  const achievements = game?.achievements || [];
  return achievements.length > 0 && achievements.every((achievement) => achievement.earned);
}

function latestEarnedAt(achievements) {
  return achievements
    .map((achievement) => achievement.rawEarnedAt || achievement.earnedAt || "")
    .filter(Boolean)
    .sort()
    .at(-1) || "";
}

function countByYear(items) {
  const counts = new Map();
  for (const item of items) {
    const year = completionYear(item.rawEarnedAt || item.earnedAt);
    if (!year) continue;
    counts.set(year, (counts.get(year) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
    .map(([year, count]) => ({ year, count }));
}

function completionYear(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const iso = raw.match(/^(\d{4})/);
  if (iso) return iso[1];
  const time = Date.parse(raw);
  return Number.isFinite(time) ? String(new Date(time).getUTCFullYear()) : "";
}

function achievementCompletionCount(completionsData) {
  return (completionsData?.platforms || [])
    .filter((platform) => ["psn", "steam", "xbox"].includes(String(platform.source || "").toLowerCase()))
    .reduce((sum, platform) => sum + Number(platform.totalCompletedGames || 0), 0);
}

function achievementCompletionsThisYear(completionsData) {
  const year = String(new Date().getFullYear());
  return (completionsData?.platforms || [])
    .filter((platform) => ["psn", "steam", "xbox"].includes(String(platform.source || "").toLowerCase()))
    .reduce((sum, platform) => {
      const count = (platform.completedGamesByYear || []).find((item) => item.year === year)?.count;
      return sum + Number(count || 0);
    }, 0);
}

function achievementCompletionSummary(completionsData) {
  return `${achievementCompletionCount(completionsData)} (${achievementCompletionsThisYear(completionsData)} this year)`;
}

function finishedThisYear(completedData, syncData) {
  const year = String(new Date().getFullYear());
  const apiCount = (completedData?.years || []).find((item) => item.year === year)?.count;
  if (Number.isFinite(Number(apiCount))) return Number(apiCount);
  return activeGames(syncData).filter((game) => String(game.completedAt || "").startsWith(year)).length;
}

function latestCompletedCover(completedData, syncData) {
  const apiCover = (completedData?.years || [])
    .flatMap((year) => year.games || [])
    .find((game) => game.cover)?.cover || "";
  if (apiCover) return apiCover;
  return activeGames(syncData)
    .filter((game) => game.completedAt && game.cover)
    .sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")))
    .find((game) => game.cover)?.cover || "";
}

function platformIconUrl(platform) {
  const value = String(platform || "").toLowerCase();
  if (hasPlatform(value, "steam", "pc", "windows")) return PLATFORM_IMAGES.steam;
  if (hasPlatform(value, "switch")) return PLATFORM_IMAGES.switch;
  if (hasPlatform(value, "wii u", "wiiu")) return PLATFORM_IMAGES.wiiu;
  if (hasPlatform(value, "wii")) return PLATFORM_IMAGES.wii;
  if (hasPlatform(value, "gamecube", "game cube")) return PLATFORM_IMAGES.gamecube;
  if (hasPlatform(value, "n64", "nintendo 64")) return PLATFORM_IMAGES.n64;
  if (hasPlatform(value, "snes", "super nintendo")) return PLATFORM_IMAGES.snes;
  if (hasPlatform(value, "nes", "nintendo entertainment")) return PLATFORM_IMAGES.nes;
  if (hasPlatform(value, "3ds")) return PLATFORM_IMAGES.threeDs;
  if (hasPlatform(value, "ds")) return PLATFORM_IMAGES.ds;
  if (hasPlatform(value, "gba", "game boy advance")) return PLATFORM_IMAGES.gba;
  if (hasPlatform(value, "gbc", "game boy color")) return PLATFORM_IMAGES.gbc;
  if (hasPlatform(value, "game boy", "gameboy", "gb")) return PLATFORM_IMAGES.gb;
  if (hasPlatform(value, "game gear")) return PLATFORM_IMAGES.gamegear;
  if (hasPlatform(value, "dreamcast")) return PLATFORM_IMAGES.dreamcast;
  if (hasPlatform(value, "genesis", "mega drive", "sega")) return PLATFORM_IMAGES.sega;
  if (hasPlatform(value, "xbox 360", "x360")) return PLATFORM_IMAGES.xbox360;
  if (hasPlatform(value, "original xbox", "classic xbox")) return PLATFORM_IMAGES.xboxRetro;
  if (hasPlatform(value, "xbox")) return PLATFORM_IMAGES.xbox;
  if (hasPlatform(value, "ps5", "playstation 5", "ps1", "ps2", "ps3", "ps4", "playstation", "psp", "vita")) return PLATFORM_IMAGES.playstation;
  return FALLBACK_IMAGE;
}

function hasPlatform(value, ...needles) {
  return needles.some((needle) => value.includes(needle));
}

function gameDisplayRow(game, trophyRow = {}) {
  if (!game) return { subtitle: " ", trophies: " " };
  const endpointTitle = String(trophyRow.title || "").trim();
  if (trophyRow.progress) {
    return {
      subtitle: endpointTitle || game.title || " ",
      trophies: trophyRow.progress,
    };
  }
  return {
    subtitle: "",
    trophies: endpointTitle || game.title || " ",
  };
}

function withAndMore(row) {
  if (!row) return { subtitle: " ", trophies: "AND MORE" };
  const next = { ...row };
  const target = next.trophies && next.trophies.trim() ? "trophies" : "subtitle";
  next[target] = appendAndMore(next[target]);
  return next;
}

function appendAndMore(value) {
  const text = String(value || "").trim();
  return text ? `${text} AND MORE` : "AND MORE";
}

async function trophyProgressForGame(game, activityData) {
  if (!game) return { progress: "", title: "" };
  const direct = await directTrophyProgress(game);
  if (direct.progress) return direct;
  const fallbackProgress = activityTrophyProgress(game, activityData);
  return {
    progress: fallbackProgress,
    title: fallbackProgress ? "" : direct.title,
  };
}

async function directTrophyProgress(game) {
  const psnId = String(game.npCommunicationId || "").trim();
  if (psnId) {
    const params = new URLSearchParams({ id: psnId });
    if (game.npServiceName) params.set("service", game.npServiceName);
    return progressFromPayload(await maybeGetJson(`/api/trophies?${params}`), "trophies");
  }

  const steamAppId = cleanSteamAppId(game.steamAppId) || steamAppIdFromUrl(game.storeLinks?.steam);
  if (steamAppId) {
    return progressFromPayload(await maybeGetJson(`/api/steam-achievements?${new URLSearchParams({ appId: steamAppId })}`), "achievements");
  }

  const titleId = String(game.titleId || "").replace(/\D/g, "").slice(0, 20);
  if (titleId) {
    return progressFromPayload(await maybeGetJson(`/api/xbox-achievements?${new URLSearchParams({ titleId })}`), "achievements");
  }

  return { progress: "", title: "" };
}

function progressFromPayload(data, itemKey) {
  if (!data) return { progress: "", title: "" };
  const items = Array.isArray(data[itemKey]) ? data[itemKey] : [];
  const total = Number(data.count || items.length || 0);
  const earned = Number.isFinite(Number(data.earnedCount))
    ? Number(data.earnedCount)
    : items.filter((item) => item.earned).length;
  return {
    progress: total ? trophyCountText(earned, total) : "",
    title: endpointGameTitle(data),
  };
}

function activityTrophyProgress(game, activityData) {
  const match = (activityData.games || []).find((item) => titleMatch(game.trophyName || game.title, item.title));
  const progress = String(match?.game || "").match(/(\d+)\s*\/\s*(\d+)\s*(?:trophies|achievements)?/i);
  return progress ? trophyCountText(progress[1], progress[2]) : "";
}

function trophyCountText(earned, total) {
  return `${earned}/${total} trophies\u2800`;
}

function endpointGameTitle(data) {
  return String(data?.title || data?.name || data?.trophyTitleName || data?.gameName || "").trim();
}

function titleMatch(left, right) {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\biii\b/g, "3")
    .replace(/\bii\b/g, "2")
    .replace(/\biv\b/g, "4")
    .replace(/\bvi\b/g, "6")
    .replace(/\bv\b/g, "5")
    .replace(/\bix\b/g, "9")
    .replace(/\bviii\b/g, "8")
    .replace(/\bvii\b/g, "7")
    .replace(/\bx\b/g, "10")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanSteamAppId(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 12);
}

function steamAppIdFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/store\.steampowered\.com$/i.test(url.hostname)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    const appIndex = parts.indexOf("app");
    return cleanSteamAppId(appIndex >= 0 ? parts[appIndex + 1] : "");
  } catch {
    return "";
  }
}

function textField(name, value) {
  return { name, type: 1, value: String(value || "").slice(0, 120) };
}

function numberField(name, value) {
  return { name, type: 2, value: Number(value || 0) };
}

function imageField(name, url) {
  return { name, type: 3, value: { url: absoluteImageUrl(url) || FALLBACK_IMAGE } };
}

function squareCoverUrl(value) {
  const source = absoluteImageUrl(value);
  if (!source) return FALLBACK_IMAGE;
  return `${BASE_URL}/api/cover?${new URLSearchParams({ width: "152", height: "152", fit: "cover", src: source })}`;
}

function absoluteImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, BASE_URL).toString();
  } catch {
    return "";
  }
}

async function validateAgainstWidgetConfig(appId, sampleData) {
  let configs = [];
  try {
    configs = await discordJson("GET", `/v10/applications/${appId}/widget-configs`);
  } catch (error) {
    console.warn(`Could not fetch widget config for validation: ${error.message}`);
    return;
  }

  const configList = Array.isArray(configs) ? configs : [configs].filter(Boolean);
  if (!configList.length) {
    console.warn("No widget config found. Create and publish the widget in Discord first.");
    return;
  }

  for (const config of configList) {
    const status = String(config.status || "unknown");
    const configId = config.config_id || config.id || "(unknown config)";
    console.log(`Widget config: ${configId}, status: ${status}`);
    if (status !== "published") console.warn("Widget config is not published. Discord may keep showing placeholders.");
  }

  const specs = extractDynamicFields(configList);
  const sampleByName = new Map((sampleData.data?.dynamic || []).map((entry) => [entry.name, entry]));
  const configNames = new Set(specs.map((spec) => spec.name));
  const errors = [];
  for (const spec of specs) {
    const entry = sampleByName.get(spec.name);
    if (!entry) {
      errors.push(`Missing field '${spec.name}' (${spec.presentationType})`);
      continue;
    }
    const expectedType = discordTypeForPresentation(spec.presentationType);
    if (expectedType && entry.type !== expectedType) {
      errors.push(`Field '${spec.name}' is type ${entry.type}, but widget config expects ${spec.presentationType} (type ${expectedType})`);
    }
  }

  if (errors.length) {
    console.error("Widget data does not match Discord's widget config:");
    errors.forEach((error) => console.error(`- ${error}`));
    console.error("Fix the Discord widget fields or this script's field list before applying.");
    process.exit(1);
  }

  const unusedGeneratedFields = [...sampleByName.keys()].filter((name) => !configNames.has(name));
  if (unusedGeneratedFields.length) {
    console.warn("These generated fields are not used by the published Discord widget config:");
    unusedGeneratedFields.forEach((name) => console.warn(`- ${name}`));
    console.warn("If one of those should appear in Discord, add it as a User Data field in the widget editor and publish again.");
  }

  console.log(`Validated ${specs.length} dynamic field(s) against Discord's widget config.`);
}

function extractDynamicFields(configs) {
  const fields = new Map();
  for (const config of configs) {
    const surfaces = config?.surfaces && typeof config.surfaces === "object" ? config.surfaces : {};
    for (const surface of Object.values(surfaces)) {
      const components = surface?.components && typeof surface.components === "object" ? surface.components : {};
      for (const component of Object.values(components)) {
        const componentFields = component?.fields && typeof component.fields === "object" ? component.fields : {};
        for (const field of Object.values(componentFields)) {
          if (field?.value_type !== "data" || !field.value) continue;
          fields.set(field.value, { name: field.value, presentationType: String(field.presentation_type || "text") });
        }
      }
    }
  }
  return [...fields.values()];
}

function discordTypeForPresentation(presentationType) {
  const value = String(presentationType || "").toLowerCase();
  if (value === "image") return 3;
  if (["number", "float", "integer", "double", "decimal"].includes(value)) return 2;
  if (value === "text") return 1;
  return 0;
}

async function discordJson(method, path, body, options = {}) {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: options.accessToken ? `Bearer ${options.accessToken}` : `Bot ${BOT_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }
  if (!response.ok) {
    const error = new Error(`Discord API ${method} ${path} failed (${response.status})`);
    error.status = response.status;
    error.body = typeof data === "string" ? data : JSON.stringify(data);
    throw error;
  }
  return data;
}

function ownerIdFromApplication(application) {
  return application?.owner?.id || application?.team?.owner_user_id || "";
}

function cleanEnv(name) {
  return String(process.env[name] || "").trim().replace(/^["']|["']$/g, "");
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim() || DEFAULT_BASE_URL;
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function authUrls(appId) {
  return [
    `https://discord.com/oauth2/authorize?client_id=${appId}&response_type=token&scope=sdk.social_layer_presence&prompt=consent`,
    `https://discord.com/oauth2/authorize?client_id=${appId}&response_type=token&scope=openid%20sdk.social_layer_presence&prompt=consent`,
    `https://discord.com/oauth2/authorize?client_id=${appId}&response_type=token&scope=openid%20sdk.social_layer&prompt=consent`,
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sourceHasCompletionData(data, source) {
  const platform = (data?.platforms || []).find((item) => String(item.source || "").toLowerCase() === source);
  if (!platform) return false;
  return Number(platform.totalCompletedGames || 0) > 0
    || (platform.completedGames || []).length > 0
    || (platform.completedGamesByYear || []).length > 0;
}
