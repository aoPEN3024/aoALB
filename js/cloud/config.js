const CONFIG_KEY = "aoALB:cloudConfig";

function decodeJwtRole(value) {
  try {
    const part = String(value).split(".")[1];
    if (!part) return "";
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return String(JSON.parse(atob(padded))?.role || "");
  } catch (_) {
    return "";
  }
}

export function validateCloudConfig(input) {
  const projectUrl = String(input?.projectUrl || "").trim().replace(/\/$/, "");
  const publishableKey = String(input?.publishableKey || "").trim();
  if (!projectUrl || !publishableKey) throw new Error("Project URLと公開用publishable keyを入力してください。");
  let url;
  try { url = new URL(projectUrl); } catch (_) { throw new Error("Project URLの形式が正しくありません。"); }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("Project URLはHTTPSを使用してください。");
  if (publishableKey.startsWith("sb_secret_") || /service[_-]?role/i.test(publishableKey) || decodeJwtRole(publishableKey) === "service_role") {
    throw new Error("service role keyや秘密鍵はブラウザへ保存できません。");
  }
  if (!publishableKey.startsWith("sb_publishable_") && !publishableKey.startsWith("eyJ")) throw new Error("公開用publishable keyを確認してください。");
  return { projectUrl, publishableKey };
}

export function loadCloudConfig() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    return parsed ? validateCloudConfig(parsed) : null;
  } catch (_) {
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
