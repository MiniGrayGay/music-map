// 移动设备判定（点云等桌面能力的门禁共用）。
// 判据按「明确移动身份优先」排列：UA 移动令牌 / userAgentData.mobile /
// iPad 桌面化 UA（MacIntel + 多触点）无论屏幕多大都按手机处理；
// 桌面 UA 的窄触屏（手机桌面模式）由小屏 + 触点/移动 UA 兜底；
// 触屏笔记本屏幕大且非移动 UA，正常放行。
export function isMobileDevice() {
  if (navigator.userAgentData?.mobile) return true;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPod|Windows Phone|Mobile/i.test(ua)) return true;
  // iPadOS 桌面化 UA 不带 iPad/Mobile，但保留多点触控且自称 Mac；
  // 真正的 Mac 桌面 maxTouchPoints 为 0（触控栏 MacBook 也是 0）。
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  const smallScreen = Math.min(screen.width, screen.height) <= 760;
  return smallScreen && (navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|Mobile/i.test(ua));
}
