const CONFIG_KEY = "aoALB:cloudConfig";
const LOCAL_CONFIG_PATH = "./config/cloud.local.json";
let localFileConfig = null;
let localFileChecked = false;

export function validateCloudConfig(input) {
  const projectUrl = String(input?.projectUrl || "").trim().replace(/\/+$/, "");
  const publishableKey = String(input?.publishableKey || "").trim();
  if (!projectUrl || !publishableKey) throw new Error("Project URLと公開用publishable keyを入力してください。");
  let url;
  try { url = new URL(projectUrl); } catch (_) { throw new Error("Project URLの形式が正しくありません。"); }
  const localHost = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) throw new Error("Project URLはHTTPSを使用してください。");
  if (url.username || url.password || url.search || url.hash) throw new Error("Project URLに認証情報、クエリ、フラグメントを含めないでください。");
  if (!localHost && (!/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || (url.pathname && url.pathname !== "/"))) {
    throw new Error("Supabase Dashboardに表示されたProject URLをそのまま使用してください。");
  }
  if (/^(sb_secret_|eyJ)/i.test(publishableKey) || /service[_-]?role|secret|database[_ -]?password/i.test(publishableKey)) {
    throw new Error("Secret key、service_role key、旧JWT keyはブラウザへ保存できません。sb_publishable_で始まるPublishable keyだけを使用してください。");
  }
  if (/YOUR_PROJECT_REF|REPLACE_WITH/i.test(projectUrl + publishableKey)
      || !/^sb_publishable_[A-Za-z0-9._-]{20,}$/.test(publishableKey)) {
    throw new Error("sb_publishable_で始まるPublishable keyを確認してください。");
  }
  return { projectUrl, publishableKey };
}

export async function loadLocalCloudConfig() {
  if (localFileChecked) return localFileConfig;
  localFileChecked = true;
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return null;
  let response;
  try {
    response = await fetch(LOCAL_CONFIG_PATH, { cache: "no-store", credentials: "same-origin" });
  } catch (_) {
    return null;
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`ローカル接続設定を読み込めませんでした（HTTP ${response.status}）。`);
  let parsed;
  try { parsed = await response.json(); } catch (_) { throw new Error("config/cloud.local.jsonが正しいJSONではありません。"); }
  localFileConfig = validateCloudConfig(parsed);
  return localFileConfig;
}

export function loadCloudConfig() {
  if (localFileConfig) return localFileConfig;
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    return parsed ? validateCloudConfig(parsed) : null;
  } catch (_) {
    localStorage.removeItem(CONFIG_KEY);
    return null;
  }
}

export function saveCloudConfig(input) {
  const config = validateCloudConfig(input);
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  return config;
}

export function clearCloudConfig() {
  localStorage.removeItem(CONFIG_KEY);
}
