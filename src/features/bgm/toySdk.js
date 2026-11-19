const sdkUrl = 'https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js';
let sdkRequest;

export function isToySharedStorageId(value) {
  return typeof value === 'string' && /^st_[a-z0-9]{16}$/.test(value);
}

export function isToyHost() {
  const {hostname, pathname} = location;
  if (/(^|\.)bilibilitoy\.com$/i.test(hostname)) return true;
  return /(^|\.)bilibili\.com$/i.test(hostname)
    && (pathname.startsWith('/toy/') || Boolean(window.__TOY_META__?.toy_id));
}

export function loadToySdk() {
  if (!isToyHost()) return Promise.resolve(null);
  if (window.toy) return Promise.resolve(window.toy);
  sdkRequest ??= new Promise((resolve) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = sdkUrl;
    function finish(sdk) {
      window.clearTimeout(timeout);
      script.onload = script.onerror = null;
      if (!sdk) script.remove();
      resolve(sdk);
    }
    const timeout = window.setTimeout(() => finish(null), 4000);
    script.onload = () => finish(window.toy ?? null);
    script.onerror = () => finish(null);
    document.head.append(script);
  }).then((sdk) => {
    if (!sdk) sdkRequest = undefined;
    return sdk;
  });
  return sdkRequest;
}
