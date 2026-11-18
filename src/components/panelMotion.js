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

export function useAnchoredPanel(anchor, {
  name = 'liquid-panel', vanish = false, inline = false, followSize = false,
} = {}) {
  let motion;
  let observer;
  let panelSize;
  function stop() {
    if (!motion) return;
    cancelAnimationFrame(motion.frame);
    for (const animation of motion.animations) animation.cancel();
    motion = null;
  }
  onBeforeUnmount(() => {
    observer?.disconnect();
    stop();
  });

  function followPanel(element) {
    if (!followSize || observer) return;
    observer = new ResizeObserver(() => {
      if (element.inert || !panelSize) return;
      const bounds = element.getBoundingClientRect();
      if (Math.abs(bounds.height - panelSize.height) < .75
        && Math.abs(bounds.width - panelSize.width) < .75) return;
      morph(element, true, motion?.done ?? (() => {}), panelSize);
    });
    observer.observe(element);
  }

  function morph(element, opening, done, resizeFrom = null) {
    element.inert = !opening;
    if (!opening) {
      observer?.disconnect();
      observer = null;
      panelSize = null;
    }
    const resolvedAnchor = inline ? null : anchor(element);
    const trigger = resolvedAnchor?.isConnected ? resolvedAnchor : null;
    const body = element.querySelector(':scope > .liquid-panel-body');
    const glass = element.querySelector(':scope > .liquid-glass');
    if (!body || !glass) {
      done();
      return;
    }
    const finish = () => {
      stop();
      delete element.dataset.liquidMorph;
      element.classList.remove(`${name}-enter-active`, `${name}-leave-active`);
      done();
    };
    const panel = element.getBoundingClientRect();
    const button = trigger?.getBoundingClientRect();
    const content = body.getBoundingClientRect();
    const width = vanish ? 8 : button?.width ?? panel.width * .94;
    const height = vanish ? 8 : button ? Math.min(12, button.height * .25) : 0;
    let closedTop = panel.height * .22;
    if (button) {
      const above = panel.bottom <= button.top;
      closedTop = (above ? button.top - height : button.bottom) - panel.top;
      if (vanish) closedTop = button.top - panel.top + (button.height - height) / 2;
    }
    const closed = {
      x: button ? button.left - panel.left + (button.width - width) / 2 : (panel.width - width) / 2,
      y: closedTop,
      width, height,
      radius: vanish ? 4 : trigger ? Math.min(height / 2, parseFloat(getComputedStyle(trigger).borderRadius) || 14) : 0,
      visibility: 0,
    };
    const opened = {x: 0, y: 0, width: panel.width, height: panel.height,
      radius: parseFloat(getComputedStyle(element).borderRadius) || 16,
      visibility: 1};
    const offsetX = content.left - panel.left;
    const offsetY = content.top - panel.top;
    const live = glass.getBoundingClientRect();
    const current = {
      x: live.left - panel.left, y: live.top - panel.top,
      width: live.width, height: live.height,
      radius: parseFloat(getComputedStyle(glass).borderRadius) || opened.radius,
      visibility: Number(getComputedStyle(body).opacity),
    };
    const interrupted = Boolean(motion);
    stop();
    if (opening) {
      panelSize = opened;
      followPanel(element);
    }

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

    // 玻璃始终直接采样地图。透明度动画只作用于正文，避免创建背板根而隔断采样。
    element.dataset.liquidMorph = '';
    element.classList.toggle(`${name}-enter-active`, opening);
    element.classList.toggle(`${name}-leave-active`, !opening);
    const from = !opening || interrupted ? current : resizeFrom ?? closed;
    const to = opening ? opened : closed;
    const duration = resizeFrom ? 205 : opening ? 340 : 250;
    const timing = {duration, easing: opening ? 'cubic-bezier(.24,.61,.29,1)' : 'cubic-bezier(.44,.03,.70,.48)',
      fill: 'both'};
    const glassFrame = ({x, y, width: w, height: h, radius}) => ({
      left: pixels(x), top: pixels(y), width: pixels(w), height: pixels(h), borderRadius: pixels(radius),
    });
    const glassFlight = glass.animate([glassFrame(from), glassFrame(to)], timing);
    const bodyFlight = body.animate([
      {clipPath: clip(from.x, from.y, from.width, from.height, from.radius)},
      {clipPath: clip(to.x, to.y, to.width, to.height, to.radius)},
    ], timing);
    // Bring in the labels once the glass is wide enough to display them.
    const delay = opening && !resizeFrom && !interrupted ? 76 : 0;
    const contentTiming = {duration: opening ? Math.min(204, duration - delay) : 142,
      delay, easing: opening ? 'ease-out' : 'ease-in', fill: 'both'};
    const contentFlight = body.animate([{opacity: from.visibility}, {opacity: to.visibility}],
      contentTiming);
    const animations = [glassFlight, bodyFlight, contentFlight];
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 0;
    }
    // Advance glass, clip and content together on painted frames. A slow
    // map/backdrop frame can't consume the entire opening or closing phase.
    const batch = motion = {animations, done, frame: 0};
    let last = performance.now();
    let elapsed = 0;
    const advance = (time) => {
      if (motion !== batch) return;
      elapsed += Math.min(40, Math.max(0, time - last));
      last = time;
      for (const animation of animations) animation.currentTime = Math.min(elapsed, duration);
      if (elapsed < duration) batch.frame = requestAnimationFrame(advance);
      else finish();
    };
    batch.frame = requestAnimationFrame(advance);
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
