export function registerPwaUpdate({
  navigatorObject = navigator,
  locationObject = location,
  documentObject = document,
  reloadPage = () => locationObject.reload()
} = {}) {
  const serviceWorkers = navigatorObject.serviceWorker;
  if (!serviceWorkers || (locationObject.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(locationObject.hostname))) return;

  const notice = documentObject.getElementById('updateNotice');
  const message = documentObject.getElementById('updateMessage');
  const progress = documentObject.getElementById('updateProgress');
  const applyButton = documentObject.getElementById('applyUpdate');
  const hadController = Boolean(serviceWorkers.controller);
  const failedVersions = new Set();
  let registration;
  let updateWorker;
  let applying = false;
  let reloadRequested = false;
  const observedWorkers = new WeakSet();

  function showDownloading({ completed = 0, total = 0, percent = 0 } = {}, worker) {
    if (applying) return;
    updateWorker = worker || updateWorker;
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    message.textContent = `Updating app… ${safePercent}%`;
    progress.hidden = false;
    progress.classList.remove('is-installing');
    progress.setAttribute('aria-valuenow', String(safePercent));
    progress.setAttribute('aria-valuetext', `${completed} of ${total} files cached`);
    progress.style.setProperty('--update-progress', safePercent / 100);
    applyButton.hidden = true;
    applyButton.disabled = true;
    notice.hidden = false;
  }

  function showReady(worker) {
    if (applying) return;
    updateWorker = worker;
    message.textContent = 'A new app version is ready.';
    progress.hidden = true;
    progress.classList.remove('is-installing');
    applyButton.hidden = false;
    applyButton.disabled = false;
    notice.hidden = false;
  }

  function showFailure(text = 'Update failed. Using the current version.') {
    if (applying) return;
    updateWorker = null;
    message.textContent = text;
    progress.hidden = true;
    progress.classList.remove('is-installing');
    applyButton.hidden = true;
    applyButton.disabled = true;
    notice.hidden = false;
  }

  function showInstalling() {
    applying = true;
    message.textContent = 'Installing update…';
    progress.hidden = false;
    progress.classList.add('is-installing');
    progress.removeAttribute('aria-valuenow');
    progress.setAttribute('aria-valuetext', 'Installing update');
    applyButton.hidden = true;
    applyButton.disabled = true;
    notice.hidden = false;
  }

  serviceWorkers.addEventListener('message', event => {
    const payload = event.data;
    if (!hadController || !payload || event.source === serviceWorkers.controller) return;
    const isCurrentUpdate = event.source === updateWorker || event.source === registration?.installing || event.source === registration?.waiting;
    if (!isCurrentUpdate && updateWorker) return;
    if (payload.type === 'CACHE_ERROR') {
      failedVersions.add(payload.version);
      showFailure();
    } else if (payload.type === 'CACHE_PROGRESS' && !failedVersions.has(payload.version)) {
      showDownloading(payload, event.source);
    }
  });

  serviceWorkers.addEventListener('controllerchange', () => {
    // Another open tab can activate this same update. Reload any page that was
    // already controlled when it began, while retaining the one-reload guard.
    if (!hadController || reloadRequested) return;
    reloadRequested = true;
    reloadPage();
  });

  applyButton.addEventListener('click', () => {
    if (applying) return;
    const waitingWorker = registration?.waiting;
    if (!waitingWorker) {
      showFailure('The update is no longer ready. Checking again…');
      registration?.update().catch(error => console.warn('Service worker update check failed:', error));
      return;
    }
    showInstalling();
    waitingWorker.postMessage('SKIP_WAITING');
  });

  function observeInstalling(worker) {
    if (!worker || observedWorkers.has(worker)) return;
    observedWorkers.add(worker);
    updateWorker = worker;
    if (hadController) showDownloading({ completed: 0, total: 0, percent: 0 }, worker);
    worker.addEventListener('statechange', () => {
      if (!hadController) return;
      if (worker.state === 'installed') showReady(worker);
      if (worker.state === 'redundant') showFailure();
    });
  }

  serviceWorkers.register('service-worker.js', { updateViaCache: 'none' }).then(reg => {
    registration = reg;
    if (reg.waiting && hadController) showReady(reg.waiting);
    observeInstalling(reg.installing);
    reg.addEventListener('updatefound', () => observeInstalling(reg.installing));
    reg.update().catch(error => console.warn('Service worker update check failed:', error));
  }).catch(error => console.warn('Service worker registration failed:', error));
}
