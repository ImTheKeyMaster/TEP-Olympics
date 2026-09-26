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
  let activatingWorker;
  let applying = false;
  let reloadRequested = false;
  let activationFallback;
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

  function finishUpdate() {
    if (reloadRequested) return;
    reloadRequested = true;
    clearTimeout(activationFallback);
    // Clear the old-version UI before navigating. This also prevents a
    // briefly restored Chrome tab from repainting a stale ready notification.
    notice.hidden = true;
    reloadPage();
  }

  function activatedWorkerControlsPage() {
    return Boolean(applying && activatingWorker && serviceWorkers.controller === activatingWorker);
  }

  function reconcileController() {
    if (activatedWorkerControlsPage() || (!applying && updateWorker && serviceWorkers.controller === updateWorker)) finishUpdate();
  }

  function activationStateChanged() {
    if (activatingWorker?.state === 'redundant') {
      applying = false;
      activatingWorker = null;
      clearTimeout(activationFallback);
      showFailure('Update installation failed. Using the current version.');
      return;
    }
    reconcileController();
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
    // Chrome tabs can miss the useful timing of this event while navigating or
    // moving between foreground/background. Confirm that the worker selected
    // by the user actually controls this page rather than reloading for an
    // unrelated controller transition.
    reconcileController();
  });

  applyButton.addEventListener('click', async () => {
    if (applying) return;
    const waitingWorker = registration?.waiting;
    if (!waitingWorker) {
      showFailure('The update is no longer ready. Checking again…');
      try {
        await registration?.update();
        if (!registration?.waiting && !registration?.installing) {
          showFailure('No update is currently available. Please try again later.');
        }
      } catch (error) {
        console.warn('Service worker update check failed:', error);
        showFailure('Unable to check for updates. Using the current version.');
      }
      return;
    }
    showInstalling();
    activatingWorker = waitingWorker;
    waitingWorker.addEventListener?.('statechange', activationStateChanged);
    try {
      waitingWorker.postMessage('SKIP_WAITING');
    } catch (error) {
      console.warn('Unable to activate the service worker update:', error);
      applying = false;
      activatingWorker = null;
      showFailure('Unable to install the update. Please try again later.');
      return;
    }
    // The state/controller may have changed synchronously before the listeners
    // above ran. A focus/visibility check below covers background Chrome tabs;
    // this short check only verifies lifecycle state and never forces a reload.
    reconcileController();
    if (!reloadRequested) activationFallback = setTimeout(reconcileController, 3000);
  });

  function observeInstalling(worker) {
    if (!worker || observedWorkers.has(worker)) return;
    observedWorkers.add(worker);
    updateWorker = worker;
    if (hadController) showDownloading({ completed: 0, total: 0, percent: 0 }, worker);
    worker.addEventListener('statechange', () => {
      // A newer updatefound event can supersede this worker. Its later
      // redundant transition must not overwrite the newer worker's UI.
      if (!hadController || worker !== updateWorker) return;
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

  documentObject.addEventListener?.('visibilitychange', () => {
    if (documentObject.visibilityState === 'visible') reconcileController();
  });
  globalThis.addEventListener?.('focus', reconcileController);
}
