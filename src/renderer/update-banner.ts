import { t } from './i18n';

export function initUpdateBanner() {
  function showUpdateBanner(latestVersion: string, url: string) {
    if (document.querySelector('.update-banner')) return;
    const root = document.createElement('div');
    root.className = 'update-banner';
    const title = document.createElement('div');
    title.className = 'update-banner-text';
    const strong = document.createElement('strong');
    strong.textContent = t('update.title');
    const span = document.createElement('span');
    span.textContent = `v${latestVersion}`;
    title.append(strong, span);
    const actions = document.createElement('div');
    actions.className = 'update-banner-actions';
    const dl = document.createElement('button');
    dl.className = 'update-download';
    dl.textContent = t('update.download');
    dl.addEventListener('click', () => {
      void window.api.openExternal(url);
      root.remove();
    });
    const later = document.createElement('button');
    later.className = 'update-dismiss';
    later.textContent = t('update.dismiss');
    later.addEventListener('click', () => root.remove());
    actions.append(dl, later);
    root.append(title, actions);
    document.body.appendChild(root);
  }

  void (async () => {
    try {
      const info = await window.api.checkForUpdate();
      if (info?.updateAvailable) setTimeout(() => showUpdateBanner(info.latestVersion, info.url), 1200);
    } catch {
      /* offline / unavailable — silently skip */
    }
  })();
}
