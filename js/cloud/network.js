export const NETWORK_STATUS = Object.freeze({ WIFI: "wifi", MOBILE: "mobile", UNKNOWN: "unknown", OFFLINE: "offline" });

export function detectNetworkStatus(navigatorLike = globalThis.navigator) {
  if (navigatorLike?.onLine === false) return NETWORK_STATUS.OFFLINE;
  const connection = navigatorLike?.connection || navigatorLike?.mozConnection || navigatorLike?.webkitConnection;
  const type = String(connection?.type || "").toLowerCase();
  if (type === "wifi" || type === "ethernet") return NETWORK_STATUS.WIFI;
  if (type === "cellular" || type === "mobile" || type === "wimax") return NETWORK_STATUS.MOBILE;
  return NETWORK_STATUS.UNKNOWN;
}

export function shouldAutoSync(settings, networkStatus) {
  if (networkStatus === NETWORK_STATUS.OFFLINE || settings?.mode === "manual") return false;
  if (settings?.mode === "any_network") return settings.anyNetworkConfirmed === true;
  return networkStatus === NETWORK_STATUS.WIFI;
}

export function networkLabel(status) {
  return ({ wifi: "Wi-Fi", mobile: "モバイル通信", unknown: "回線不明", offline: "オフライン" })[status] || "回線不明";
}

export function formatTransferBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = [[1024 ** 3, "GB"], [1024 ** 2, "MB"], [1024, "KB"]];
  const [base, unit] = units.find(([size]) => bytes >= size) || [1, "bytes"];
  const digits = base === 1 ? 0 : bytes / base >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: digits }).format(bytes / base)} ${unit}`;
}
