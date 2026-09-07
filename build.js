/* eslint-disable no-undef */
// Arquivo de referência executado no GitHub Actions (Node.js no runner), fora do app React.
// Executado no GitHub Actions (ubuntu-latest, com Android SDK e Node prontos).
// Recebe o pedido via BUILD_PAYLOAD, gera o APK a partir do template WebView,
// publica em GitHub Releases e devolve o progresso ao app via callback.
const { exec } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const payload = JSON.parse(process.env.BUILD_PAYLOAD || "{}");
const GH_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;

const buildId = String(payload.build_id || "manual");
const callbackUrl =
  payload.callback_url || "https://web-to-apk-app.base44.app/functions/buildStatusCallback";

const TEMPLATE_DIR = path.join(process.cwd(), "template");
const WORK_DIR = path.join(process.cwd(), "work");
const APK_PATH = path.join(process.cwd(), `${buildId}.apk`);

function run(cmd, cwd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
      else resolve(stdout);
    });
  });
}

async function report(data) {
  // O callback já contém o token único do build na própria URL — sem segredo compartilhado.
  if (!callbackUrl) return;
  try {
    await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ build_id: buildId, ...data }),
    });
  } catch (err) {
    console.error("Falha no callback:", err.message);
  }
}

async function ghApi(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${url} -> HTTP ${res.status}: ${await res.text()}`);
  return res;
}

async function main() {
  const started = Date.now();
  const cfg = payload.config || {};

  await report({ status: "preparing", progress: 10 });

  // 1. Copia o template para a pasta de trabalho e aplica os patches.
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.cpSync(TEMPLATE_DIR, WORK_DIR, { recursive: true });

  const read = (rel) => fs.promises.readFile(path.join(WORK_DIR, rel), "utf8");
  const write = (rel, data) => fs.promises.writeFile(path.join(WORK_DIR, rel), data);

  const appId = "com.siteparaapk.b" + buildId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  await write("app/build.gradle", (await read("app/build.gradle")).replace("{{PACKAGE}}", appId));
  await write(
    "app/src/main/res/values/strings.xml",
    (await read("app/src/main/res/values/strings.xml")).replace("{{APP_NAME}}", String(payload.app_name || "Meu App"))
  );

  let colors = await read("app/src/main/res/values/colors.xml");
  colors = colors
    .replace("{{SPLASH_COLOR}}", cfg.splash_color || "#2563EB")
    .replace("{{STATUS_BAR_COLOR}}", cfg.status_bar_color || "#2563EB")
    .replace("{{NAV_BAR_COLOR}}", cfg.nav_bar_color || "#FFFFFF");
  await write("app/src/main/res/values/colors.xml", colors);

  const perms = (Array.isArray(cfg.permissions) ? cfg.permissions : [])
    .map((perm) => `    <uses-permission android:name="android.permission.${String(perm).toUpperCase()}"/>`)
    .join("\n");
  let manifest = await read("app/src/main/AndroidManifest.xml");
  manifest = manifest
    .replace("{{PERMISSIONS}}", perms || "    <!-- sem permissões extras -->")
    .replace(
      "{{ORIENTATION}}",
      { portrait: "portrait", landscape: "landscape", auto: "fullSensor" }[cfg.orientation] || "portrait"
    );
  if (cfg.icon_url) {
    try {
      const iconDir = path.join(WORK_DIR, "app/src/main/res/drawable");
      fs.mkdirSync(iconDir, { recursive: true });
      const iconRes = await fetch(cfg.icon_url);
      if (!iconRes.ok) throw new Error("HTTP " + iconRes.status);
      fs.writeFileSync(path.join(iconDir, "icon.png"), Buffer.from(await iconRes.arrayBuffer()));
      manifest = manifest.replace("{{ICON_ATTR}}", 'android:icon="@drawable/icon"');
    } catch {
      manifest = manifest.replace("{{ICON_ATTR}}", "");
    }
  } else {
    manifest = manifest.replace("{{ICON_ATTR}}", "");
  }
  await write("app/src/main/AndroidManifest.xml", manifest);

  fs.mkdirSync(path.join(WORK_DIR, "app/src/main/assets"), { recursive: true });
  await write(
    "app/src/main/assets/config.json",
    JSON.stringify(
      {
        site_url: payload.site_url,
        enable_js: cfg.enable_js !== false,
        offline_cache: !!cfg.offline_cache,
        allow_downloads: cfg.allow_downloads !== false,
        external_links_browser: cfg.external_links_browser !== false,
        custom_css: cfg.custom_css || "",
        custom_js: cfg.custom_js || "",
        display_mode: cfg.display_mode || "navbar",
        status_bar_color: cfg.status_bar_color || "#2563EB",
      },
      null,
      2
    )
  );

  // 2. Compila (o runner já tem JDK e Android SDK configurados).
  await report({ status: "compiling", progress: 40 });
  await run("gradle wrapper --gradle-version 8.9", WORK_DIR);
  await run("./gradlew assembleDebug --no-daemon", WORK_DIR);

  const builtApk = path.join(WORK_DIR, "app/build/outputs/apk/debug/app-debug.apk");
  fs.copyFileSync(builtApk, APK_PATH);
  const sizeMb = Number((fs.statSync(APK_PATH).size / (1024 * 1024)).toFixed(1));

  await report({ status: "signing", progress: 70 });

  // 3. Publica o APK em um GitHub Release (link público e permanente).
  const releaseRes = await ghApi(`https://api.github.com/repos/${REPO}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: `build-${buildId}`,
      name: `APK ${buildId}`,
      body: `App: ${payload.app_name || "Meu Site"}\nSite: ${payload.site_url}`,
    }),
  });
  const release = await releaseRes.json();

  await ghApi(
    `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${buildId}.apk`,
    {
      method: "POST",
      headers: { "Content-Type": "application/vnd.android.package-archive" },
      body: fs.readFileSync(APK_PATH),
    }
  );

  // 4. Callback final com o link de download.
  const sha = crypto.createHash("sha256").update(fs.readFileSync(APK_PATH)).digest("hex");
  await report({
    status: "completed",
    progress: 100,
    apk_url: `https://github.com/${REPO}/releases/download/build-${buildId}/${buildId}.apk`,
    sha256: sha,
    apk_size_mb: sizeMb,
    duration_seconds: Math.round((Date.now() - started) / 1000),
    expires_date: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  console.log(`Build ${buildId} concluído e publicado em GitHub Releases.`);
}

main().catch(async (err) => {
  console.error("Build falhou:", err.message);
  await report({ status: "failed", error_message: String(err.message).slice(0, 500) });
  process.exit(1);
});