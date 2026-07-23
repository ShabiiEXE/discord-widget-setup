const appId = cleanEnv(process.env.DISCORD_APP_ID || process.argv[2]);

if (!appId) {
  console.error("Missing DISCORD_APP_ID.");
  console.error("Usage:");
  console.error("  $env:DISCORD_APP_ID = \"your-discord-app-id\"");
  console.error("  npm run discord:auth");
  console.error("");
  console.error("Or:");
  console.error("  node scripts/discord-auth-urls.mjs your-discord-app-id");
  process.exit(1);
}

console.log("Open these while logged into the Discord account from DISCORD_USER_ID:");
console.log("");
authUrls(appId).forEach((url) => console.log(url));
console.log("");
console.log("If Discord redirects with an access_token in the URL, save it locally as DISCORD_ACCESS_TOKEN before running npm run discord:update.");

function authUrls(clientId) {
  return [
    `https://discord.com/oauth2/authorize?client_id=${clientId}&response_type=token&scope=sdk.social_layer_presence&prompt=consent`,
    `https://discord.com/oauth2/authorize?client_id=${clientId}&response_type=token&scope=openid%20sdk.social_layer_presence&prompt=consent`,
    `https://discord.com/oauth2/authorize?client_id=${clientId}&response_type=token&scope=openid%20sdk.social_layer&prompt=consent`,
  ];
}

function cleanEnv(value) {
  return String(value || "").trim().replace(/^["']|["']$/g, "");
}
