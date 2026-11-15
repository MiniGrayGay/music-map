// 弹层 Escape 消费栈：全局唯一 Escape 分发点（window 捕获阶段）。
// 每个打开的弹层（地图菜单、分层搜索面板、播放器抽屉、条件下拉、播放器
// 本身）注册一个消费者；按 LIFO 让最后打开的最先关闭，消费后阻止事件
// 继续传播，避免一次 Escape 同时关掉下层（播放器/地图选择）。栈空时不
// 拦截，地图容器自身的 Escape（清除悬停/点选）保持原行为。
const stack = [];
let listening = false;

function onWindowKeydown(event) {
  if (event.key !== 'Escape') return;
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index](event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
}

// 注册消费者；返回释放函数。消费者返回 true 表示已消费（自己处于打开
// 状态并关闭了自己）。仅在需要时注册（watch 打开状态），避免空栈开销。
export function pushEscapeHandler(handler) {
  if (!listening) {
    window.addEventListener('keydown', onWindowKeydown, true);
    listening = true;
  }
  stack.push(handler);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const at = stack.indexOf(handler);
    if (at >= 0) stack.splice(at, 1);
    if (stack.length === 0 && listening) {
      window.removeEventListener('keydown', onWindowKeydown, true);
      listening = false;
    }
  };
}
