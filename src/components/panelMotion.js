import {onBeforeUnmount} from 'vue';
import {AnimationManager, Easing, easing, spring} from '@liquid-dom/layout/animation';

// Use MenuDemo's position springs, with a shorter size spring for the lighter panels.
const sizeIn = spring({stiffness: 310, damping: 22, restDelta: .65, restSpeed: 12});
const sizeOut = easing({duration: .25, ease: Easing.easeOut});
const positionIn = spring({stiffness: 144, damping: 14, restDelta: .35, restSpeed: 4});
const positionOut = spring({stiffness: 130, damping: 18, restDelta: .35, restSpeed: 4});
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
    const {x, y, visibility, ...size} = to;
    manager.animate(state, size, opening ? sizeIn : sizeOut);
    if (x !== undefined) manager.animate(state, {x, y}, opening ? positionIn : positionOut);
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
  const {play, stop} = useMotion(name);
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
    const panel = element.getBoundingClientRect();
    const button = trigger.getBoundingClientRect();
    const content = body.getBoundingClientRect();
    const width = vanish ? 8 : button.width;
    const height = vanish ? 8 : button.height;
    const closed = {x: button.left - panel.left + (button.width - width) / 2,
      y: button.top - panel.top + (button.height - height) / 2, width, height,
      radius: vanish ? 4 : Math.min(height / 2, parseFloat(getComputedStyle(trigger).borderRadius) || 14),
      visibility: 0};
    const opened = {x: 0, y: 0, width: panel.width, height: panel.height,
      radius: parseFloat(getComputedStyle(element).borderRadius) || 16, visibility: 1};
    const offsetX = content.left - panel.left;
    const offsetY = content.top - panel.top;
    const glass = element.querySelector(':scope > .liquid-glass');
    const live = glass.getBoundingClientRect();
    const visibility = Number(getComputedStyle(body).opacity);
    const resumed = closingAnimations && {
      x: live.left - panel.left, y: live.top - panel.top,
      width: live.width, height: live.height, radius: opened.radius,
      visibility,
    };
    stopClosing();
    delete element.dataset.liquidNativeClose;

    function clip(x, y, w, h, radius) {
      const left = x - offsetX;
      const top = y - offsetY;
      const insets = [top, content.width - left - w, content.height - top - h, left];
      return `inset(${insets.map(pixels).join(' ')} round ${pixels(radius)})`;
    }

    function paint({x, y, width: w, height: h, radius, visibility}) {
      element.dataset.liquidMorph = '';
      for (const [key, value] of Object.entries({x, y, width: w, height: h, radius})) {
        element.style.setProperty(`--panel-morph-${key}`, pixels(value));
      }
      body.style.clipPath = clip(x, y, w, h, radius);
      body.style.opacity = visibility;
      if (!vanish) body.style.filter = `blur(${pixels((1 - visibility) * 3)})`;
    }

    function clear() {
      delete element.dataset.liquidMorph;
      for (const key of ['x', 'y', 'width', 'height', 'radius']) {
        element.style.removeProperty(`--panel-morph-${key}`);
      }
      body.style.clipPath = body.style.opacity = body.style.filter = '';
    }

    if (vanish && !opening && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Let the compositor carry the actual glass during dismissal, even while the map redraws.
      stop(true);
      clear();
      element.classList.remove(`${name}-enter-active`);
      element.classList.add(`${name}-leave-active`);
      element.dataset.liquidNativeClose = '';
      const state = {...opened, x: live.left - panel.left, y: live.top - panel.top,
        width: live.width, height: live.height, visibility};
      const driver = new AnimationManager();
      driver.animate(state, {x: closed.x, y: closed.y}, positionOut);
      driver.animate(state, {width: closed.width, height: closed.height, radius: closed.radius}, sizeOut);
      driver.animate(state, {visibility: 0}, contentOut);
      const glassFrames = [];
      const textFrames = [];
      for (let i = 0; i <= 18; i += 1) {
        const {x, y, width: w, height: h, radius, visibility} = state;
        glassFrames.push({transformOrigin: '0 0',
          transform: `translate(${pixels(x)}, ${pixels(y)}) scale(${w / panel.width}, ${h / panel.height})`,
          opacity: Math.min(1, (w - closed.width) / 18)});
        textFrames.push({clipPath: clip(x, y, w, h, radius), opacity: visibility});
        driver.tick(1000 / 60);
      }
      const timing = {duration: 300, fill: 'both'};
      const flight = glass.animate(glassFrames, timing);
      closingAnimations = [flight, body.animate(textFrames, timing)];
      flight.onfinish = () => {
        stopClosing();
        delete element.dataset.liquidNativeClose;
        element.classList.remove(`${name}-leave-active`);
        done();
      };
      return;
    }

    play(element, opening ? resumed ?? closed : opened, opening ? opened : closed,
      opening, paint, clear, done);
  }

  return {
    onEnter: (element, done) => morph(element, true, done),
    onLeave: (element, done) => morph(element, false, done),
    onEnterCancelled: stop,
    onLeaveCancelled: stop,
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
