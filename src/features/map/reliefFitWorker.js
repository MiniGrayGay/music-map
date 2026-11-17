// Module worker: fits one zone's relief points off the main thread.
// Input positions is a bounded per-zone copy whose buffer is transferred in;
// rings arrive as plain arrays (unwrapped from any reactive proxy).
// Shared packed/complete buffers are never detached or mutated here.
import {fitPoints} from './fitReliefPoints.js';

self.onmessage = ({data}) => {
  const {id, positions, rings = []} = data;
  try {
    const fitted = fitPoints(positions, rings);
    self.postMessage({id, ok: true, ...fitted},
      [fitted.positions.buffer, fitted.outline.buffer]);
  } catch (error) {
    self.postMessage({id, ok: false, message: error?.message ?? String(error)});
  }
};
