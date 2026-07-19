const MOCK_EVENT_PREFIX = "aoALB:mockEvents:";
const MOCK_CHANNEL = "aoALB:site-sharing-mock";

function siteIdFor(code) {
  const bytes = new TextEncoder().encode(String(code).toUpperCase());
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  const tail = (hash >>> 0).toString(16).padStart(8, "0");
  return `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
}

export class MockSiteProvider {
  constructor(deviceId) {
    this.deviceId = deviceId;
    this.channel = null;
  }

  async authenticate() {
    return { userId: this.deviceId, anonymous: true };
  }

  async joinSite({ siteCode, joinCode, deviceName }) {
    const normalized = String(siteCode || "").trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(normalized)) throw new Error("現場IDは英数字、ハイフン、アンダースコアで入力してください。");
    if (joinCode !== "DEMO-ONLY") throw new Error("端末内試作の参加コードはDEMO-ONLYです。");
    return { siteId: siteIdFor(normalized), siteCode: normalized, siteName: `${normalized}（端末内試作）`, role: "editor", deviceName };
  }

  async pushTestMetadata(event) {
    const key = `${MOCK_EVENT_PREFIX}${event.siteId}`;
    const existing = JSON.parse(localStorage.getItem(key) || "[]");
    if (!existing.some(item => item.eventId === event.eventId)) existing.push(structuredClone(event));
    localStorage.setItem(key, JSON.stringify(existing.slice(-100)));
    this.channel?.postMessage(event);
    return event;
  }

  subscribe(siteId, callback) {
    this.unsubscribe();
    if (typeof BroadcastChannel !== "function") return () => {};
    this.channel = new BroadcastChannel(MOCK_CHANNEL);
    this.channel.onmessage = message => { if (message.data?.siteId === siteId) callback(message.data); };
    return () => this.unsubscribe();
  }

  unsubscribe() {
    this.channel?.close();
    this.channel = null;
  }
}
