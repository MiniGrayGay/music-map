import {createApp} from 'vue';
import App from './App.vue';
import './styles/base.css';

if (import.meta.env.DEV && new URLSearchParams(location.search).has('player-lab')) {
  document.title = '预览';
  document.querySelector('link[rel="icon"]').href = 'data:,';
  document.body.style.background = '#4e6c70';
  void import('./components/PlayerLab.vue').then(({default: PlayerLab}) => {
    createApp(PlayerLab).mount('#app');
  });
} else {
  createApp(App).mount('#app');
}
