import {onBeforeUnmount, onMounted, watchEffect} from 'vue';

export function useMusicMediaSession(transport, context) {
  let session;
  let unwatch;
  let unwatchPosition;
  const registered = new Set();

  function bind(action, handler) {
    try {
      session.setActionHandler(action, handler);
      if (handler) registered.add(action);
      else registered.delete(action);
    } catch {
      // Browsers support different subsets of Media Session actions.
    }
  }

  onMounted(() => {
    session = navigator.mediaSession;
    if (!session) return;
    bind('play', transport.play);
    bind('pause', transport.pause);
    bind('stop', transport.pause);
    bind('seekto', (event) => transport.seek(event.seekTime));
    bind('seekbackward', (event) => transport.seek(transport.current.value - (event.seekOffset ?? 10)));
    bind('seekforward', (event) => transport.seek(transport.current.value + (event.seekOffset ?? 10)));

    unwatch = watchEffect(() => {
      const {track, title, zone, previous, next} = context();
      bind('previoustrack', previous);
      bind('nexttrack', next);
      if ('MediaMetadata' in window) {
        session.metadata = track ? new MediaMetadata({title, album: zone}) : null;
      }
      session.playbackState = !track ? 'none' : transport.playing.value ? 'playing' : 'paused';
    });
    if (session.setPositionState) {
      unwatchPosition = watchEffect(() => {
        const duration = transport.duration.value;
        const position = Math.min(duration, Math.max(0, transport.current.value));
        if (Number.isFinite(duration) && duration > 0) {
          session.setPositionState({duration, position, playbackRate: 1});
        } else {
          session.setPositionState();
        }
      });
    }
  });

  onBeforeUnmount(() => {
    if (!session) return;
    unwatch?.();
    unwatchPosition?.();
    for (const action of registered) bind(action, null);
    session.metadata = null;
    session.playbackState = 'none';
    session.setPositionState?.();
  });
}
