import {onBeforeUnmount} from 'vue';
import {AnimationManager, Easing, easing, spring} from '@liquid-dom/layout/animation';

// 抽屉只动高度与正文透明度：高度用弹簧，透明度用定时缓动。
const sizeIn = spring({stiffness: 310, damping: 22, restDelta: .65, restSpeed: 12});
const sizeOut = easing({duration: .25, ease: Easing.easeOut});
const contentIn = easing({duration: .3, ease: Easing.easeIn});
const contentOut = easing({duration: .21, ease: Easing.easeOut});
const pixels = (value) => `${value}px`;

function useMotion(name) {
  let element;
  let state;
  let frame;

  function stop(reset = false) {
    cancelAnimationFrame(frame);
    frame = 0;
    if (reset === true) state = null;
  }

  function play(node, from, to, opening, paint, clear, done) {
    stop();
    if (element !== node) state = null;
    element = node;
    node.classList.toggle(`${name}-enter-active`, opening);
    node.classList.toggle(`${name}-leave-active`, !opening);
    const finish = () => {
      state = null;
      node.classList.remove(`${name}-enter-active`, `${name}-leave-active`);
      clear();
      done();
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }

    state ??= from;
    const manager = new AnimationManager();
    const {visibility, ...size} = to;
    manager.animate(state, size, opening ? sizeIn : sizeOut);
    manager.animate(state, {visibility}, opening ? contentIn : contentOut);
    paint(state);
    let previous = performance.now();
    const tick = (time) => {
      // Keep intermediate geometry visible when the map drops a render frame.
      manager.tick(Math.min(48, Math.max(0, time - previous)));
      previous = time;
      paint(state);
      if (manager.active) frame = requestAnimationFrame(tick);
      else {
        frame = 0;
        finish();
      }
    };
    frame = requestAnimationFrame(tick);
  }

  onBeforeUnmount(stop);
  return {play, stop};
}

export function useAnchoredPanel(anchor, {name = 'liquid-panel', vanish = false} = {}) {
  let closingAnimations;
  const stopClosing = () => {
    for (const animation of closingAnimations ?? []) animation.cancel();
    closingAnimations = null;
  };
  onBeforeUnmount(stopClosing);

  function morph(element, opening, done) {
    element.inert = !opening;
    const trigger = anchor(element);
    const body = element.querySelector(':scope > .liquid-panel-body');
    if (!trigger || !body) {
      done();
      return;
    }
    const finish = () => {
      stopClosing();
      delete element.dataset.liquidMorph;
      element.classList.remove(`${name}-enter-active`, `${name}-leave-active`);
      done();
    };
    const panel = element.getBoundingClientRect();
    const button = trigger.getBoundingClientRect();
    const content = body.getBoundingClientRect();
    const width = vanish ? 8 : button.width;
    const height = vanish ? 8 : button.height;
    const closed = {x: button.left - panel.left + (button.width - width) / 2,
      y: button.top - panel.top + (button.height - height) / 2, width, height,
      radius: vanish ? 4 : Math.min(height / 2, parseFloat(getComputedStyle(trigger).borderRadius) || 14),
      opacity: .8, visibility: 0};
    const opened = {x: 0, y: 0, width: panel.width, height: panel.height,
      radius: parseFloat(getComputedStyle(element).borderRadius) || 16,
      opacity: 1, visibility: 1};
    const offsetX = content.left - panel.left;
    const offsetY = content.top - panel.top;
    const glass = element.querySelector(':scope > .liquid-glass');
    const live = glass.getBoundingClientRect();
    const glassOpacity = Number(getComputedStyle(glass).opacity);
    const bodyOpacity = Number(getComputedStyle(body).opacity);
    // 中断续接：两种方向都从玻璃/正文的实际透明度与当前矩形出发，不重置。
    const resumed = closingAnimations && {
      x: live.left - panel.left, y: live.top - panel.top,
      width: live.width, height: live.height, radius: opened.radius,
      opacity: glassOpacity, visibility: bodyOpacity,
    };
    stopClosing();

    function clip(x, y, w, h, radius) {
      const left = x - offsetX;
      const top = y - offsetY;
      const insets = [top, content.width - left - w, content.height - top - h, left];
      return `inset(${insets.map(pixels).join(' ')} round ${pixels(radius)})`;
    }

    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }

    // 开关整体交给合成器：玻璃只做 transform 平移缩放与 opacity，正文只做
    // clip/opacity 同步，固定几何，避免逐帧布局与逐帧重光栅。桌面与触屏
    // 同一路径，滤镜全程保持静止态不变，收尾不再切换。
    element.dataset.liquidMorph = '';
    element.classList.toggle(`${name}-enter-active`, opening);
    element.classList.toggle(`${name}-leave-active`, !opening);
    const from = opening ? resumed ?? closed
      : {x: live.left - panel.left, y: live.top - panel.top,
        width: live.width, height: live.height, radius: opened.radius,
        opacity: glassOpacity, visibility: bodyOpacity};
    const to = opening ? opened : {...closed, opacity: 0, visibility: 0};
    const timing = {duration: 290, easing: 'cubic-bezier(0.32, 0.72, 0.25, 1)', fill: 'both'};
    const glassFrame = ({x, y, width: w, height: h, opacity}) => ({transformOrigin: '0 0',
      transform: `translate(${pixels(x)}, ${pixels(y)}) scale(${w / panel.width}, ${h / panel.height})`,
      opacity});
    const glassFlight = glass.animate([glassFrame(from), glassFrame(to)], timing);
    const bodyFlight = body.animate([
      {clipPath: clip(from.x, from.y, from.width, from.height, from.radius), opacity: from.visibility},
      {clipPath: clip(to.x, to.y, to.width, to.height, to.radius), opacity: to.visibility},
    ], timing);
    closingAnimations = [glassFlight, bodyFlight];
    const batch = closingAnimations;
    glassFlight.onfinish = () => {
      if (glassFlight.playState !== 'finished' || closingAnimations !== batch) return;
      finish();
    };
  }

  return {
    onEnter: (element, done) => morph(element, true, done),
    onLeave: (element, done) => morph(element, false, done),
  };
}

export function useDrawerMotion() {
  const {play, stop} = useMotion('reveal');

  function morph(element, opening, done) {
    const body = element.firstElementChild;
    const {height: previousHeight} = element.getBoundingClientRect();
    element.style.blockSize = '';
    element.style.marginBlockStart = '';
    const height = element.getBoundingClientRect().height;
    const gap = parseFloat(getComputedStyle(element).getPropertyValue('--reveal-gap')) || 0;
    const opened = {height, visibility: 1};
    const closed = {height: 0, visibility: 0};

    function paint(frame) {
      element.dataset.liquidDrawer = '';
      element.style.blockSize = pixels(Math.max(0, frame.height));
      const progress = height ? Math.min(1, Math.max(0, frame.height / height)) : 1;
      element.style.marginBlockStart = pixels(-gap * (1 - progress));
      body.style.opacity = frame.visibility;
      body.style.transform = `translateY(${pixels((1 - frame.visibility) * -10)})`;
    }

    function clear() {
      delete element.dataset.liquidDrawer;
      element.style.blockSize = element.style.marginBlockStart = '';
      body.style.opacity = body.style.transform = '';
    }

    play(element, opening ? closed : {height: previousHeight, visibility: 1}, opening ? opened : closed,
      opening, paint, clear, done);
  }

  return {
    onEnter: (element, done) => morph(element, true, done),
    onLeave: (element, done) => morph(element, false, done),
    onEnterCancelled: stop,
    onLeaveCancelled: stop,
  };
}
