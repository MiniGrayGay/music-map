<script setup>
/*!
 * MIT + Commons Clause License Condition v1.0
 * 
 * Copyright (c) 2026 David Haz
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, and distribute the Software **as part of an application, website, or product**, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * ## Commons Clause Restriction
 * 
 * You may use this Software, including for any commercial purpose, **so long as you do not sell, sublicense, or redistribute the components themselves-whether alone, in a bundle, or as a ported version.**
 * 
 * The same restriction covers the React Bits tools (Background Studio, Texture Lab, Shape Magic, Center Stage, Sound Lab and any tools added later) and the sounds in the sound library. **You may not sell, sublicense, or redistribute the tools or the sounds themselves, or offer the tools or a substantially similar copy of them as a hosted service-whether alone, in a bundle, or as a ported version.**
 * 
 * What you make with the tools is yours to use. You can use exported code, images, videos, and audio files in any personal or commercial application, website, or product, including paid ones. **You may not sell or redistribute the exports on their own, either individually or as the product itself, such as a sound, texture, background, or template pack.**
 * 
 * ## No Warranty
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {inject, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import FluidGlass from './react-bits/FluidGlass.jsx';

const props = defineProps({
  shape: {type: String, default: 'lens'},
  centered: {type: Boolean, default: false},
  orbit: {type: Boolean, default: false},
});
const backdrop = inject(fluidBackdropKey, null);
const host = ref(null);
const stage = ref(null);
const rim = ref(null);
const restingPosition = [0.5, 0.5];
const hoveredPosition = [0.54, 0.455];
let hovered = false;
let opticalDepth = 0;
let hoverFrame = 0;
let control;
let reducedMotion;
let root;
let observer;
let frame = 0;
let sample;
let lastSource;
let lastSize;
let backdropFilter = 'none';
// 与播放器的移动判定一致；配合 aria-label 只对关闭键做对比防护。
const mobileLayout = matchMedia('(max-width: 700px), (pointer: coarse)');
let contrastGuard = false;

function refresh() {
  if (!frame) frame = requestAnimationFrame(render);
}

function render() {
  frame = 0;
  const bounds = host.value?.getBoundingClientRect();
  if (!bounds?.width || !bounds.height) return;
  const size = Math.round(bounds.width * (props.shape === 'pill' ? 1 : .94));
  const extent = Math.ceil(size / .72 + 6);
  stage.value.style.width = stage.value.style.height = `${extent}px`;
  contrastGuard = mobileLayout.matches
    && control?.getAttribute('aria-label') === '关闭播放器';

  const source = backdrop?.value?.canvas;
  let src;
  if (source) {
    sample ??= document.createElement('canvas');
    sample.width = sample.height = extent;
    const scene = source.getBoundingClientRect();
    const context = sample.getContext('2d');
    const left = bounds.left + (bounds.width - extent) / 2;
    const top = bounds.top + (bounds.height - extent) / 2;
    if (context && scene.width && scene.height && source.width && source.height) {
      const blur = Number(backdropFilter.match(/blur\(([\d.]+)px\)/)?.[1] ?? 0);
      const margin = Math.ceil(blur * 3);
      const span = extent + margin * 2;
      const scaleX = source.width / scene.width;
      const scaleY = source.height / scene.height;
      context.filter = backdropFilter;
      // Include the blur's surroundings without filtering the entire map for each button.
      context.drawImage(source, (left - margin - scene.left) * scaleX, (top - margin - scene.top) * scaleY,
        span * scaleX, span * scaleY, -margin, -margin, span, span);
      // 亮背景（海面/白底）经折射会聚后可把镜头洗成纯白，浅色图标失去对比。
      // 仅移动/窄窗的播放器关闭键叠这层半透明深色；其余按钮与桌面保持原玻璃观感。
      if (contrastGuard) {
        context.filter = 'none';
        context.fillStyle = 'rgba(9, 23, 38, 0.5)';
        context.fillRect(-margin, -margin, span, span);
      }
      src = sample.toDataURL();
    }
  }

  if (root && src === lastSource && size === lastSize) return;
  lastSource = src;
  lastSize = size;
  root ??= createRoot(stage.value);
  renderGlass();
}

function renderGlass() {
  // The hover endpoint uses the upstream demo's Heavy optics.
  const position = hovered && !props.centered && !reducedMotion.matches
    ? hoveredPosition
    : restingPosition;
  root.render(createElement(FluidGlass, {
    shape: props.shape,
    size: lastSize,
    src: lastSource,
    text: '',
    background: 'transparent',
    reflection: .045 + .04 * opticalDepth,
    shadow: .5 + .2 * opticalDepth,
    refraction: 1 + .7 * opticalDepth,
    dispersion: .35 + .15 * opticalDepth,
    elevation: .4 + .7 * opticalDepth,
    interaction: 'static',
    position,
    idle: false,
    spin: 0,
    intro: false,
    morphOnClick: false,
    maxDevicePixelRatio: 1,
  }));
}

function updateHover() {
  cancelAnimationFrame(hoverFrame);
  hoverFrame = 0;
  const target = Number(hovered);
  if (reducedMotion.matches || !root) {
    opticalDepth = target;
    if (root) renderGlass();
    return;
  }

  const from = opticalDepth;
  const started = performance.now();
  function animate(now) {
    const progress = Math.min(1, (now - started) / 220);
    opticalDepth = from + (target - from) * (1 - (1 - progress) ** 3);
    renderGlass();
    hoverFrame = progress < 1 ? requestAnimationFrame(animate) : 0;
  }
  hoverFrame = requestAnimationFrame(animate);
}

function enterControl(event) {
  if (event.pointerType !== 'mouse' || control.disabled) return;
  hovered = true;
  updateHover();
}

function leaveControl() {
  if (!hovered) return;
  hovered = false;
  updateHover();
}

function sweepReflection(event) {
  const surface = rim.value;
  if (!surface || control.disabled || reducedMotion.matches) return;
  if (event.pointerType === 'mouse' && event.detail !== 0) return;
  if (surface.getAnimations().some((animation) => animation.id === 'glass-reflection')) return;
  const sweep = surface.animate([
    {transform: 'rotate(0turn)', opacity: .7},
    {transform: 'rotate(.08turn)', opacity: .86, offset: .42},
    {transform: 'rotate(0turn)', opacity: .7},
  ], {duration: 600, easing: 'cubic-bezier(.35,0,.65,1)'});
  sweep.id = 'glass-reflection';
}

if (backdrop) watch(backdrop, refresh, {flush: 'post'});
onMounted(() => {
  const panel = host.value.closest('.music-player')?.querySelector('.rdev-warp');
  if (panel) backdropFilter = getComputedStyle(panel).backdropFilter;
  control = host.value.closest('button');
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  control?.addEventListener('pointerenter', enterControl);
  control?.addEventListener('pointerleave', leaveControl);
  control?.addEventListener('click', sweepReflection);
  reducedMotion.addEventListener('change', updateHover);
  observer = new ResizeObserver(refresh);
  observer.observe(host.value);
  refresh();
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  cancelAnimationFrame(hoverFrame);
  control?.removeEventListener('pointerenter', enterControl);
  control?.removeEventListener('pointerleave', leaveControl);
  control?.removeEventListener('click', sweepReflection);
  reducedMotion?.removeEventListener('change', updateHover);
  observer?.disconnect();
  const canvas = stage.value?.querySelector('canvas');
  root?.unmount();
  canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
});
defineExpose({refresh});
</script>

<script>
export const fluidBackdropKey = Symbol('fluid-glass-source-canvas');
</script>

<template>
  <span ref="host" class="fluid-source-surface"
        :class="{'fluid-source-surface--orbit': orbit}" aria-hidden="true">
    <span ref="stage" class="fluid-source-stage" />
    <span v-if="orbit" ref="rim" class="fluid-source-reflection" />
  </span>
</template>

<style scoped>
.fluid-source-surface {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}

.fluid-source-stage {
  position: absolute;
  top: 50%;
  left: 50%;
  display: block;
  transform: translate(-50%, -50%);
}

.fluid-source-surface--orbit .fluid-source-stage {
  filter: saturate(.52);
}

.fluid-source-reflection {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: conic-gradient(from -90deg,
    transparent 0deg, rgb(172 216 227 / .28) 37deg, rgb(244 250 243 / .72) 56deg,
    rgb(194 228 239 / .32) 89deg, transparent 125deg,
    transparent 190deg, rgb(236 189 159 / .34) 224deg, rgb(243 226 207 / .30) 253deg,
    transparent 290deg);
  mask-image: radial-gradient(circle closest-side,
    transparent 73%, rgb(0 0 0 / .18) 80%, #000 95%, transparent 100%);
  opacity: .7;
  transform: rotate(0turn);
}

@media (hover: hover) and (pointer: fine) {
  button:hover:not(:disabled) .fluid-source-surface {
    box-shadow: 0 3px 8px rgb(17 23 28 / .24), 0 1px 2px rgb(17 23 28 / .12);
  }

  button:hover:not(:disabled) .fluid-source-reflection {
    opacity: 1;
  }
}

@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {
  .fluid-source-surface {
    transition: box-shadow 190ms var(--ease-glass-in);
  }

  .fluid-source-reflection {
    transition: transform 420ms var(--ease-glass-in), opacity 190ms ease;
  }

  button:hover:not(:disabled) .fluid-source-reflection {
    transform: rotate(.27turn);
  }
}

@media (forced-colors: active) {
  .fluid-source-surface {
    display: none;
  }
}
</style>
