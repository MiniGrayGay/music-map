const retirements = new WeakMap();

export function retireReliefDock(dock) {
  const pending = retirements.get(dock);
  if (pending) return pending;
  if (!dock.hasAttribute('data-relief-placed') || dock.dataset.reliefOpen !== 'true'
    || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    delete dock.dataset.reliefPlaced;
    return null;
  }

  const glass = dock.querySelector(':scope > .liquid-glass');
  const content = dock.querySelector('.relief-content');
  const bounds = dock.getBoundingClientRect();
  const rect = glass.getBoundingClientRect();
  const left = rect.left - bounds.left;
  const top = rect.top - bounds.top;
  const centerX = left + rect.width / 2;
  const centerY = top + rect.height / 2;
  const radius = getComputedStyle(glass).borderRadius;
  const clip = (x, y, width, height, rounding) =>
    `inset(${y}px ${bounds.width - x - width}px ${bounds.height - y - height}px ${x}px round ${rounding})`;
  const timing = {duration: 220, easing: 'cubic-bezier(.42, .04, .71, .42)', fill: 'forwards'};

  // Keep the old dock in place while the glass closes around its current contents.
  dock.dataset.reliefClosing = '';
  const glassMotion = glass.animate([
    {left: `${left}px`, top: `${top}px`, width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: radius},
    {left: `${centerX}px`, top: `${centerY}px`, width: '0px', height: '0px', borderRadius: '6px'},
  ], timing);
  const contentMotion = content.animate([
    {opacity: getComputedStyle(content).opacity, clipPath: clip(left, top, rect.width, rect.height, radius)},
    {opacity: 0, clipPath: clip(centerX, centerY, 0, 0, '6px')},
  ], timing);
  glassMotion.pause();
  contentMotion.pause();
  glassMotion.currentTime = contentMotion.currentTime = 0;
  const finished = new Promise((resolve) => {
    let lastTime = performance.now();
    let elapsed = 0;
    function advance(time) {
      // Camera movement can drop a frame. Keep the exit visible across several
      // rendered frames even when one map render takes longer than expected.
      elapsed = Math.min(timing.duration, elapsed + Math.min(50, Math.max(0, time - lastTime)));
      lastTime = time;
      glassMotion.currentTime = contentMotion.currentTime = elapsed;
      if (elapsed < timing.duration && dock.isConnected) requestAnimationFrame(advance);
      else resolve();
    }
    requestAnimationFrame(advance);
  }).then(() => {
    delete dock.dataset.reliefPlaced;
    delete dock.dataset.reliefClosing;
    glassMotion.cancel();
    contentMotion.cancel();
    retirements.delete(dock);
  });
  retirements.set(dock, finished);
  return finished;
}
